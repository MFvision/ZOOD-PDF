import Foundation

// Typed Swift front for the RPC methods in packages/core/crates/warraq-core/src/methods/.
// Page indices are 0-based. Mutating methods return the whole new file (original bytes +
// appended incremental update) in `Committed.bytes`.

public struct PageInfo: Codable, Sendable, Equatable {
    public let width: Double
    public let height: Double
    public let rotation: Int
}

public struct Permissions: Codable, Sendable, Equatable {
    public var print = true
    public var modify = true
    public var copy = true
    public var annotate = true
    public var fillForms = true
    public var accessibility = true
    public var assemble = true
    public var printHighQuality = true

    public init() {}

    enum CodingKeys: String, CodingKey {
        case print, modify, copy, annotate, fillForms, accessibility, assemble, printHighQuality
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        print = try c.decodeIfPresent(Bool.self, forKey: .print) ?? true
        modify = try c.decodeIfPresent(Bool.self, forKey: .modify) ?? true
        copy = try c.decodeIfPresent(Bool.self, forKey: .copy) ?? true
        annotate = try c.decodeIfPresent(Bool.self, forKey: .annotate) ?? true
        fillForms = try c.decodeIfPresent(Bool.self, forKey: .fillForms) ?? true
        accessibility = try c.decodeIfPresent(Bool.self, forKey: .accessibility) ?? true
        assemble = try c.decodeIfPresent(Bool.self, forKey: .assemble) ?? true
        printHighQuality = try c.decodeIfPresent(Bool.self, forKey: .printHighQuality) ?? true
    }
}

public struct DocInfo: Codable, Sendable, Equatable {
    public struct Encryption: Codable, Sendable, Equatable {
        public let revision: Int?
        public let version: Int?
        public let method: String?
    }

    public let pageCount: Int
    public let pages: [PageInfo]
    public let encrypted: Bool
    public let encryption: Encryption?
    public let passwordMatched: String?
    public let permissions: Permissions
    public let version: String?
    public let revisions: Int
    public let hasSignatures: Bool
    public let title: String?
    public let author: String?
    public let byteLength: Int
    public let unsavedChanges: Bool
}

public struct CommitInfo: Codable, Sendable, Equatable {
    public let byteLength: Int
    public let pageCount: Int?
    public let revisions: Int?
    public let inserted: Int?
}

public struct Committed: Sendable {
    public let info: CommitInfo
    public let bytes: Data
}

public struct RebaseResult: Sendable {
    public enum Mode: String, Codable, Sendable {
        case incremental, unchanged, protectionChanged
    }

    public struct Info: Codable, Sendable {
        public let mode: Mode
        public let changed: [[Int]]
        public let added: [[Int]]
        public let deleted: [[Int]]
        public let byteLength: Int
    }

    public let info: Info
    public let bytes: Data
}

public struct EncryptionCheck: Codable, Sendable, Equatable {
    public let encrypted: Bool
    public let needsPassword: Bool
}

public struct MethodList: Codable, Sendable, Equatable {
    public let document: [String]
    public let `static`: [String]
}

extension WarraqEngine {
    private struct Pages: Encodable, Sendable { let pages: [Int] }
    private struct Rotate: Encodable, Sendable { let pages: [Int]; let degrees: Int }
    private struct MoveOrder: Encodable, Sendable { let order: [Int] }
    private struct MoveTo: Encodable, Sendable { let pages: [Int]; let to: Int }
    private struct InsertBlank: Encodable, Sendable {
        let at: Int
        let count: Int
        let width: Double?
        let height: Double?
    }
    private struct InsertFrom: Encodable, Sendable {
        let at: Int
        let pages: [Int]?
        let password: String?
    }
    private struct Crop: Encodable, Sendable {
        let pages: [Int]
        let box: [Double]
    }
    private struct ProtectSet: Encodable, Sendable {
        let userPassword: String
        let ownerPassword: String
        let permissions: Permissions
    }
    private struct ProtectRemove: Encodable, Sendable { let ownerPassword: String? }
    private struct Merge: Encodable, Sendable { let passwords: [String?] }
    private struct MetaSet: Encodable, Sendable {
        let info: [String: String?]
    }

    private func committed(_ r: EngineReply) throws(WarraqError) -> Committed {
        Committed(info: try r.decode(CommitInfo.self), bytes: try r.blob0())
    }

    public func info() throws(WarraqError) -> DocInfo {
        try call("doc.info").decode()
    }

    /// Append pending changes as an incremental update.
    public func save() throws(WarraqError) -> Committed {
        try committed(call("doc.save"))
    }

    /// Keep the original bytes and append only the objects a whole-file writer (PDFKit)
    /// changed. `.protectionChanged` means the edited file dropped or changed the encryption:
    /// the caller must ask the user before writing those bytes.
    public func rebase(edited: Data) throws(WarraqError) -> RebaseResult {
        let r = try call("doc.rebase", blobs: [edited])
        return RebaseResult(info: try r.decode(), bytes: try r.blob0())
    }

    public func rotate(pages: [Int], degrees: Int) throws(WarraqError) -> Committed {
        try committed(call("pages.rotate", Rotate(pages: pages, degrees: degrees)))
    }

    /// New order: `order[i]` is the old index of the page that ends up at position i.
    public func reorder(_ order: [Int]) throws(WarraqError) -> Committed {
        try committed(call("pages.move", MoveOrder(order: order)))
    }

    public func move(pages: [Int], to index: Int) throws(WarraqError) -> Committed {
        try committed(call("pages.move", MoveTo(pages: pages, to: index)))
    }

    public func delete(pages: [Int]) throws(WarraqError) -> Committed {
        try committed(call("pages.delete", Pages(pages: pages)))
    }

    /// Blank pages sized like their neighbour unless width/height are given.
    public func insertBlank(at index: Int, count: Int = 1, width: Double? = nil, height: Double? = nil) throws(WarraqError) -> Committed {
        try committed(call("pages.insertBlank", InsertBlank(at: index, count: count, width: width, height: height)))
    }

    public func insert(from pdf: Data, at index: Int, pages: [Int]? = nil, password: String? = nil) throws(WarraqError) -> Committed {
        try committed(call("pages.insertFrom", InsertFrom(at: index, pages: pages, password: password), blobs: [pdf]))
    }

    /// A new PDF with just these pages; the open document is unchanged.
    public func extract(pages: [Int]) throws(WarraqError) -> Data {
        try call("pages.extract", Pages(pages: pages)).blob0()
    }

    public func crop(pages: [Int], box: [Double]) throws(WarraqError) -> Committed {
        try committed(call("pages.crop", Crop(pages: pages, box: box)))
    }

    /// AES-256 protection (a whole rewrite by design).
    public func protect(userPassword: String, ownerPassword: String, permissions: Permissions = Permissions()) throws(WarraqError) -> Data {
        try call("protect.set", ProtectSet(userPassword: userPassword, ownerPassword: ownerPassword, permissions: permissions)).blob0()
    }

    public func removeProtection(ownerPassword: String? = nil) throws(WarraqError) -> Data {
        try call("protect.remove", ProtectRemove(ownerPassword: ownerPassword)).blob0()
    }

    public func setMetadata(_ info: [String: String?]) throws(WarraqError) -> Committed {
        try committed(call("doc.metadata.set", MetaSet(info: info)))
    }

    /// Plain text of the document when the engine offers `text.plain` (warraq-text); nil
    /// otherwise, so callers fall back to PDFKit. The reply shape is read tolerantly: a
    /// top-level `text` string, or `pages: [{ text }]`.
    public func plainText(maxCharacters: Int = 200_000) -> String? {
        guard Self.supports("text.plain") else { return nil }
        guard let r = try? call("text.plain"),
              let obj = try? JSONSerialization.jsonObject(with: r.json) as? [String: Any] else { return nil }
        var text: String?
        if let t = obj["text"] as? String {
            text = t
        } else if let pages = obj["pages"] as? [[String: Any]] {
            text = pages.compactMap { $0["text"] as? String }.joined(separator: "\n")
        }
        return text.map { String($0.prefix(maxCharacters)) }
    }

    // MARK: - Static

    public static func isEncrypted(_ pdf: Data) throws(WarraqError) -> EncryptionCheck {
        try callStatic("pdf.isEncrypted", json: nil, blobs: [pdf]).decode()
    }

    /// Combine PDFs in order into a new file.
    public static func merge(_ pdfs: [Data], passwords: [String?] = []) throws(WarraqError) -> (pageCount: Int, bytes: Data) {
        struct Out: Decodable { let pageCount: Int }
        let r = try callStatic("pdf.merge", Merge(passwords: passwords), blobs: pdfs)
        return (try r.decode(Out.self).pageCount, try r.blob0())
    }

    public static func methods() throws(WarraqError) -> MethodList {
        try callStatic("methods.list", json: nil).decode()
    }

    /// Whether this engine build registers `method` (document or static).
    public static func supports(_ method: String) -> Bool {
        MethodCache.shared.contains(method)
    }
}

/// `methods.list` is fixed for a given binary: ask once.
final class MethodCache: Sendable {
    static let shared = MethodCache()
    let names: Set<String>

    private init() {
        if let m = try? WarraqEngine.methods() {
            names = Set(m.document + m.static)
        } else {
            names = []
        }
    }

    func contains(_ name: String) -> Bool { names.contains(name) }
}
