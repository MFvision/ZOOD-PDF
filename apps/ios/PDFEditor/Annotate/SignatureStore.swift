import CryptoKit
import Foundation
import Security
import UIKit

/// The signature drawn once and kept: a PNG encrypted with a key that
/// lives in the Keychain (this device only, when unlocked), in a file in
/// the app's own container. Nothing readable is on disk, and nothing
/// leaves the device.
struct SignatureStore: Sendable {
    let fileURL: URL
    let keychainAccount: String

    init(fileURL: URL? = nil, keychainAccount: String = "signature-key") {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        self.fileURL = fileURL ?? support.appending(path: "Signatures", directoryHint: .isDirectory).appending(path: "signature.bin")
        self.keychainAccount = keychainAccount
    }

    var exists: Bool { FileManager.default.fileExists(atPath: fileURL.path) }

    /// Keeps the picture, encrypted.
    func save(_ image: UIImage) throws {
        guard let png = image.pngData() else { throw CocoaError(.fileWriteUnknown) }
        let key = try keyMakingOne()
        let sealed = try AES.GCM.seal(png, using: key)
        guard let combined = sealed.combined else { throw CocoaError(.fileWriteUnknown) }
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try combined.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }

    /// The picture, or nil when none is kept or it cannot be opened.
    func load() -> UIImage? {
        guard let data = try? Data(contentsOf: fileURL), let key = try? existingKey() else { return nil }
        guard let box = try? AES.GCM.SealedBox(combined: data), let png = try? AES.GCM.open(box, using: key) else { return nil }
        return UIImage(data: png, scale: 2)
    }

    /// Forgets the picture and the key.
    func delete() {
        try? FileManager.default.removeItem(at: fileURL)
        SecItemDelete(query() as CFDictionary)
    }

    // MARK: - The key

    private func query() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "app.warraq.ios.signature",
            kSecAttrAccount as String: keychainAccount,
        ]
    }

    private func existingKey() throws -> SymmetricKey? {
        var query = query()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return SymmetricKey(data: data)
    }

    private func keyMakingOne() throws -> SymmetricKey {
        if let key = try existingKey() { return key }
        let key = SymmetricKey(size: .bits256)
        var attributes = query()
        attributes[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return key
    }
}
