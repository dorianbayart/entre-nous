import AppKit

/// Received files live in the user's temporary folder ($TMPDIR/entrenous, in /var/folders):
///  - each one is deleted when its item expires (like on the relay);
///  - if the app is deleted, macOS purges this folder by itself.
/// Local files offered for sending are only referenced, never copied.
final class FileStore {
    private let root = FileManager.default.temporaryDirectory.appendingPathComponent("entrenous", isDirectory: true)
    private var urls: [String: URL] = [:]
    private var handles: [String: FileHandle] = [:]
    private var timer: Timer?
    private static let defaultLifetime: Double = 24 * 3600

    init() {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
    }

    func register(_ url: URL) -> String {
        let token = UUID().uuidString
        urls[token] = url
        return token
    }

    func url(_ token: String) -> URL? { urls[token] }

    /// Folder name = expiry timestamp, so the purge needs no index. `opened`: a copy given to
    /// another app, also deleted when the app quits (and at the next launch, after a crash).
    func create(name: String, expiresAt: Double?, opened: Bool = false) throws -> String {
        let expiry = Int(expiresAt ?? (Date().timeIntervalSince1970 + Self.defaultLifetime) * 1000)
        let dir = root.appendingPathComponent("\(expiry)-\(opened ? Self.openedMark : "")\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let safe = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        let file = dir.appendingPathComponent(safe.isEmpty ? "fichier" : safe)
        FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let token = register(file)
        handles[token] = try FileHandle(forWritingTo: file)
        return token
    }

    func append(_ token: String, _ data: Data) throws {
        guard let h = handles[token] else { throw BridgeError("file not open") }
        try h.write(contentsOf: data)
    }

    func close(_ token: String) {
        try? handles.removeValue(forKey: token)?.close()
    }

    /// A folder chosen to save into: `name` created in it (or "name 2"…); its token.
    func createFolder(in parent: URL, name: String) throws -> (token: String, url: URL) {
        let base = Self.safe(name).isEmpty ? "dossier" : Self.safe(name)
        var url = parent.appendingPathComponent(base, isDirectory: true)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = parent.appendingPathComponent("\(base) \(n)", isDirectory: true)
            n += 1
        }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return (register(url), url)
    }

    /// `path` inside a folder made by createFolder, never outside it ("..", absolute paths refused).
    func resolve(folder token: String, path: String) throws -> URL {
        guard let root = urls[token] else { throw BridgeError("unknown folder") }
        let parts = path.split(separator: "/").map { Self.safe(String($0)) }
        guard !parts.isEmpty, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { throw BridgeError("bad path") }
        return parts.reduce(root) { $0.appendingPathComponent($1) }
    }

    /// A file of a folder being saved: written piece by piece like a received file.
    func createIn(folder token: String, path: String) throws -> String {
        var file = try resolve(folder: token, path: path)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        // two names that differ only by case are one file here: "a 2.txt", never overwritten
        let stem = file.deletingPathExtension().lastPathComponent
        let ext = file.pathExtension
        var n = 2
        while FileManager.default.fileExists(atPath: file.path) {
            let name = ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)"
            file = file.deletingLastPathComponent().appendingPathComponent(name)
            n += 1
        }
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let t = register(file)
        handles[t] = try FileHandle(forWritingTo: file)
        return t
    }

    func mkdir(folder token: String, path: String) throws {
        try FileManager.default.createDirectory(at: try resolve(folder: token, path: path), withIntermediateDirectories: true)
    }

    /// A name from another device, made safe for a file name here.
    static func safe(_ name: String) -> String {
        name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .components(separatedBy: .controlCharacters).joined()
            .trimmingCharacters(in: .whitespaces)
    }

    func read(_ token: String, offset: Int, length: Int) throws -> Data {
        guard let url = urls[token] else { throw BridgeError("unknown file") }
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        try h.seek(toOffset: UInt64(offset))
        return try h.read(upToCount: length) ?? Data()
    }

    func saveAs(_ token: String, name: String) {
        guard let src = urls[token] else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK, let dest = panel.url {
            try? FileManager.default.removeItem(at: dest)
            try? FileManager.default.copyItem(at: src, to: dest)
        }
    }

    func startPurging() {
        purgeOpened()
        purge()
        timer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in self?.purge() }
    }

    private static let openedMark = "ouvert-"

    /// The copies given to other apps: the app quits.
    func purgeOpened() {
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for dir in dirs where dir.lastPathComponent.contains("-\(Self.openedMark)") {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    private func purge() {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for dir in dirs {
            guard let expiry = Int(dir.lastPathComponent.split(separator: "-").first ?? ""), expiry < now else { continue }
            try? FileManager.default.removeItem(at: dir)
        }
        urls = urls.filter { FileManager.default.fileExists(atPath: $0.value.path) }
    }
}
