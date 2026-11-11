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

    /// Folder name = expiry timestamp, so the purge needs no index.
    func create(name: String, expiresAt: Double?) throws -> String {
        let expiry = Int(expiresAt ?? (Date().timeIntervalSince1970 + Self.defaultLifetime) * 1000)
        let dir = root.appendingPathComponent("\(expiry)-\(UUID().uuidString)", isDirectory: true)
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
        purge()
        timer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in self?.purge() }
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
