import Foundation
import Observation
import PDFKit
import WarraqCore

/// A text field the form has, as PDFKit lists it, with the words printed
/// beside it from the core's reading of the page (the label a person sees).
struct FillableField: Identifiable, Equatable, Sendable {
    let name: String
    let label: String
    let tooltip: String
    let current: String
    /// Zero-based.
    let page: Int
    /// In display space: points from the page's top-left corner.
    let rect: CGRect

    var id: String { name }

    var description: FieldDescription {
        FieldDescription(name: name, label: label.isEmpty ? tooltip : label, current: current, page: page + 1)
    }
}

/// One value proposed for a field, where it came from, and whether the
/// person wants it written. Nothing is written until they say so.
struct FillProposal: Identifiable, Equatable, Sendable {
    enum Source: Equatable, Sendable {
        case profile(ProfileKey)
        case document
    }

    let field: FillableField
    var value: String
    let source: Source
    var accepted = true

    var id: String { field.name }
}

/// Reads the form's fields, asks the engine which detail fills which, and
/// keeps only what the profile or the document actually says.
enum FormAutofill {
    /// How far from a field its label may be, in points.
    static let near: CGFloat = 160

    /// The text fields a person can type into, each with its label.
    @MainActor
    static func fields(in model: DocumentModel) async -> [FillableField] {
        guard let pdf = model.pdf else { return [] }
        var found: [FillableField] = []
        var seen: Set<String> = []
        for index in 0..<pdf.pageCount {
            guard let page = pdf.page(at: index) else { continue }
            let widgets = page.annotations.filter { $0.type == "Widget" && $0.widgetFieldType == .text }
            if widgets.isEmpty { continue }
            let lines = (try? await model.engine?.textLines(page: index)) ?? []
            for widget in widgets {
                guard let name = widget.fieldName, !name.isEmpty, !seen.contains(name) else { continue }
                if widget.isReadOnly { continue }
                seen.insert(name)
                let rect = displayRect(of: widget.bounds, on: page)
                let current = (widget.widgetStringValue ?? "").prefix(200)
                var label = labelFor(rect: rect, lines: lines)
                // What the field holds is drawn on the page too: not part of
                // its label.
                if !current.isEmpty { label = label.replacingOccurrences(of: String(current), with: "").trimmingCharacters(in: .whitespaces) }
                let tooltip = (widget.value(forAnnotationKey: PDFAnnotationKey(rawValue: "/TU")) as? String) ?? ""
                found.append(FillableField(name: name, label: label, tooltip: String(tooltip.prefix(120)),
                                           current: String(current), page: index, rect: rect))
            }
        }
        return found
    }

    /// The label of a field whose box is `rect`: the line of text on the
    /// same band of the page closest to it — the line the field sits in,
    /// or the nearest before it in the line's own direction (to its right
    /// in Arabic), or failing that, just above it. The desktop's rule.
    static func labelFor(rect: CGRect, lines: [TextLine]) -> String {
        let middle = rect.midY
        var best: (line: TextLine, distance: CGFloat)?
        for line in lines {
            let text = line.text.trimmingCharacters(in: .whitespaces)
            if text.isEmpty { continue }
            let x = CGFloat(line.x), width = CGFloat(line.width)
            let top = CGFloat(line.y), bottom = top + CGFloat(line.height)
            let sameBand = middle >= top - 2 && middle <= bottom + 2
            let above = bottom <= rect.minY + 2 && rect.minY - bottom < 40 && x < rect.maxX && x + width > rect.minX
            var distance: CGFloat
            if sameBand {
                let gap: CGFloat = x >= rect.maxX ? x - rect.maxX : (x + width <= rect.minX ? rect.minX - (x + width) : 0)
                let before = line.isRightToLeft ? x >= rect.maxX - 4 : x + width <= rect.minX + 4
                distance = gap == 0 ? 10 : gap + (before ? 0 : near / 2)
            } else if above {
                distance = rect.minY - bottom + near / 4
            } else {
                continue
            }
            if distance <= near, best == nil || distance < best!.distance {
                best = (line, distance)
            }
        }
        return best.map { String($0.line.text.trimmingCharacters(in: .whitespaces).prefix(120)) } ?? ""
    }

    /// An annotation's bounds (PDF user space, y up, before the page's
    /// rotation) as the core's display space (points from the top-left of
    /// the page as shown).
    static func displayRect(of bounds: CGRect, on page: PDFPage) -> CGRect {
        PageSpace(page: page).displayRect(fromUser: bounds)
    }

    /// Asks the engine, then keeps only assignments the profile or the
    /// document really answers: a profile key must hold a value, a quote
    /// must appear in the document's text. Anything else is dropped.
    static func propose(fields: [FillableField], profile: Profile, documentText: String, engine: any AIEngine) async throws -> [FillProposal] {
        let keys = profile.filledKeys
        let candidates = fields.filter { $0.current.isEmpty }
        if candidates.isEmpty { return [] }
        let assignments = try await engine.assign(fields: candidates.map(\.description), profileKeys: keys, documentText: documentText)
        return check(assignments, fields: candidates, profile: profile, documentText: documentText)
    }

    /// The never-invent rule, as code.
    static func check(_ assignments: [FieldAssignment], fields: [FillableField], profile: Profile, documentText: String) -> [FillProposal] {
        let byName = Dictionary(fields.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        var out: [FillProposal] = []
        var done: Set<String> = []
        for assignment in assignments {
            guard let field = byName[assignment.field], !done.contains(field.name) else { continue }
            if let key = assignment.profileKey {
                let value = profile.value(key)
                guard !value.isEmpty else { continue }
                out.append(FillProposal(field: field, value: value, source: .profile(key)))
                done.insert(field.name)
            } else if let quote = assignment.documentQuote?.trimmingCharacters(in: .whitespacesAndNewlines), !quote.isEmpty, quote.count <= 200,
                      documentText.contains(quote) {
                out.append(FillProposal(field: field, value: quote, source: .document))
                done.insert(field.name)
            }
        }
        return out
    }

    /// Writes the accepted values into the fields — through PDFKit's
    /// annotations, then the core redraws Arabic values shaped (PDFKit's
    /// own appearance streams do not shape Arabic) — and hands the bytes to
    /// the model, with an undo step.
    @MainActor
    static func write(_ proposals: [FillProposal], into model: DocumentModel, undoManager: UndoManager?) async throws -> Int {
        guard let pdf = model.pdf else { return 0 }
        let accepted = proposals.filter { $0.accepted && !$0.value.trimmingCharacters(in: .whitespaces).isEmpty }
        if accepted.isEmpty { return 0 }
        var written = 0
        for proposal in accepted {
            guard let page = pdf.page(at: proposal.field.page),
                  let widget = page.annotations.first(where: { $0.fieldName == proposal.field.name && $0.widgetFieldType == .text }) else { continue }
            widget.widgetStringValue = proposal.value
            written += 1
        }
        guard written > 0, let bytes = pdf.dataRepresentation() else { return 0 }
        var result = bytes
        // The core draws the values shaped, with an embedded font, so Arabic
        // reads back — a Debug run without the font keeps PDFKit's drawing.
        if let font = Self.appearanceFont {
            struct Args: Encodable { let password: String? }
            if let reply = try? await Core.callStatic(op: "forms.fix_appearances", args: Args(password: nil), blobs: [bytes, font]),
               let fixed = reply.blobs.first, !fixed.isEmpty {
                result = fixed
            }
        }
        try await model.replace(bytes: result, undoManager: undoManager)
        return written
    }

    /// The bundled Arabic font the core embeds when it draws field values.
    static var appearanceFont: Data? {
        guard let url = Bundle.main.url(forResource: "NotoNaskhArabic-Variable", withExtension: "ttf") else { return nil }
        return try? Data(contentsOf: url)
    }
}

/// The two coordinate spaces of a page: PDF user space (points, y up, the
/// crop box's origin, before rotation) and display space (points from the
/// top-left corner of the page as shown, after its rotation) — the core
/// speaks the second, PDFKit's annotations the first.
struct PageSpace: Equatable {
    let crop: CGRect
    /// 0, 90, 180 or 270.
    let rotation: Int

    init(crop: CGRect, rotation: Int) {
        self.crop = crop
        self.rotation = ((rotation % 360) + 360) % 360
    }

    init(page: PDFPage) {
        self.init(crop: page.bounds(for: .cropBox), rotation: page.rotation)
    }

    /// A point in display space as a point in user space.
    func userPoint(fromDisplay p: CGPoint) -> CGPoint {
        switch rotation {
        case 90: CGPoint(x: crop.minX + p.y, y: crop.minY + p.x)
        case 180: CGPoint(x: crop.maxX - p.x, y: crop.minY + p.y)
        case 270: CGPoint(x: crop.maxX - p.y, y: crop.maxY - p.x)
        default: CGPoint(x: crop.minX + p.x, y: crop.maxY - p.y)
        }
    }

    /// A point in user space as a point in display space.
    func displayPoint(fromUser p: CGPoint) -> CGPoint {
        switch rotation {
        case 90: CGPoint(x: p.y - crop.minY, y: p.x - crop.minX)
        case 180: CGPoint(x: crop.maxX - p.x, y: p.y - crop.minY)
        case 270: CGPoint(x: crop.maxY - p.y, y: crop.maxX - p.x)
        default: CGPoint(x: p.x - crop.minX, y: crop.maxY - p.y)
        }
    }

    func userRect(fromDisplay r: CGRect) -> CGRect {
        let a = userPoint(fromDisplay: CGPoint(x: r.minX, y: r.minY))
        let b = userPoint(fromDisplay: CGPoint(x: r.maxX, y: r.maxY))
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    func displayRect(fromUser r: CGRect) -> CGRect {
        let a = displayPoint(fromUser: CGPoint(x: r.minX, y: r.minY))
        let b = displayPoint(fromUser: CGPoint(x: r.maxX, y: r.maxY))
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }
}
