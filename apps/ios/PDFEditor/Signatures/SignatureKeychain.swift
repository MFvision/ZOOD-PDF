import Foundation
import Security

/// One named secret in the Keychain, for the two things signing keeps on the
/// device: the certificate files a person imported, and the certificates they
/// trust.
///
/// The Keychain and not a file: the app's Documents folder is shown in the
/// Files app, so a `.p12` written there would be a private key anyone with the
/// phone in their hand could copy out. Keychain items are `…ThisDeviceOnly`,
/// so they are not carried to another device by a backup either.
struct SignatureKeychain: Sendable {
    /// Which Keychain service the items sit under. Tests pass one of their own
    /// so they never touch what the person has.
    let service: String

    init(service: String = "app.warraq.ios.signing") {
        self.service = service
    }

    /// The data kept under `account`, or nil when nothing is.
    func read(_ account: String) -> Data? {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    /// Keeps `data` under `account`, replacing whatever was there.
    func write(_ data: Data, to account: String) throws {
        SecItemDelete(query(account) as CFDictionary)
        var attributes = query(account)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    /// Forgets what is under `account`.
    func delete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }

    private func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
