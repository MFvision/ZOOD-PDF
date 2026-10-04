import Foundation
import Observation
import SwiftUI
import WarraqCore

/// Prepare form: fields laid out on the page as drafts — drawn by hand with
/// a drag, or proposed by the core's detection (`forms.detect`: underscore
/// and dot runs, empty table cells, boxes, lines to sign on, check boxes,
/// each named from its Arabic or English label) — moved, resized, named and
/// typed here, then made into real AcroForm fields by the core in one step
/// (`forms.create`), as an incremental update and a step of undo. Filling
/// is the core's too (`forms.fill`): the values written by name and drawn
/// into each field's appearance, Arabic shaped, so every reader shows them.
@MainActor @Observable
final class FormModel {
    /// The kinds of field Prepare form makes.
    enum Kind: String, CaseIterable, Identifiable, Sendable {
        case text
        case date
        case hijri
        case checkbox
        case radio
        case choice
        case signature

        var id: String { rawValue }

        /// The kinds the bar offers to draw; a Hijri date comes from the
        /// detection or the inspector's picker.
        static let drawn: [Kind] = [.text, .date, .checkbox, .radio, .choice, .signature]

        var title: LocalizedStringKey {
            switch self {
            case .text: "Text field"
            case .date: "Date"
            case .hijri: "Hijri date"
            case .checkbox: "Check box"
            case .radio: "Radio button"
            case .choice: "List"
            case .signature: "Signature field"
            }
        }

        var symbol: String {
            switch self {
            case .text: "character.textbox"
            case .date: "calendar"
            case .hijri: "moon"
            case .checkbox: "checkmark.square"
            case .radio: "smallcircle.filled.circle"
            case .choice: "list.bullet.rectangle"
            case .signature: "signature"
            }
        }

        /// The name a field of this kind is given until it is named.
        var defaultName: String {
            switch self {
            case .text: String(localized: "Text")
            case .date, .hijri: String(localized: "Date")
            case .checkbox: String(localized: "Check box")
            case .radio: String(localized: "Choice")
            case .choice: String(localized: "List")
            case .signature: String(localized: "Signature")
            }
        }

        /// A square kind keeps its box square as it is drawn.
        var isSquare: Bool { self == .checkbox || self == .radio }
    }

    /// A field waiting to be made: where, as the page is shown (points from
    /// its top-left after `/Rotate`, the space `forms.create` takes), and
    /// what it will be.
    struct Draft: Identifiable, Equatable, Sendable {
        let id: UUID
        var page: Int
        var rect: CGRect
        var kind: Kind
        /// The field's name; radio buttons sharing one are one field.
        var name: String
        var tooltip: String = ""
        /// Right-aligned text (`/Q 2`), for an Arabic form.
        var rtl: Bool
        /// A date field's pattern.
        var pattern: String = "dd/mm/yyyy"
        /// A list's options, one a line as typed.
        var options: String = ""
        /// What a radio button stands for (its `/Opt` entry).
        var label: String = ""
    }

    /// A field already in the file, from `forms.inspect`.
    struct Field: Decodable, Equatable, Identifiable, Sendable {
        let name: String
        let type: String
        let value: String
        let tooltip: String?
        let readOnly: Bool
        let widgets: [Widget]
        let options: [String]?
        let states: [String]?
        let editable: Bool?

        var id: String { name }

        struct Widget: Decodable, Equatable, Sendable {
            let page: Int
            /// As shown: `[x0, top, x1, bottom]`.
            let rect: [Float]

            var shownRect: CGRect {
                guard rect.count == 4 else { return .zero }
                return CGRect(x: CGFloat(rect[0]), y: CGFloat(rect[1]), width: CGFloat(rect[2] - rect[0]), height: CGFloat(rect[3] - rect[1]))
            }
        }
    }

    let model: DocumentModel
    weak var undoManager: UndoManager?
    /// The kind a drag on the page draws; nil when a drag moves what is picked.
    var placing: Kind?
    private(set) var drafts: [Draft] = []
    var selected: UUID?
    private(set) var fields: [Field] = []
    private(set) var fieldsRevision = -1
    private(set) var working = false
    var error: LocalizedStringKey?
    /// Said once after a detection or a creation, then cleared.
    var notice: LocalizedStringKey?
    private(set) var changes = 0

    init(model: DocumentModel) {
        self.model = model
    }

    func drafts(onPage index: Int) -> [Draft] {
        drafts.filter { $0.page == index }
    }

    func fields(onPage index: Int) -> [(Field, CGRect)] {
        fields.flatMap { field in
            field.widgets.filter { $0.page == index }.map { (field, $0.shownRect) }
        }
    }

    var picked: Draft? {
        guard let selected else { return nil }
        return drafts.first { $0.id == selected }
    }

    /// What the layers over the pages must be redrawn for.
    var signature: String {
        ([placing?.rawValue ?? "", selected?.uuidString ?? "", "\(model.revision)", "\(fieldsRevision)"]
            + drafts.map { "\($0.id)\($0.rect)\($0.name)\($0.kind.rawValue)" }).joined(separator: "|")
    }

    // MARK: - Reading the form

    /// The fields the file already has, read again after every change.
    func readFields() async {
        guard fieldsRevision != model.revision else { return }
        let revision = model.revision
        struct Answer: Decodable { let fields: [Field] }
        let reply = try? await Core.callStatic(op: "forms.inspect", args: PasswordArgs(password: model.password), blobs: [model.bytes])
        guard revision == model.revision else { return }
        fields = (try? reply?.decode(Answer.self).fields) ?? []
        fieldsRevision = revision
    }

    // MARK: - Drafts

    /// A draft drawn on a page: named after its kind, numbered after the
    /// drafts and fields already there; a radio button joins the group the
    /// last one drawn is in, so a row of them is one question.
    func add(kind: Kind, rect: CGRect, onPage index: Int) {
        var name = kind.defaultName
        if kind == .radio, let last = drafts.last(where: { $0.kind == .radio }) {
            name = last.name
        } else {
            let taken = Set(drafts.map(\.name) + fields.map(\.name))
            var n = 1
            while taken.contains("\(name) \(n)") { n += 1 }
            name = "\(name) \(n)"
        }
        let siblings = drafts.filter { $0.kind == .radio && $0.name == name }.count
        var draft = Draft(id: UUID(), page: index, rect: rect, kind: kind, name: name, rtl: model.isRightToLeft)
        if kind == .radio { draft.label = "\(siblings + 1)" }
        if kind == .choice { draft.options = "" }
        drafts.append(draft)
        selected = draft.id
        changes += 1
    }

    func update(_ draft: Draft) {
        guard let at = drafts.firstIndex(where: { $0.id == draft.id }) else { return }
        drafts[at] = draft
    }

    func move(_ id: UUID, to rect: CGRect) {
        guard let at = drafts.firstIndex(where: { $0.id == id }) else { return }
        drafts[at].rect = rect
        changes += 1
    }

    func remove(_ id: UUID) {
        drafts.removeAll { $0.id == id }
        if selected == id { selected = nil }
        changes += 1
    }

    func removeAllDrafts() {
        drafts.removeAll()
        selected = nil
    }

    /// The arrow keys move the picked draft a point at a time, ten with Shift.
    func nudge(dx: CGFloat, dy: CGFloat, far: Bool) {
        guard let draft = picked else { return }
        let step: CGFloat = far ? 10 : 1
        move(draft.id, to: draft.rect.offsetBy(dx: dx * step, dy: dy * step))
    }

    /// Asks the core where this flat form expects writing, and lays a draft
    /// over each place it proposes; nothing is made until Create.
    func detect(pages: [Int]? = nil) async {
        guard !working else { return }
        struct Args: Encodable { let password: String?; let pages: [Int] }
        struct Proposal: Decodable { let kind: String; let name: String; let tooltip: String; let rect: [Float]; let rtl: Bool; let pattern: String? }
        struct Page: Decodable { let index: Int; let fields: [Proposal] }
        struct Answer: Decodable { let pages: [Page] }
        working = true
        defer { working = false }
        do {
            let reply = try await Core.callStatic(op: "forms.detect", args: Args(password: model.password, pages: pages ?? []), blobs: [model.bytes])
            let answer = try reply.decode(Answer.self)
            // A place a draft or a field already covers is not proposed twice.
            let covered = drafts.map { ($0.page, $0.rect) } + fields.flatMap { f in f.widgets.map { ($0.page, $0.shownRect) } }
            var added = 0
            for page in answer.pages {
                for p in page.fields where p.rect.count == 4 {
                    let rect = CGRect(x: CGFloat(p.rect[0]), y: CGFloat(p.rect[1]), width: CGFloat(p.rect[2] - p.rect[0]), height: CGFloat(p.rect[3] - p.rect[1]))
                    guard !covered.contains(where: { $0.0 == page.index && $0.1.intersects(rect.insetBy(dx: 2, dy: 2)) }) else { continue }
                    let kind = Kind(rawValue: p.kind) ?? .text
                    var draft = Draft(id: UUID(), page: page.index, rect: rect, kind: kind, name: p.name, tooltip: p.tooltip, rtl: p.rtl)
                    if let pattern = p.pattern { draft.pattern = pattern }
                    drafts.append(draft)
                    added += 1
                }
            }
            notice = added == 0 ? "No more places for fields were found." : "Fields proposed: \(added). Move, resize or rename them, then Create."
            changes += 1
        } catch {
            self.error = PagesModel.describe(error)
        }
    }

    /// Whether every draft can be made: a list needs options.
    var problem: LocalizedStringKey? {
        if drafts.contains(where: { $0.kind == .choice && Self.options(of: $0).isEmpty }) {
            return "A list needs at least one option."
        }
        if drafts.contains(where: { $0.name.trimmingCharacters(in: .whitespaces).isEmpty }) {
            return "Every field needs a name."
        }
        return nil
    }

    static func options(of draft: Draft) -> [String] {
        draft.options.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// Makes every draft a real field, through the core, as one step of undo.
    func create() async {
        guard !drafts.isEmpty, !working else { return }
        if let problem {
            error = problem
            return
        }
        struct NewField: Encodable {
            let page: Int
            let kind: String
            let name: String
            let tooltip: String
            let rect: [Float]
            let rtl: Bool
            let pattern: String?
            let options: [String]
        }
        struct Args: Encodable { let password: String?; let fields: [NewField] }
        let fields = drafts.map { d in
            NewField(page: d.page, kind: d.kind.rawValue, name: d.name.trimmingCharacters(in: .whitespaces),
                     tooltip: d.tooltip, rect: [Float(d.rect.minX), Float(d.rect.minY), Float(d.rect.maxX), Float(d.rect.maxY)],
                     rtl: d.rtl, pattern: d.kind == .date || d.kind == .hijri ? d.pattern : nil,
                     options: d.kind == .choice ? Self.options(of: d) : (d.kind == .radio ? [d.label] : []))
        }
        working = true
        defer { working = false }
        do {
            let reply = try await Core.callStatic(op: "forms.create", args: Args(password: model.password, fields: fields), blobs: [model.bytes])
            guard let bytes = reply.blobs.first else { throw CoreError.badReply("no file") }
            try await model.replace(bytes: bytes, undoManager: undoManager)
            let made = (reply.object["created"] as? [Any])?.count ?? fields.count
            drafts.removeAll()
            selected = nil
            placing = nil
            notice = "Fields made: \(made). Fill them with Fill form in the More menu."
            changes += 1
            await readFields()
        } catch {
            self.error = PagesModel.describe(error)
        }
    }

    // MARK: - Filling

    /// Writes `values` (by field name) into the form through the core, which
    /// runs the form's calculations and draws each value, Arabic shaped, in
    /// the bundled Amiri face — one step of undo.
    func fill(_ values: [String: String]) async -> Bool {
        guard !values.isEmpty, !working else { return false }
        guard let font = EditFace.amiri.bytes else {
            error = "The bundled font is missing."
            return false
        }
        struct Value: Encodable { let name: String; let value: String }
        struct Args: Encodable { let password: String?; let values: [Value] }
        let list = values.keys.sorted().map { Value(name: $0, value: values[$0] ?? "") }
        working = true
        defer { working = false }
        do {
            let reply = try await Core.callStatic(op: "forms.fill", args: Args(password: model.password, values: list), blobs: [model.bytes, font])
            guard let bytes = reply.blobs.first else { throw CoreError.badReply("no file") }
            try await model.replace(bytes: bytes, undoManager: undoManager)
            changes += 1
            await readFields()
            return true
        } catch {
            self.error = PagesModel.describe(error)
            return false
        }
    }

    func clearError() {
        error = nil
    }
}
