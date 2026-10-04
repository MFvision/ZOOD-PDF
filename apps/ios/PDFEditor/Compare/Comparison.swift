import Foundation
import WarraqCore

/// What the core's `compare.text` answers: every page of the older version
/// read in logical order and compared word by word with the page in the
/// same place of the newer one (`packages/core/warraq-core/src/tools/compare.rs`,
/// the rules of the desktop's Compare). Words added and removed are counted
/// as words; inserted, deleted and replaced as places.
struct TextComparison: Decodable, Sendable, Equatable {
    struct Part: Decodable, Sendable, Equatable {
        /// "same", "removed" or "added".
        let kind: String
        let text: String
        /// The change it belongs to (an index of `changes`), for removed and added parts.
        let change: Int?
    }

    struct Passage: Decodable, Sendable, Equatable {
        /// Unchanged words come before it and are not shown.
        let before: Bool
        /// Unchanged words come after it and are not shown.
        let after: Bool
        let parts: [Part]
    }

    struct PageChange: Decodable, Sendable, Equatable {
        /// One-based.
        let page: Int
        let inOlder: Bool
        let inNewer: Bool
        let added: Int
        let removed: Int
        let passages: [Passage]
    }

    struct Change: Decodable, Sendable, Equatable {
        enum Kind: String, Decodable, Sendable {
            case inserted
            case deleted
            case replaced
        }

        /// One-based.
        let page: Int
        let kind: Kind
        let removed: String
        let added: String
        let removedWords: Int
        let addedWords: Int
        /// Which of the page's passages shows it.
        let passage: Int
    }

    let olderPages: Int
    let newerPages: Int
    let olderWords: Int
    let newerWords: Int
    let added: Int
    let removed: Int
    let inserted: Int
    let deleted: Int
    let replaced: Int
    let pages: [PageChange]
    let changes: [Change]

    /// The passage that shows `change`.
    func passage(of change: Change) -> Passage? {
        guard let page = pages.first(where: { $0.page == change.page }), change.passage < page.passages.count else { return nil }
        return page.passages[change.passage]
    }

    /// Neither version has any text: scans, compared only by how they look.
    var hasNoText: Bool { olderWords == 0 && newerWords == 0 }
}

/// A place where a page looks different, in fractions of the page from its
/// top-left corner — the same on the older and the newer page.
struct LookBox: Decodable, Sendable, Equatable, Hashable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

/// A page both versions have, and where it looks different (none: it looks the same).
struct PageLook: Decodable, Sendable, Equatable {
    /// One-based.
    let page: Int
    let boxes: [LookBox]
}

/// One version of the document: its bytes, the password it opens with, its name.
struct CompareSide: Sendable, Equatable {
    var name: String
    var bytes: Data
    var password: String?
}

/// The core's two comparisons. Nothing here touches either file: both are
/// read from bytes, and nothing is written.
enum Comparer {
    struct TextArgs: Encodable {
        let olderPassword: String?
        let newerPassword: String?
        let ignoreMarks: Bool
        let unifyLetters: Bool
    }

    struct VisualArgs: Encodable {
        let olderPassword: String?
        let newerPassword: String?
        let pages: [Int]
        let width: Float
    }

    /// Pages drawn per call: the progress moves and Stop is heard between them.
    static let pagesPerCall = 4
    /// Pixels across a page, as the desktop compares them: enough for a tick or a stamp.
    static let lookWidth: Float = 480

    static func text(older: CompareSide, newer: CompareSide, ignoreMarks: Bool, unifyLetters: Bool) async throws -> TextComparison {
        let args = TextArgs(olderPassword: older.password, newerPassword: newer.password,
                            ignoreMarks: ignoreMarks, unifyLetters: unifyLetters)
        return try await Core.callStatic(op: "compare.text", args: args, blobs: [older.bytes, newer.bytes]).decode()
    }

    /// The pages `pages` (zero-based) of both versions, drawn and compared.
    static func looks(older: CompareSide, newer: CompareSide, pages: [Int]) async throws -> [PageLook] {
        struct Answer: Decodable { let pages: [PageLook] }
        let args = VisualArgs(olderPassword: older.password, newerPassword: newer.password, pages: pages, width: lookWidth)
        let answer: Answer = try await Core.callStatic(op: "compare.visual", args: args, blobs: [older.bytes, newer.bytes]).decode()
        return answer.pages
    }

    /// Whether `bytes` open with `password`: nil when they do, the reason when not.
    static func opening(_ bytes: Data, password: String?) async -> CoreError? {
        do {
            let core = try await Core.open(bytes: bytes, password: password)
            await core.close()
            return nil
        } catch let error as CoreError {
            return error
        } catch {
            return .other(code: "E_OTHER", message: error.localizedDescription)
        }
    }
}
