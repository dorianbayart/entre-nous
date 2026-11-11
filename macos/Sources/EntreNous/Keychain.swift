import Foundation
import Security

/// Device identity, groups, prekeys and preferences, all in ONE generic password item (a JSON
/// object of key → value), readable only on this Mac and only once the session is unlocked.
/// One item: when macOS asks whether the app may read the Keychain (new signature), it asks once.
final class Keychain {
    let service: String
    private static let account = "store"
    private var cache: [String: String]?
    /// Access refused (or Keychain locked): nothing is written, so nothing is lost.
    private var unreadable = false

    init(service: String) {
        self.service = service
    }

    func get(_ key: String) -> String? {
        load()[key]
    }

    func set(_ key: String, _ value: String) throws {
        var entries = load()
        if unreadable { throw BridgeError("Trousseau inaccessible") }
        entries[key] = value
        try save(entries)
    }

    func delete(_ key: String) {
        var entries = load()
        guard !unreadable, entries.removeValue(forKey: key) != nil else { return }
        try? save(entries)
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

    private func load() -> [String: String] {
        if let cache { return cache }
        let (data, status) = read(Keychain.account)
        var entries: [String: String]
        if status == errSecItemNotFound {
            guard let migrated = migrateLegacy() else { return refused() }
            entries = migrated
        } else if status == errSecSuccess, let data,
                  let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            entries = dict
        } else {
            return refused()
        }
        cache = entries
        return entries
    }

    /// Not asked again until the next launch: one refusal, one dialog.
    private func refused() -> [String: String] {
        unreadable = true
        cache = [:]
        return [:]
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
