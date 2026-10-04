import Foundation
import SwiftUI

/// One step of a batch: what one of the app's tools does to an open file,
/// done to each file of the batch instead, through the same core operations
/// the desktop's Batch uses (`packages/ui/src/batch/steps.ts`). Every option
/// a step has is here, so a sequence is one list of these; a step that does
/// not use an option ignores it. Passwords are never part of a step: Protect
/// asks for them when the batch runs, so a saved sequence cannot keep one.
struct BatchStep: Codable, Identifiable, Equatable, Hashable, Sendable {
    enum Kind: String, Codable, CaseIterable, Identifiable, Sendable {
        case ocr
        case compress
        case rotate
        case deletePages
        case extractPages
        case pageMarks
        case removeHidden
        case protect
        case export

        var id: String { rawValue }

        var title: LocalizedStringKey {
            switch self {
            case .ocr: "Recognize text (OCR)"
            case .compress: "Compress"
            case .rotate: "Rotate pages"
            case .deletePages: "Delete pages"
            case .extractPages: "Keep only some pages"
            case .pageMarks: "Page marks"
            case .removeHidden: "Remove hidden information"
            case .protect: "Protect with a password"
            case .export: "Export"
            }
        }

        var symbol: String {
            switch self {
            case .ocr: "text.viewfinder"
            case .compress: "arrow.down.right.and.arrow.up.left"
            case .rotate: "rotate.right"
            case .deletePages: "trash"
            case .extractPages: "scissors"
            case .pageMarks: "signature"
            case .removeHidden: "eye.slash"
            case .protect: "lock"
            case .export: "square.and.arrow.up.on.square"
            }
        }
    }

    /// Compress's three choices, as the desktop's (`compress/levels.ts`).
    enum CompressLevel: String, Codable, CaseIterable, Identifiable, Sendable {
        case lossless
        case balanced
        case smallest

        var id: String { rawValue }

        var title: LocalizedStringKey {
            switch self {
            case .lossless: "Pictures untouched"
            case .balanced: "Balanced (150 dpi)"
            case .smallest: "Smallest (96 dpi)"
            }
        }

        var imageDPI: Float? {
            switch self {
            case .lossless: nil
            case .balanced: 150
            case .smallest: 96
            }
        }

        var jpegQuality: Int {
            self == .smallest ? 60 : 75
        }
    }

    enum OCRScope: String, Codable, CaseIterable, Identifiable, Sendable {
        /// Only pages with no text of their own: a scan's.
        case blank
        case all

        var id: String { rawValue }
    }

    enum ExportFormat: String, Codable, CaseIterable, Identifiable, Sendable {
        case word
        case text

        var id: String { rawValue }

        var fileExtension: String { self == .word ? "docx" : "txt" }
    }

    /// What `redact.scrub` can take out, as the core names it.
    static let allHiddenKinds = ["metadata", "scripts", "attachments", "comments", "forms", "hiddenLayers",
                              "bookmarks", "thumbnails", "privateData", "links", "hiddenText"]
    /// Everything but hidden text, which is a scan's searchable layer.
    static let defaultHiddenKinds = allHiddenKinds.filter { $0 != "hiddenText" }
    /// The marks a batch makes: what has text of its own or numbers itself.
    static let markKinds: [MarkSpec.Kind] = [.watermark, .header, .footer, .pageNumber]

    var id = UUID()
    var kind: Kind
    /// Which pages: empty for every page; "1-3, 5". Pages a file does not
    /// have are passed over in that file.
    var pages = ""
    /// Rotate: quarter turns clockwise, 1 to 3.
    var quarterTurns = 1
    var compressLevel = CompressLevel.balanced
    var ocrScope = OCRScope.blank
    /// Page marks: `MarkSpec.Kind`'s raw value.
    var markKind = MarkSpec.Kind.pageNumber.rawValue
    /// A watermark's words, or a header's or footer's centre.
    var markText = ""
    var hiddenKinds = BatchStep.defaultHiddenKinds
    var allowPrint = true
    var allowCopy = false
    var allowChange = false
    var exportFormat = ExportFormat.word

    init(kind: Kind) {
        self.kind = kind
        // Deleting or keeping every page is not a step: they start at page 1.
        if kind == .deletePages || kind == .extractPages { pages = "1" }
    }

    enum CodingKeys: String, CodingKey {
        case kind, pages, quarterTurns, compressLevel, ocrScope, markKind, markText, hiddenKinds
        case allowPrint, allowCopy, allowChange, exportFormat
    }

    /// Read back from storage leniently, every option checked: a damaged or
    /// older entry gives the defaults rather than an error, and no value can
    /// be out of range.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(Kind.self, forKey: .kind)
        self.init(kind: kind)
        if let pages = try? c.decodeIfPresent(String.self, forKey: .pages) { self.pages = String(pages.prefix(200)) }
        if let turns = try? c.decodeIfPresent(Int.self, forKey: .quarterTurns) { quarterTurns = min(3, max(1, turns)) }
        if let level = try? c.decodeIfPresent(CompressLevel.self, forKey: .compressLevel) { compressLevel = level }
        if let scope = try? c.decodeIfPresent(OCRScope.self, forKey: .ocrScope) { ocrScope = scope }
        if let mark = try? c.decodeIfPresent(String.self, forKey: .markKind),
           Self.markKinds.contains(where: { $0.rawValue == mark }) { markKind = mark }
        if let text = try? c.decodeIfPresent(String.self, forKey: .markText) { markText = String(text.prefix(200)) }
        if let kinds = try? c.decodeIfPresent([String].self, forKey: .hiddenKinds) {
            hiddenKinds = Self.allHiddenKinds.filter(kinds.contains)
        }
        allowPrint = (try? c.decodeIfPresent(Bool.self, forKey: .allowPrint)) ?? true
        allowCopy = (try? c.decodeIfPresent(Bool.self, forKey: .allowCopy)) ?? false
        allowChange = (try? c.decodeIfPresent(Bool.self, forKey: .allowChange)) ?? false
        if let format = try? c.decodeIfPresent(ExportFormat.self, forKey: .exportFormat) { exportFormat = format }
    }

    var mark: MarkSpec.Kind { MarkSpec.Kind(rawValue: markKind) ?? .pageNumber }

    /// Why the step cannot run as it is, or nil.
    var problem: LocalizedStringKey? {
        if [.rotate, .deletePages, .extractPages, .pageMarks].contains(kind), BatchPages.parse(pages, count: .max) == nil {
            return "Pages are written as 1-3, 5."
        }
        switch kind {
        case .deletePages, .extractPages:
            if pages.trimmingCharacters(in: .whitespaces).isEmpty { return "Say which pages." }
        case .pageMarks:
            if mark != .pageNumber, markText.trimmingCharacters(in: .whitespaces).isEmpty { return "The mark says nothing yet." }
        case .removeHidden:
            if hiddenKinds.isEmpty { return "Choose what to remove." }
        default:
            break
        }
        return nil
    }

    /// One line about the options, under the step's name.
    var summary: Text {
        let on = pages.trimmingCharacters(in: .whitespaces).isEmpty ? Text("every page") : Text("pages \(pages)")
        switch kind {
        case .ocr:
            return ocrScope == .blank ? Text("Pages with no text of their own") : Text("Every page")
        case .compress:
            return Text(compressLevel.title)
        case .rotate:
            return Text("\(quarterTurns * 90)° clockwise, ") + on
        case .deletePages, .extractPages:
            return on
        case .pageMarks:
            let what = markText.trimmingCharacters(in: .whitespaces)
            return Text(mark.title) + (what.isEmpty ? Text(verbatim: "") : Text(verbatim: " «\(what)»")) + Text(verbatim: ", ") + on
        case .removeHidden:
            return Text("\(hiddenKinds.count) kinds of information")
        case .protect:
            return Text("AES-256; the password is asked for when it runs")
        case .export:
            return exportFormat == .word ? Text("Word (.docx)") : Text("Text (.txt)")
        }
    }
}

/// Which pages of a file a step acts on.
enum BatchPages {
    /// The zero-based pages `text` names, clipped to a file of `count`
    /// pages: every page for empty text, nil for text that is not pages.
    /// "1-3, 5", open ends ("3-", "-2"), Arabic-Indic digits and the
    /// Arabic comma are read.
    static func parse(_ text: String, count: Int) -> [Int]? {
        let plain = MarkSpec.westernDigits(text).trimmingCharacters(in: .whitespaces)
        if plain.isEmpty { return count == .max ? [] : Array(0..<max(0, count)) }
        var found = Set<Int>()
        for part in plain.split(separator: ",", omittingEmptySubsequences: true) {
            let piece = part.trimmingCharacters(in: .whitespaces)
            if piece.isEmpty { continue }
            let halves = piece.split(separator: "-", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
            guard halves.count <= 2, halves.allSatisfy({ $0.allSatisfy(\.isNumber) && $0.count <= 6 }) else { return nil }
            let dash = halves.count == 2
            guard !(halves.first ?? "").isEmpty || (dash && !halves[1].isEmpty) else { return nil }
            let from = Int(halves[0]) ?? 1
            let to = dash ? (Int(halves[1]) ?? Int.max) : from
            guard from >= 1, from <= to else { return nil }
            // Only the pages this file has; the bound keeps a typed "1-999999" cheap.
            guard count != .max else { continue }
            let last = min(to, count)
            if from <= last {
                for page in from...last { found.insert(page - 1) }
            }
        }
        return found.sorted()
    }
}

/// A sequence of steps checked as a whole: its first problem, and where.
enum BatchSequence {
    static func problem(_ steps: [BatchStep]) -> (index: Int?, message: LocalizedStringKey)? {
        if steps.isEmpty { return (nil, "Add a step.") }
        for (index, step) in steps.enumerated() {
            if step.kind == .export, index < steps.count - 1 {
                return (index, "Export makes something other than a PDF: it has to be the last step.")
            }
            if let problem = step.problem { return (index, problem) }
        }
        return nil
    }
}
