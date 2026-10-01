import Foundation
import WarraqCore

/// The certificate files a person imported to sign with, and the certificates
/// they trust when checking someone else's signature. Both live in the
/// Keychain (`SignatureKeychain`), this device only.
///
/// The password of a `.p12` is never kept. It is typed when the certificate is
/// opened and when it signs, and it is gone when the sheet closes — the same
/// decision the desktop makes. A kept password would turn "something you know"
/// into "something on the phone".
struct SigningIdentities: Sendable {
    /// One imported certificate file, as the list shows it. The bytes are not
    /// here: they are fetched from the Keychain only when they are needed.
    struct Entry: Codable, Sendable, Hashable, Identifiable {
        /// What the file was called, so a person recognises it.
        let name: String
        /// The Keychain account its bytes sit under.
        let id: String
        let imported: Date
    }

    /// A certificate the person trusts on this device: its name and its DER.
    ///
    /// Nothing here is secret — a certificate is public — but it is what the
    /// verifier's answer depends on, so it is kept where the Files app does not
    /// reach and where a backup does not carry it to another device.
    struct Trusted: Codable, Sendable, Equatable, Identifiable {
        let name: String
        /// The certificate itself, DER.
        let der: Data
        var id: Data { der }
    }

    let keychain: SignatureKeychain

    private static let identitiesAccount = "identities"
    private static let trustedAccount = "trusted-certificates"

    init(keychain: SignatureKeychain = SignatureKeychain()) {
        self.keychain = keychain
    }

    // MARK: - The certificate files to sign with

    /// The imported certificate files, oldest first.
    func identities() -> [Entry] {
        decode([Entry].self, keychain.read(Self.identitiesAccount)) ?? []
    }

    /// Keeps `bytes` as a certificate file called `name`, and answers its
    /// entry. The bytes go into the Keychain under an account of their own.
    @discardableResult
    func importIdentity(_ bytes: Data, name: String) throws -> Entry {
        let entry = Entry(name: name, id: "identity-\(UUID().uuidString)", imported: Date())
        try keychain.write(bytes, to: entry.id)
        var list = identities()
        list.append(entry)
        try keychain.write(try JSONEncoder().encode(list), to: Self.identitiesAccount)
        return entry
    }

    /// The bytes of an imported certificate file, or nil when it is gone.
    func bytes(of entry: Entry) -> Data? {
        keychain.read(entry.id)
    }

    /// Forgets a certificate file and its bytes.
    func forgetIdentity(_ entry: Entry) throws {
        keychain.delete(entry.id)
        let list = identities().filter { $0.id != entry.id }
        try keychain.write(try JSONEncoder().encode(list), to: Self.identitiesAccount)
    }

    // MARK: - The certificates the person trusts

    /// The trusted certificates. An unreadable store answers none: nothing is
    /// trusted by accident.
    func trusted() -> [Trusted] {
        decode([Trusted].self, keychain.read(Self.trustedAccount)) ?? []
    }

    /// Adds `certificates`, skipping any already trusted (compared by DER).
    /// Answers how many were new.
    @discardableResult
    func trust(_ certificates: [Trusted]) throws -> Int {
        var list = trusted()
        var added = 0
        for certificate in certificates where !list.contains(where: { $0.der == certificate.der }) {
            list.append(certificate)
            added += 1
        }
        try keychain.write(try JSONEncoder().encode(list), to: Self.trustedAccount)
        return added
    }

    /// Stops trusting the certificate with these bytes.
    func forgetTrusted(_ der: Data) throws {
        let list = trusted().filter { $0.der != der }
        try keychain.write(try JSONEncoder().encode(list), to: Self.trustedAccount)
    }

    /// The certificates in a file the person chose — DER, PEM or PKCS#7 — as
    /// the core reads them. An empty answer means the file held none.
    static func certificates(in file: Data) async throws -> [Trusted] {
        struct Found: Decodable {
            struct Certificate: Decodable { let name: String }
            let certificates: [Certificate]
        }
        let reply = try await Core.callStatic(op: "signatures.certificates", blobs: [file])
        let found = try reply.decode(Found.self)
        return zip(found.certificates, reply.blobs).map { Trusted(name: $0.name, der: $1) }
    }

    /// Everything this device keeps for signing, forgotten.
    func deleteEverything() {
        for entry in identities() { keychain.delete(entry.id) }
        keychain.delete(Self.identitiesAccount)
        keychain.delete(Self.trustedAccount)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data?) -> T? {
        guard let data else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}
