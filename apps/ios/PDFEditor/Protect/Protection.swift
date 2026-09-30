import Foundation
import WarraqCore

/// What protects a document, and the three operations that change it — all of
/// them the core's (`protect.inspect`, `protect.set`, `protect.remove`,
/// `packages/core/API.md`).
///
/// The core writes the standard security handler at revision 6: AES-256, with
/// the password taken as UTF-8. That is why this no longer goes through
/// PDFKit, which writes RC4 with a Latin-1 password — weak, and unable to
/// carry an Arabic password at all (the bytes outside Latin-1 are dropped, so
/// the password that opens the file is not the one the person typed).
///
/// Protection is the one change that cannot be appended to the file's own
/// bytes: it covers every object already in the file. So the core answers the
/// document written whole and `DocumentModel.replace` takes it; the file on
/// disk is untouched until the person saves, as with every other tool.
enum Protect {
    /// What a reader may do without the owner password. The same three choices
    /// the desktop offers, so a document protected here says the same thing
    /// there.
    struct Permissions: Codable, Sendable, Equatable {
        var print = true
        var copy = true
        var change = true

        static let all = Permissions()

        enum CodingKeys: String, CodingKey { case print, copy, change }

        init(print: Bool = true, copy: Bool = true, change: Bool = true) {
            self.print = print
            self.copy = copy
            self.change = change
        }

        /// Read leniently: Swift's synthesized decoder throws on a key that is
        /// absent even when the property has a default, and a permission the
        /// core did not mention is simply one it did not grant.
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(print: c.value(.print, false), copy: c.value(.copy, false), change: c.value(.change, false))
        }
    }

    /// How a file is protected, read from its `/Encrypt` dictionary — which is
    /// in the clear, so this answers even for a file we have no password for.
    struct Status: Decodable, Sendable, Equatable {
        var protected = false
        /// `"aes-256"`, `"aes-128"`, `"rc4-128"`, `"rc4-40"` or `"none"`.
        var method: String?
        var keyBits: Int?
        var permissions: Permissions?
        /// Protected, and yet it opens for everyone: it carries only an owner
        /// password, to state the permissions.
        var opensWithoutPassword = false

        enum CodingKeys: String, CodingKey { case protected, method, keyBits, permissions, opensWithoutPassword }

        init(
            protected: Bool = false,
            method: String? = nil,
            keyBits: Int? = nil,
            permissions: Permissions? = nil,
            opensWithoutPassword: Bool = false
        ) {
            self.protected = protected
            self.method = method
            self.keyBits = keyBits
            self.permissions = permissions
            self.opensWithoutPassword = opensWithoutPassword
        }

        /// Read leniently: an unprotected file's answer carries `protected`
        /// and nothing else, and that must not read as a failure.
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                protected: c.value(.protected, false),
                method: c.maybe(String.self, .method),
                keyBits: c.maybe(Int.self, .keyBits),
                permissions: c.maybe(Permissions.self, .permissions),
                opensWithoutPassword: c.value(.opensWithoutPassword, false)
            )
        }

        /// A protection worth replacing: RC4 at any length, and AES-128, are
        /// what other programs wrote and what this app used to write.
        var isWeak: Bool {
            guard let method else { return false }
            return method.hasPrefix("rc4") || method == "aes-128"
        }

        /// The method as a person reads it, for the status line.
        var methodName: String {
            switch method {
            case "aes-256": "AES-256"
            case "aes-128": "AES-128"
            case "rc4-128": "RC4 128-bit"
            case "rc4-40": "RC4 40-bit"
            default: method ?? ""
            }
        }
    }

    /// The most a password may be. Revisions 5 and 6 of the handler hold 127
    /// *bytes*; the core refuses anything longer rather than cutting it, since
    /// a cut password would open the file for a string nobody typed. Arabic
    /// runs at two bytes a letter, so this is 63 Arabic letters — more than
    /// anyone types, and far more than the 32 Latin-only characters PDFKit
    /// allowed.
    static let maxPasswordBytes = 127

    /// Whether we can write `password` as it stands.
    static func isUsable(_ password: String) -> Bool {
        !password.isEmpty && password.utf8.count <= maxPasswordBytes
    }

    /// How `bytes` is protected. Never throws for a file it cannot make sense
    /// of: an unreadable file is simply not protected as far as this can tell,
    /// and every other operation will say so in its own words.
    static func status(of bytes: Data) async -> Status {
        struct Args: Encodable { let password: String? }
        do {
            let reply = try await Core.callStatic(op: "protect.inspect", args: Args(password: nil), blobs: [bytes])
            return try reply.decode(Status.self)
        } catch {
            return Status()
        }
    }

    /// `password` asked for from now on, with `permissions` for anyone who has
    /// it. Replaces whatever protected the document before, so this is both
    /// "set a password" and "change the password".
    ///
    /// No owner password is sent: the core draws one at random and drops it,
    /// so nobody — not even this app — can lift the permissions afterwards. An
    /// empty owner password would let any reader lift them.
    /// On the main actor because the open document is; the work itself is the
    /// core's, in a task of its own.
    @MainActor
    static func setPassword(
        _ password: String,
        permissions: Permissions = .all,
        on model: DocumentModel,
        undoManager: UndoManager?
    ) async throws {
        guard isUsable(password) else {
            throw CoreError.edit("the password is empty or longer than \(maxPasswordBytes) bytes")
        }
        struct Args: Encodable {
            let password: String?
            let openPassword: String
            let permissions: Permissions
        }
        let reply = try await Core.callStatic(
            op: "protect.set",
            args: Args(password: model.password, openPassword: password, permissions: permissions),
            blobs: [model.bytes]
        )
        guard let bytes = reply.blobs.first else {
            throw CoreError.badReply("protect.set answered no file")
        }
        // The core checks its own work before answering — the password must be
        // needed and must open the file — so by here it is protected.
        try await model.replace(bytes: bytes, password: password, undoManager: undoManager)
    }

    /// The protection off: the document written whole, in the clear.
    @MainActor
    static func removePassword(from model: DocumentModel, undoManager: UndoManager?) async throws {
        struct Args: Encodable { let password: String? }
        let reply = try await Core.callStatic(
            op: "protect.remove",
            args: Args(password: model.password),
            blobs: [model.bytes]
        )
        guard let bytes = reply.blobs.first else {
            throw CoreError.badReply("protect.remove answered no file")
        }
        try await model.replace(bytes: bytes, password: nil, undoManager: undoManager)
    }
}
