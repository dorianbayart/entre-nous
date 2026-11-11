import AppKit
import UniformTypeIdentifiers
import UserNotifications
import WebKit

/// Hosts the web UI (bundled, never downloaded: the code that holds the keys does not come
/// from the server) and answers its native calls: Keychain, pasteboard, files.
final class WebBridge: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    private let pasteboard = PasteboardWatcher()
    private let files = FileStore()
    private let keychain = Keychain(service: "dev.0xdba.entrenous")
    /// Pause state, set by the web UI (which keeps it in its preferences).
    private(set) var paused = false
    private var awakeActivity: NSObjectProtocol?
    var onPausedChange: ((Bool) -> Void)?
    /// Is the window (popover) on screen? Notifications are only shown when it is not.
    var isVisible: () -> Bool = { false }
    /// A system panel (file picker) opens or closes: the popover must stay open meanwhile.
    var onModal: ((Bool) -> Void)?

    static var relayURL: String {
        UserDefaults.standard.string(forKey: "relay") ?? "https://entrenous.0xdba.dev"
    }

    override init() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "entrenous")
        config.websiteDataStore = .nonPersistent() // nothing stored by WebKit: the Keychain holds it all
        let controller = WKUserContentController()
        let settings: [String: Any] = ["relay": WebBridge.relayURL, "name": Host.current().localizedName ?? "Mac"]
        let json = String(data: try! JSONSerialization.data(withJSONObject: settings), encoding: .utf8)!
        controller.addUserScript(WKUserScript(
            source: "window.__entrenous = { config: \(json), event() {} };",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        config.userContentController = controller
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 640), configuration: config)
        super.init()
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        #if DEBUG
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        #endif

        pasteboard.onCopy = { [weak self] payload in self?.emit("localCopy", payload) }
        pasteboard.fileToken = { [weak self] url in self?.files.register(url) ?? "" }
        pasteboard.start()
        files.startPurging()

        // After a sleep, the relay connections may be dead without knowing it: check them.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.emit("wake", [:]) }
    }

    func load() {
        webView.load(URLRequest(url: URL(string: "entrenous://app/index.html")!))
    }

    /// Files (or an image, a text) dropped on the menu bar icon: sent at once, whatever
    /// the pause or the automatic sharing limit.
    func drop(from pb: NSPasteboard) -> Bool {
        let items = PasteboardWatcher.contents(of: pb) { [weak self] in self?.files.register($0) ?? "" }
        guard !items.isEmpty else { return false }
        emit("drop", ["items": items])
        return true
    }

    /// Pause toggled from the menu bar item: the web UI decides and calls back setPaused.
    func requestPause(_ paused: Bool) {
        emit("pause", ["paused": paused])
    }

    /// Native -> JS event.
    private func emit(_ name: String, _ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__entrenous && window.__entrenous.event('\(name)', \(json))")
    }

    // MARK: JS -> native

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            replyHandler(nil, "bad message")
            return
        }
        do {
            replyHandler(try handle(cmd, body), nil)
        } catch {
            replyHandler(nil, error.localizedDescription)
        }
    }

    private func handle(_ cmd: String, _ a: [String: Any]) throws -> Any? {
        switch cmd {
        case "kvGet":
            return keychain.get(a["key"] as! String) ?? NSNull()
        case "kvSet":
            try keychain.set(a["key"] as! String, a["value"] as! String)
            return true
        case "kvDel":
            keychain.delete(a["key"] as! String)
            return true

        case "clipWrite":
            switch a["kind"] as? String {
            case "text":
                pasteboard.write(text: a["text"] as? String ?? "")
            case "image":
                guard let data = Data(base64URL: a["data"] as? String ?? "") else { throw BridgeError("bad image") }
                pasteboard.write(image: data, mime: a["mime"] as? String ?? "image/png")
            case "file":
                guard let url = files.url(a["token"] as? String ?? "") else { throw BridgeError("unknown file") }
                pasteboard.write(file: url)
            default:
                throw BridgeError("bad kind")
            }
            return true

        case "notify":
            notify(title: a["title"] as? String ?? "Entre Nous", body: a["body"] as? String ?? "")
            return true

        case "keepAwake":
            // during a transfer: no idle sleep (the display may still turn off)
            if a["on"] as? Bool ?? false {
                if awakeActivity == nil {
                    awakeActivity = ProcessInfo.processInfo.beginActivity(
                        options: [.idleSystemSleepDisabled, .userInitiated], reason: "Transfert Entre Nous en cours")
                }
            } else if let activity = awakeActivity {
                ProcessInfo.processInfo.endActivity(activity)
                awakeActivity = nil
            }
            return true

        case "setPaused":
            paused = a["paused"] as? Bool ?? false
            pasteboard.paused = paused
            onPausedChange?(paused)
            return true

        case "fileCreate":
            return try files.create(name: a["name"] as? String ?? "fichier", expiresAt: a["expiresAt"] as? Double)
        case "fileAppend":
            guard let data = Data(base64URL: a["data"] as? String ?? "") else { throw BridgeError("bad data") }
            try files.append(a["token"] as! String, data)
            return true
        case "fileClose":
            files.close(a["token"] as! String)
            return true
        case "fileRead":
            let data = try files.read(a["token"] as! String, offset: a["offset"] as! Int, length: a["length"] as! Int)
            return data.base64URLEncoded()
        case "fileSaveAs":
            files.saveAs(a["token"] as! String, name: a["name"] as? String ?? "fichier")
            return true
        default:
            throw BridgeError("unknown command \(cmd)")
        }
    }

    /// Notification without the content itself (the Notification Center keeps a history).
    private func notify(title: String, body: String) {
        guard !isVisible() else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    // MARK: file picker (<input type="file">): WKWebView leaves it to the app on macOS

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        onModal?(true)
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { [weak self] response in
            completionHandler(response == .OK ? panel.urls : nil)
            self?.onModal?(false)
        }
    }

    // MARK: navigation: external links open in the browser

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = action.request.url, url.scheme != "entrenous", url.scheme != "about", url.scheme != "blob" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

struct BridgeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Serves the web UI from the app bundle (Resources/web) under entrenous://app/.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.resourceURL!.appendingPathComponent("web")

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
        if path.contains("..") { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst()))
        guard let data = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": mime,
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src wss: ws: https: http://127.0.0.1:*; object-src 'none'; base-uri 'none'",
        ])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

extension Data {
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        self.init(base64Encoded: b)
    }

    func base64URLEncoded() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
