import Foundation
import Security

/// Device identity, groups, prekeys and preferences, all in ONE generic password item (a JSON
/// object of key → value), readable only on this Mac and only once the session is unlocked.
/// One item: when macOS asks whether the app may read the Keychain (new signature), it asks once.
final class Keychain {
    let service: String
    private static let account = "store"
    private var cache: [String: String]?
    /// Access refused in the system dialog: not asked again before the page loads again
    /// (one refusal, one dialog). Unreadable, nothing is read nor written, so nothing is lost.
    private var refusal: BridgeError?

    init(service: String) {
        self.service = service
    }

    /// Unreadable (refused, session locked), it throws: an empty store would look like a
    /// first launch, and the page would make a new identity.
    func get(_ key: String) throws -> String? {
        try load()[key]
    }

    func set(_ key: String, _ value: String) throws {
        var entries = try load()
        entries[key] = value
        try save(entries)
    }

    func delete(_ key: String) {
        guard var entries = try? load(), entries.removeValue(forKey: key) != nil else { return }
        try? save(entries)
    }

    /// The page loads again (Reload, its Retry button): a refusal is asked again.
    func retry() {
        refusal = nil
    }

    // ------------------------------------------------------------------ storage

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private func read(_ account: String) -> (Data?, OSStatus) {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        return (out as? Data, status)
    }

    private func load() throws -> [String: String] {
        if let cache { return cache }
        if let refusal { throw refusal }
        let (data, status) = read(Keychain.account)
        var entries: [String: String]
        if status == errSecItemNotFound {
            guard let migrated = migrateLegacy() else { throw failure(remembered: true) }
            entries = migrated
        } else if status == errSecSuccess, let data,
                  let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            entries = dict
        } else {
            // refused in the dialog (or unreadable content): remembered; locked session or any
            // other error: tried again at the next access, which shows no dialog
            throw failure(remembered: status == errSecAuthFailed || status == errSecUserCanceled || status == errSecSuccess)
        }
        cache = entries
        return entries
    }

    private func failure(remembered: Bool) -> BridgeError {
        let error = BridgeError(L10n.t("keychain"))
        if remembered { refusal = error }
        return error
    }

    private func save(_ entries: [String: String]) throws {
        let data = try JSONSerialization.data(withJSONObject: entries, options: [.sortedKeys])
        let status = SecItemUpdate(query(Keychain.account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var q = query(Keychain.account)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let added = SecItemAdd(q as CFDictionary, nil)
            guard added == errSecSuccess else { throw BridgeError("keychain \(added)") }
        } else if status != errSecSuccess {
            throw BridgeError("keychain \(status)")
        }
        cache = entries
    }

    /// Earlier versions kept one item per key: gathered into the single item, then removed.
    /// nil when one of them cannot be read (access refused): then nothing is changed.
    private func migrateLegacy() -> [String: String]? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecReturnAttributes as String: true,
                                kSecMatchLimit as String: kSecMatchLimitAll]
        var out: AnyObject?
        let found = SecItemCopyMatching(q as CFDictionary, &out)
        if found == errSecItemNotFound { return [:] }
        guard found == errSecSuccess, let items = out as? [[String: Any]] else { return nil }
        let accounts = items.compactMap { $0[kSecAttrAccount as String] as? String }.filter { $0 != Keychain.account }
        var entries: [String: String] = [:]
        for account in accounts {
            let (data, status) = read(account)
            guard status == errSecSuccess, let data, let value = String(data: data, encoding: .utf8) else { return nil }
            entries[account] = value
        }
        if entries.isEmpty { return entries }
        guard (try? save(entries)) != nil else { return nil }
        for account in entries.keys { SecItemDelete(query(account) as CFDictionary) }
        return entries
    }
}
