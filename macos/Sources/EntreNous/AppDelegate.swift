import AppKit
import UserNotifications
import WebKit

/// Menu bar icon + popover hosting the shared web UI. The web view lives as long as the
/// app: it keeps the relay connections and receives clipboard events even when closed.
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate, UNUserNotificationCenterDelegate,
    NSWindowDelegate, NSDraggingDestination {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private var bridge: WebBridge!
    private var activity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The app works in the background (clipboard, relay): no App Nap.
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep],
            reason: "Synchronisation du presse-papier"
        )

        installEditMenu()
        bridge = WebBridge()
        let controller = NSViewController()
        controller.view = bridge.webView
        controller.preferredContentSize = NSSize(width: 400, height: 640)
        popover.contentViewController = controller
        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.action = #selector(onClick(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        updateIcon(paused: false)
        // drop on the icon = send: the status item's window hands the drag to its delegate
        statusItem.button?.window?.registerForDraggedTypes([.fileURL, .png, .tiff, .string])
        statusItem.button?.window?.delegate = self
        bridge.onPausedChange = { [weak self] paused in self?.updateIcon(paused: paused) }
        bridge.isVisible = { [weak self] in self?.popover.isShown ?? false }
        bridge.onModal = { [weak self] active in self?.popover.behavior = active ? .applicationDefined : .transient }
        UNUserNotificationCenter.current().delegate = self
        bridge.load()
    }

    /// A menu bar app has no menu, yet Cmd+A/C/V/X/Z in the web view go through the Edit menu
    /// (key equivalents): an invisible main menu brings them back.
    private func installEditMenu() {
        let edit = NSMenu(title: "Édition")
        edit.addItem(withTitle: "Annuler", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Rétablir", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Couper", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copier", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Coller", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Tout sélectionner", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem(title: "Édition", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        let main = NSMenu()
        main.addItem(NSMenuItem(title: "Entre Nous", action: nil, keyEquivalent: ""))
        main.addItem(editItem)
        NSApp.mainMenu = main
    }

    private func updateIcon(paused: Bool) {
        let name = paused ? "pause.circle" : "doc.on.clipboard"
        let image = NSImage(systemSymbolName: name, accessibilityDescription: paused ? "Entre Nous (en pause)" : "Entre Nous")
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.toolTip = paused ? "Entre Nous : en pause" : "Entre Nous"
    }

    @objc private func onClick(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu()
        } else {
            toggle()
        }
    }

    private func toggle() {
        if popover.isShown {
            popover.performClose(nil)
        } else if let button = statusItem.button {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Ouvrir Entre Nous", action: #selector(openPopover), keyEquivalent: "").target = self
        menu.addItem(
            withTitle: bridge.paused ? "Reprendre le partage" : "Mettre en pause",
            action: #selector(togglePause),
            keyEquivalent: "p"
        ).target = self
        menu.addItem(withTitle: "Recharger", action: #selector(reload), keyEquivalent: "r").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quitter", action: #selector(quit), keyEquivalent: "q").target = self
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    // Notifications: shown even while the app is active; a click opens the window.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        DispatchQueue.main.async { self.openPopover() }
        completionHandler()
    }

    @objc private func openPopover() {
        if !popover.isShown { toggle() }
    }

    @objc private func togglePause() {
        bridge.requestPause(!bridge.paused)
    }

    // MARK: drop on the menu bar icon

    func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        statusItem.button?.highlight(true)
        return .copy
    }

    func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        .copy
    }

    func draggingExited(_ sender: NSDraggingInfo?) {
        statusItem.button?.highlight(false)
    }

    func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        statusItem.button?.highlight(false)
        guard bridge.drop(from: sender.draggingPasteboard) else { return false }
        // the window shows the upload and its progress
        DispatchQueue.main.async { self.openPopover() }
        return true
    }

    @objc private func reload() {
        bridge.load()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
