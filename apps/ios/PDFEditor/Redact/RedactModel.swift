import Foundation
import Observation
import PDFKit
import SwiftUI
import WarraqCore

/// Redact: marks laid on the pages — a word tapped, text dragged over, an
/// area drawn, or every match of a search — reviewed, then applied by the
/// core (`redact.apply`), which takes out what lies under them: the glyphs,
/// the pixels, the drawings, the annotations and the replacement text that
/// would still say what they said. Not covered: gone from the file.
///
/// The marks are this model's until they are applied; the file does not
/// change. Applying writes the file **whole** (an incremental update would
/// keep what was cut in the revision under it), so it is irreversible once
/// saved — the app says so before it applies — and until Save it is a step
/// of undo like every other change. Hidden information (metadata,
/// attachments, scripts, hidden layers…) is the core's `redact.inspect` and
/// `redact.scrub`, as on the desktop.
@MainActor @Observable
final class RedactModel {
    /// How a tap or a drag on the page marks.
    enum Mode: String, CaseIterable, Identifiable {
        /// A tap marks a word; a drag, the text it crosses.
        case text
        /// A drag marks the box it draws, whatever is in it.
        case area

        var id: String { rawValue }

        var title: LocalizedStringKey {
            switch self {
            case .text: "Mark text"
            case .area: "Mark an area"
            }
        }

        var symbol: String {
            switch self {
            case .text: "character.cursor.ibeam"
            case .area: "rectangle.dashed"
            }
        }
    }

    /// One thing marked: its boxes on one page, in the page's stored space
    /// (points from the crop box's top-left, y down, before `/Rotate`) —
    /// where the core's search answers glyph boxes and `redact.apply` takes
    /// them — and what the core reads under it, to list it by.
    struct Mark: Identifiable, Equatable, Sendable {
        let id: UUID
        let page: Int
        let rects: [CGRect]
        var label: String
        let kind: Kind

        enum Kind: String, Sendable {
            case text
            case area
            case found
        }
    }

    /// A match of the search, as `redact.find` answers it.
    struct Match: Decodable, Equatable, Identifiable, Sendable {
        let page: Int
        let text: String
        let before: String
        let after: String
        let kind: String
        let pageMark: Bool
        let rects: [StoredRect]

        var id: String { "\(page)-\(rects.first.map { "\($0.x),\($0.y)" } ?? text)-\(before.count)" }
        /// The reader knows where its glyphs are: it can be marked.
        var isPlaced: Bool { !rects.isEmpty }
    }

    /// What the core says a file carries besides its pages.
    struct Finding: Decodable, Equatable, Identifiable, Sendable {
        let kind: String
        let count: Int
        let details: [Detail]

        var id: String { kind }

        struct Detail: Decodable, Equatable, Sendable {
            var word: String?
            var subtype: String?
            var property: String?
            var value: String?
            var name: String?
            var count: Int?
        }
    }

    struct Report: Decodable, Equatable, Sendable {
        let findings: [Finding]
        let revisions: Int
        let unreachable: Int
        let signed: Bool
        let `protected`: Bool
    }

    /// What `redact.apply` took out, said back to the person.
    struct Applied: Decodable, Equatable, Sendable {
        let pages: Int
        let glyphs: Int
        let runs: Int
        let images: Int
        let imagesRemoved: Int
        let paths: Int
        let annotations: Int
        let signed: Bool
    }

    /// The ready-made patterns `redact.find` knows.
    static let patterns = ["email", "phone", "nationalId", "iban", "card", "date"]

    let model: DocumentModel
    weak var undoManager: UndoManager?
    var mode: Mode = .text
    private(set) var marks: [Mark] = []
    /// The mark picked on the page or in the list (Delete removes it).
    var selected: UUID?
    /// True while the core is reading or rewriting.
    private(set) var working = false
    var error: LocalizedStringKey?
    /// What the last application took out, until it is read.
    var applied: Applied?
    /// Counts the changes made here, for the haptic and the tests.
    private(set) var changes = 0

    // The search.
    var query = ""
    var chosenPatterns: Set<String> = []
    var custom = ""
    private(set) var matches: [Match] = []
    private(set) var total = 0
    private(set) var searched = false
    var chosenMatches: Set<String> = []

    // Hidden information.
    private(set) var report: Report?
    var chosenFindings: Set<String> = []

    init(model: DocumentModel) {
        self.model = model
    }

    /// A protected file is written whole by a redaction, which would lose
    /// its password: the core refuses it, and so does the interface, first.
    var isProtected: Bool {
        model.password != nil || model.metadata?.encrypted == true
    }

    // MARK: - Marks

    func marks(onPage index: Int) -> [Mark] {
        marks.filter { $0.page == index }
    }

    /// Adds a mark over `rects` (stored space) and labels it with what the
    /// core reads under it — in logical order, Arabic as it is read.
    func mark(rects: [CGRect], onPage index: Int, kind: Mark.Kind) async {
        let boxes = rects.filter { $0.width >= 1 && $0.height >= 1 }
        guard !boxes.isEmpty else { return }
        let mark = Mark(id: UUID(), page: index, rects: boxes, label: "", kind: kind)
        marks.append(mark)
        selected = mark.id
        changes += 1
        let label = await text(under: boxes, onPage: index)
        if let at = marks.firstIndex(where: { $0.id == mark.id }) {
            marks[at].label = label
        }
    }

    /// What the core reads under boxes of a page (`view.text`): the chars
    /// whose middle is inside, one line of the page per line.
    func text(under rects: [CGRect], onPage index: Int) async -> String {
        struct Box: Encodable { let x: Float; let y: Float; let width: Float; let height: Float }
        struct Args: Encodable { let page: Int; let boxes: [Box] }
        struct Answer: Decodable { let text: String }
        guard let core = await model.readyEngine() else { return "" }
        let boxes = rects.map { Box(x: Float($0.minX), y: Float($0.minY), width: Float($0.width), height: Float($0.height)) }
        let reply = try? await core.call(op: "view.text", args: Args(page: index, boxes: boxes))
        return (try? reply?.decode(Answer.self).text)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    func remove(_ id: UUID) {
        marks.removeAll { $0.id == id }
        if selected == id { selected = nil }
        changes += 1
    }

    func removeAll() {
        marks.removeAll()
        selected = nil
        changes += 1
    }

    /// The marks drawn on a page, for the layers to redraw on: the mode,
    /// what is marked and what is picked.
    var signature: String {
        ([mode.rawValue, selected?.uuidString ?? "", "\(model.revision)"] + marks.map { "\($0.id)" }).joined(separator: "|")
    }

    // MARK: - Search

    var canSearch: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty || !chosenPatterns.isEmpty
            || !custom.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Finds the words and patterns as the find bar does (Arabic-aware:
    /// diacritics ignored, alef, taa marbuta, yaa and digit forms unified),
    /// everywhere on every page — running heads, footers and page marks too.
    func search() async {
        guard canSearch, !working else { return }
        struct Args: Encodable { let query: String; let patterns: [String]; let custom: String? }
        struct Answer: Decodable { let matches: [Match]; let total: Int }
        working = true
        defer { working = false }
        guard let core = await model.readyEngine() else { return }
        let trimmed = custom.trimmingCharacters(in: .whitespaces)
        let patterns = Self.patterns.filter { chosenPatterns.contains($0) }
        do {
            let reply = try await core.call(op: "redact.find", args: Args(query: query, patterns: patterns, custom: trimmed.isEmpty ? nil : trimmed))
            let answer = try reply.decode(Answer.self)
            matches = answer.matches
            total = answer.total
            chosenMatches = Set(answer.matches.filter(\.isPlaced).map(\.id))
        } catch {
            matches = []
            total = 0
            self.error = trimmed.isEmpty ? "The search did not finish." : "That pattern is not one the search understands."
        }
        searched = true
    }

    /// The chosen matches become marks, each over its own glyphs.
    func markChosenMatches() {
        let chosen = matches.filter { chosenMatches.contains($0.id) && $0.isPlaced }
        for match in chosen {
            marks.append(Mark(id: UUID(), page: match.page, rects: match.rects.map(\.cgRect), label: match.text, kind: .found))
        }
        chosenMatches.removeAll()
        if !chosen.isEmpty { changes += 1 }
    }

    func clearSearch() {
        matches = []
        total = 0
        searched = false
        chosenMatches.removeAll()
    }

    // MARK: - Applying

    /// Takes out what lies under every mark, through the core, and puts the
    /// file it writes in the document's place: a step of undo until Save.
    func apply() async {
        guard !marks.isEmpty, !working else { return }
        guard !isProtected else {
            error = "A protected file cannot be redacted: its password would be lost. Remove the password first."
            return
        }
        struct Box: Encodable { let x: Float; let y: Float; let width: Float; let height: Float }
        struct Page: Encodable { let page: Int; let rects: [Box] }
        struct Args: Encodable { let marks: [Page]; let fill: String }
        let pages = marks.map { mark in
            Page(page: mark.page, rects: mark.rects.map { Box(x: Float($0.minX), y: Float($0.minY), width: Float($0.width), height: Float($0.height)) })
        }
        working = true
        defer { working = false }
        do {
            let reply = try await Core.callStatic(op: "redact.apply", args: Args(marks: pages, fill: "#000000"), blobs: [model.bytes])
            if reply.object["refused"] != nil {
                error = "A protected file cannot be redacted: its password would be lost. Remove the password first."
                return
            }
            guard let bytes = reply.blobs.first else { throw CoreError.badReply("no file") }
            let answer = try reply.decode(Applied.self)
            try await model.replace(bytes: bytes, undoManager: undoManager)
            marks.removeAll()
            selected = nil
            clearSearch()
            applied = answer
            changes += 1
        } catch {
            self.error = PagesModel.describe(error)
        }
    }

    /// Whether the file is signed: a redaction changes it after the
    /// signature, which then shows as changed. Read for the warning.
    func isSigned() async -> Bool {
        let reply = try? await Core.callStatic(op: "redact.inspect", args: PasswordArgs(password: model.password), blobs: [model.bytes])
        return (try? reply?.decode(Report.self).signed) ?? false
    }

    // MARK: - Hidden information

    /// Reports what the file carries besides its pages.
    func inspect() async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            let reply = try await Core.callStatic(op: "redact.inspect", args: PasswordArgs(password: model.password), blobs: [model.bytes])
            let found = try reply.decode(Report.self)
            report = found
            // Everything found but hidden text: a scan's searchable layer is
            // invisible text, and taking it away is a choice, not a default.
            chosenFindings = Set(found.findings.map(\.kind).filter { $0 != "hiddenText" })
        } catch {
            self.error = PagesModel.describe(error)
        }
    }

    /// The chosen kinds removed; the file written whole, as the desktop does.
    func removeHidden() async {
        guard let report, !working else { return }
        guard !report.protected, !isProtected else {
            error = "A protected file cannot be cleaned: its password would be lost. Remove the password first."
            return
        }
        struct Args: Encodable { let password: String?; let remove: [String] }
        working = true
        do {
            let reply = try await Core.callStatic(op: "redact.scrub", args: Args(password: model.password, remove: Array(chosenFindings).sorted()), blobs: [model.bytes])
            guard reply.object["refused"] == nil, let bytes = reply.blobs.first else {
                throw CoreError.edit("refused")
            }
            try await model.replace(bytes: bytes, undoManager: undoManager)
            changes += 1
            working = false
            await inspect()
        } catch {
            working = false
            self.error = PagesModel.describe(error)
        }
    }

    func clearError() {
        error = nil
    }
}

/// A static operation's only argument, the file's password.
struct PasswordArgs: Encodable {
    let password: String?
}
