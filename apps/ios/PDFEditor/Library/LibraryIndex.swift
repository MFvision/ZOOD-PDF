import Foundation
import SwiftUI
import WarraqCore

/// What a document is to the index: the kinds the core knows.
enum LibraryKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case pdf, scan, image, word, excel, powerpoint, html, text, markdown

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .pdf: "PDF"
        case .scan: "Scan"
        case .image: "Picture"
        case .word: "Word"
        case .excel: "Excel"
        case .powerpoint: "PowerPoint"
        case .html: "Web page"
        case .text: "Text"
        case .markdown: "Markdown"
        }
    }

    /// The title as text, for interpolating into another line.
    var text: Text { Text(title) }

    var symbol: String {
        switch self {
        case .pdf: "doc.richtext"
        case .scan: "doc.viewfinder"
        case .image: "photo"
        case .word: "doc.text"
        case .excel: "tablecells"
        case .powerpoint: "rectangle.on.rectangle"
        case .html: "globe"
        case .text, .markdown: "doc.plaintext"
        }
    }

    /// The kinds this app can read into the index.
    static let readable: [LibraryKind] = [.pdf, .scan, .image]
}

/// One line that matched, as the core answers it: the page (from one), the
/// line's text and the byte ranges inside it that answered the query.
struct SearchHit: Decodable, Identifiable, Hashable, Sendable {
    let key: String
    let name: String
    let page: Int
    let line: Int
    let text: String
    let spans: [[Int]]
    let score: Double
    let date: String?
    let kind: LibraryKind
    let tags: [String]

    var id: String { "\(key)#\(page)#\(line)" }

    /// The matched line with its matches marked, the byte spans turned into
    /// character ranges the way the desktop's snippet does.
    var marked: AttributedString {
        var result = AttributedString(text)
        let utf8 = text.utf8
        let characters = result.characters
        for span in spans where span.count == 2 {
            let start = span[0]
            let length = span[1]
            guard start >= 0, length > 0, start + length <= utf8.count else { continue }
            // Byte offsets to character offsets, then into the attributed string.
            let from = utf8.index(utf8.startIndex, offsetBy: start)
            let to = utf8.index(from, offsetBy: length)
            guard let fromIndex = String.Index(from, within: text), let toIndex = String.Index(to, within: text) else { continue }
            let lowerOffset = text.distance(from: text.startIndex, to: fromIndex)
            let upperOffset = text.distance(from: text.startIndex, to: toIndex)
            guard lowerOffset < upperOffset, upperOffset <= characters.count else { continue }
            let lower = characters.index(characters.startIndex, offsetBy: lowerOffset)
            let upper = characters.index(characters.startIndex, offsetBy: upperOffset)
            result[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
            result[lower..<upper].backgroundColor = .yellow.opacity(0.35)
        }
        return result
    }
}

struct SearchResult: Decodable, Sendable {
    let total: Int
    let hits: [SearchHit]

    static let empty = SearchResult(total: 0, hits: [])
}

/// What narrows a search: some kinds, some folders (key prefixes), some
/// tags, a date range of the documents' own dates, or scans only.
struct SearchFilters: Encodable, Hashable, Sendable {
    var kinds: [LibraryKind]?
    var folders: [String]?
    var tags: [String]?
    var from: String?
    var to: String?
    var scannedOnly: Bool?

    var isEmpty: Bool {
        (kinds?.isEmpty ?? true) && (folders?.isEmpty ?? true) && (tags?.isEmpty ?? true)
            && from == nil && to == nil && scannedOnly != true
    }

    static let none = SearchFilters()
}

/// A document as the index knows it.
struct IndexedDocument: Decodable, Identifiable, Hashable, Sendable {
    let key: String
    let name: String
    let kind: LibraryKind
    let pages: Int
    let chars: Int
    let date: String?
    let tags: [String]
    let indexed: Int
    let modified: Int
    let bytes: Int?
    let path: String?

    var id: String { key }
}

/// A rule the core keeps with the index: a tag and the words that call for it.
struct TagRule: Codable, Identifiable, Hashable, Sendable {
    var tag: String
    var words: [String]
    var all: Bool?
    var enabled: Bool?
    var scope: String?
    var kinds: [LibraryKind]?

    var id: String { tag + "|" + words.joined(separator: ",") }
}

struct LibraryStats: Decodable, Sendable {
    let documents: Int
    let pages: Int
    let words: Int
    let bytes: Int
    let kinds: [String: Int]
    let tags: [String: Int]

    static let empty = LibraryStats(documents: 0, pages: 0, words: 0, bytes: 0, kinds: [:], tags: [:])
}

/// What `library.add` answered.
struct AddOutcome: Decodable, Sendable {
    let added: Bool
    let skipped: String?
    let pages: Int?
    let chars: Int?
    let date: String?
    let guessedKind: LibraryKind?
    let truncated: Bool?
}

/// A page's text handed to the index (pages count from one).
struct PageText: Encodable, Sendable {
    let page: Int
    let text: String
}

/// The Library's index: the core's `library.*` operations over one index
/// held behind a handle, read from and written to `fileURL` — a file in the
/// app's own container that holds text out of the person's documents and
/// nothing else. An actor, so adds and searches take their turn.
actor LibraryIndex {
    let fileURL: URL
    private var handle: Int?
    private(set) var documents = 0
    private(set) var words = 0

    private init(fileURL: URL, handle: Int, documents: Int, words: Int) {
        self.fileURL = fileURL
        self.handle = handle
        self.documents = documents
        self.words = words
    }

    /// Opens the index at `url`, or a new, empty one when there is none. An
    /// index file that cannot be read (`E_INDEX`) is set aside and a new one
    /// started: the index is a cache of the documents, never the documents.
    static func open(at url: URL) async throws -> LibraryIndex {
        struct Opened: Decodable { let handle: Int; let documents: Int; let words: Int }
        let bytes = (try? Data(contentsOf: url)) ?? Data()
        do {
            let opened: Opened = try await Core.callStatic(op: "library.open", args: "{}", blobs: bytes.isEmpty ? [] : [bytes]).decode()
            return LibraryIndex(fileURL: url, handle: opened.handle, documents: opened.documents, words: opened.words)
        } catch CoreError.index {
            try? FileManager.default.moveItem(at: url, to: url.appendingPathExtension("damaged"))
            let opened: Opened = try await Core.callStatic(op: "library.open", args: "{}").decode()
            return LibraryIndex(fileURL: url, handle: opened.handle, documents: opened.documents, words: opened.words)
        }
    }

    var isOpen: Bool { handle != nil }

    private func requireHandle() throws -> Int {
        guard let handle else { throw CoreError.closed }
        return handle
    }

    /// Encodes the arguments here, before anything crosses into the core's
    /// task: a String is sendable, whatever `A` is.
    private func call<A: Encodable, R: Decodable>(_ op: String, _ args: A, blobs: [Data] = []) async throws -> R {
        let json = String(decoding: try JSONEncoder().encode(args), as: UTF8.self)
        return try await Core.callStatic(op: op, args: json, blobs: blobs).decode()
    }

    // MARK: - Adding and forgetting

    struct AddRequest: Encodable {
        let handle: Int
        let key: String
        let name: String
        let kind: LibraryKind?
        let modified: Int
        let bytes: Int
        let pages: Int?
        let now: Int
        let text: [PageText]?
    }

    /// Puts a document's text into the index under `key` (the file's bytes
    /// never go in). `modified` and `bytes` are how a later run tells an
    /// unchanged file from a changed one.
    func add(key: String, name: String, kind: LibraryKind?, modified: Int, bytes: Int, pages: Int?, text: [PageText]) async throws -> AddOutcome {
        let request = AddRequest(handle: try requireHandle(), key: key, name: name, kind: kind, modified: modified, bytes: bytes,
                                 pages: pages, now: Int(Date.now.timeIntervalSince1970 * 1000), text: text)
        let outcome: AddOutcome = try await call("library.add", request)
        if outcome.added {
            documents = try await stats().documents
        }
        return outcome
    }

    /// The file's bytes handed to the core's own reader (a PDF with text).
    func add(key: String, name: String, modified: Int, bytes: Data, kind: LibraryKind? = nil) async throws -> AddOutcome {
        let request = AddRequest(handle: try requireHandle(), key: key, name: name, kind: kind, modified: modified, bytes: bytes.count,
                                 pages: nil, now: Int(Date.now.timeIntervalSince1970 * 1000), text: nil)
        let outcome: AddOutcome = try await call("library.add", request, blobs: [bytes])
        if outcome.added {
            documents = try await stats().documents
        }
        return outcome
    }

    func forget(keys: [String]) async throws {
        struct Args: Encodable { let handle: Int; let keys: [String] }
        struct Answer: Decodable { let documents: Int }
        let answer: Answer = try await call("library.forget", Args(handle: try requireHandle(), keys: keys))
        documents = answer.documents
    }

    // MARK: - Reading

    func search(_ query: String, limit: Int = 100, offset: Int = 0, filters: SearchFilters = .none) async throws -> SearchResult {
        struct Args: Encodable { let handle: Int; let query: String; let limit: Int; let offset: Int; let filters: SearchFilters? }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .empty }
        return try await call("library.search", Args(handle: try requireHandle(), query: trimmed, limit: limit, offset: offset,
                                                     filters: filters.isEmpty ? nil : filters))
    }

    /// The document under `key`, or nil when the index does not hold it.
    func document(key: String) async throws -> IndexedDocument? {
        struct Args: Encodable { let handle: Int; let key: String }
        do {
            return try await call("library.document", Args(handle: try requireHandle(), key: key))
        } catch CoreError.arguments {
            return nil
        } catch CoreError.index {
            return nil
        }
    }

    func stats() async throws -> LibraryStats {
        struct Args: Encodable { let handle: Int }
        return try await call("library.stats", Args(handle: try requireHandle()))
    }

    // MARK: - Tags and rules

    @discardableResult
    func tag(key: String, add: [String] = [], remove: [String] = []) async throws -> [String] {
        struct Args: Encodable { let handle: Int; let key: String; let add: [String]; let remove: [String] }
        struct Answer: Decodable { let tags: [String] }
        let answer: Answer = try await call("library.tag", Args(handle: try requireHandle(), key: key, add: add, remove: remove))
        return answer.tags
    }

    struct RulesAnswer: Decodable, Sendable {
        let rules: [TagRule]
        let tagged: Int
    }

    /// Reads the rules; with `set` replaces them; with `apply` runs them
    /// over everything indexed.
    func rules(set: [TagRule]? = nil, apply: Bool = false) async throws -> RulesAnswer {
        struct Args: Encodable { let handle: Int; let set: [TagRule]?; let apply: Bool }
        return try await call("library.rules", Args(handle: try requireHandle(), set: set, apply: apply))
    }

    // MARK: - Saving and closing

    /// Writes the index whole or not at all: to a file beside it, then
    /// renamed over the old one.
    func save() async throws {
        let reply = try await Core.callStatic(op: "library.save", args: #"{"handle":\#(try requireHandle())}"#)
        guard let bytes = reply.blobs.first else { throw CoreError.badReply("library.save answered no bytes") }
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: fileURL, options: .atomic)
    }

    func close() async {
        if let handle {
            _ = try? await Core.callStatic(op: "library.close", args: #"{"handle":\#(handle)}"#)
        }
        handle = nil
    }
}
