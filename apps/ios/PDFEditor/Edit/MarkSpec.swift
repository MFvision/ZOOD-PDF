import Foundation

/// Page marks: what the sheet's controls say, as the core's `marks.add`
/// reads it (`packages/core/warraq-core/src/tools/marks.rs`), the same
/// shape the desktop sends (`packages/ui/src/marks/markSpec.ts`).
///
/// The core draws every kind the same way — shaped, subset, tagged as a
/// pagination artifact, kept out of the page's own text — and resolves the
/// tokens (`{page}`, `{pages}`, `{file}`, `{date}`) page by page. The date
/// is written here, because the calendar is the interface's: Gregorian or
/// Hijri (Umm al-Qura), in Western or Arabic-Indic digits.
///
/// Kept apart from the sheet so it can be tested without one.
enum MarkSpec {
    /// Which kind of mark the form makes, as the core names it.
    enum Kind: String, CaseIterable, Identifiable, Sendable {
        case watermark
        case header
        case footer
        case pageNumber
        case bates

        var id: String { rawValue }

        var title: LocalizedStringResource {
            switch self {
            case .watermark: "Watermark"
            case .header: "Header"
            case .footer: "Footer"
            case .pageNumber: "Page number"
            case .bates: "Bates number"
            }
        }

        var symbol: String {
            switch self {
            case .watermark: "drop"
            case .header: "text.alignleft"
            case .footer: "text.alignleft"
            case .pageNumber: "number"
            case .bates: "number.square"
            }
        }
    }

    /// Where a mark sits on the page, as the core names it.
    enum Position: String, CaseIterable, Identifiable, Sendable {
        case topLeft, top, topRight, left, center, right, bottomLeft, bottom, bottomRight, tiled

        var id: String { rawValue }

        var title: LocalizedStringResource {
            switch self {
            case .topLeft: "Top left"
            case .top: "Top"
            case .topRight: "Top right"
            case .left: "Left"
            case .center: "Centre"
            case .right: "Right"
            case .bottomLeft: "Bottom left"
            case .bottom: "Bottom"
            case .bottomRight: "Bottom right"
            case .tiled: "Tiled"
            }
        }
    }

    /// How a page number reads.
    enum NumberFormat: String, CaseIterable, Identifiable, Sendable {
        case plain, ofTotal, pageOfEnglish, pageOfArabic, roman

        var id: String { rawValue }
    }

    /// Which digits the numbers are drawn in.
    enum Numerals: String, CaseIterable, Identifiable, Sendable {
        case western, arabic

        var id: String { rawValue }

        var title: LocalizedStringResource {
            switch self {
            case .western: "0123"
            case .arabic: "٠١٢٣"
            }
        }
    }

    /// Which calendar a `{date}` token is written in.
    enum Calendar: String, CaseIterable, Identifiable, Sendable {
        case gregorian, hijri

        var id: String { rawValue }

        var title: LocalizedStringResource {
            switch self {
            case .gregorian: "Gregorian"
            case .hijri: "Hijri"
            }
        }
    }

    /// Everything the sheet's controls hold, with the same defaults as the
    /// desktop's panel.
    struct Form: Equatable, Sendable {
        var kind: Kind = .watermark
        var watermarkText = ""
        var watermarkPosition: Position = .center
        var watermarkSize: Float = 72
        /// Degrees.
        var rotation: Float = 45
        /// Percent.
        var opacity: Float = 30
        var front = true
        var color = "#c0392b"
        /// Start, centre, end: "start" is the right-hand side in Arabic.
        var slots: [String] = ["", "", ""]
        var numberFormat: NumberFormat = .plain
        var numberPosition: Position = .bottom
        var startNumber = 1
        var skipFirst = false
        var batesPrefix = ""
        var batesSuffix = ""
        var batesStart = 1
        var batesDigits = 6
        var batesPosition: Position = .bottomRight
        var numerals: Numerals = .western
        var calendar: Calendar = .gregorian
        /// Points, for headers, footers, page numbers and Bates numbers.
        var size: Float = 10
        /// Points from the page's edges.
        var margin: Float = 36
        var font: EditFace = .amiri
        /// Which pages: empty is every page; otherwise "1-3, 5".
        var pages = ""

        /// Whether the form has anything to draw yet.
        var hasContent: Bool {
            switch kind {
            case .watermark:
                !watermarkText.trimmingCharacters(in: .whitespaces).isEmpty
            case .header, .footer:
                slots.contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            case .pageNumber, .bates:
                true
            }
        }
    }

    /// The tokens a header or footer can hold, in the order the sheet offers
    /// them.
    static let tokens = ["{page}", "{pages}", "{date}", "{file}"]

    /// The mark as `marks.add` reads it, encoded straight to JSON. Every
    /// value is a string, a number or a boolean, because that is all the
    /// core's spec holds and the file keeps it as sent.
    static func spec(of form: Form, fileName: String, now: Date, locale: Locale) -> [String: JSONValue] {
        var spec: [String: JSONValue] = [
            "kind": .string(form.kind.rawValue),
            "color": .string(hex(form.color)),
            "numerals": .string(form.numerals.rawValue),
            "marginX": .number(Double(form.margin)),
            "marginY": .number(Double(form.margin)),
            // Not the core's: kept in the file so a mark can be read back
            // into this sheet with the face and the calendar it was made with.
            "font": .string(form.font.rawValue),
            "modified": .string(pdfDate(now)),
        ]
        switch form.kind {
        case .watermark:
            spec["text"] = .string(form.watermarkText.trimmingCharacters(in: .whitespaces))
            spec["position"] = .string(form.watermarkPosition.rawValue)
            spec["size"] = .number(Double(form.watermarkSize))
            spec["rotation"] = .number(Double(form.rotation))
            // In Double, so the share the file keeps reads as 0.3 rather
            // than as a Float's nearest neighbour to it.
            spec["opacity"] = .number(min(1, max(0.05, Double(form.opacity) / 100)))
            spec["front"] = .bool(form.front)
        case .header, .footer:
            let arabic = form.numerals == .arabic || form.slots.contains(where: hasArabicLetter)
            spec["slots"] = .array(form.slots.map { .string($0) })
            spec["direction"] = .string("auto")
            spec["calendar"] = .string(form.calendar.rawValue)
            spec["date"] = .string(date(now, calendar: form.calendar, numerals: form.numerals, arabic: arabic))
            spec["fileName"] = .string(fileName)
            spec["size"] = .number(Double(form.size))
        case .pageNumber:
            spec["format"] = .string(form.numberFormat.rawValue)
            spec["position"] = .string(form.numberPosition.rawValue)
            spec["start"] = .number(Double(max(0, form.startNumber)))
            spec["skipFirst"] = .bool(form.skipFirst)
            spec["size"] = .number(Double(form.size))
        case .bates:
            spec["prefix"] = .string(form.batesPrefix)
            spec["suffix"] = .string(form.batesSuffix)
            spec["start"] = .number(Double(max(0, form.batesStart)))
            spec["width"] = .number(Double(min(20, max(1, form.batesDigits))))
            spec["position"] = .string(form.batesPosition.rawValue)
            spec["size"] = .number(Double(form.size))
        }
        return spec
    }

    /// `#rrggbb`, or black for anything else.
    static func hex(_ color: String) -> String {
        let lower = color.lowercased()
        guard lower.count == 7, lower.hasPrefix("#"),
              lower.dropFirst().allSatisfy({ $0.isHexDigit }) else { return "#000000" }
        return lower
    }

    static func hasArabicLetter(_ text: String) -> Bool {
        text.unicodeScalars.contains { EditModel.isRightToLeftScalar($0) && $0.properties.isAlphabetic }
    }

    /// Pages as typed — "1-3, 5, 8-" — as zero-based indices in order; an
    /// empty field is every page (`[]`). Nil when it does not read as pages
    /// of a file of `count` pages. Arabic-Indic and Persian digits and the
    /// Arabic comma are read too.
    static func pages(_ text: String, count: Int) -> [Int]? {
        let plain = westernDigits(text).trimmingCharacters(in: .whitespaces)
        if plain.isEmpty { return [] }
        var found = Set<Int>()
        for part in plain.split(separator: ",", omittingEmptySubsequences: false) {
            let piece = part.trimmingCharacters(in: .whitespaces)
            if piece.isEmpty { continue }
            let halves = piece.split(separator: "-", omittingEmptySubsequences: false).map {
                $0.trimmingCharacters(in: .whitespaces)
            }
            guard halves.count <= 2 else { return nil }
            let dash = piece.contains("-")
            let firstText = halves.first ?? ""
            let lastText = halves.count == 2 ? halves[1] : ""
            guard !firstText.isEmpty || !lastText.isEmpty else { return nil }
            guard firstText.allSatisfy(\.isNumber), lastText.allSatisfy(\.isNumber) else { return nil }
            let from = Int(firstText) ?? 1
            let to = dash ? (Int(lastText) ?? count) : from
            guard from >= 1, to <= count, from <= to else { return nil }
            for page in from...to { found.insert(page - 1) }
        }
        return found.isEmpty ? nil : found.sorted()
    }

    /// Western digits for Arabic-Indic and Persian ones, and a comma for the
    /// Arabic one.
    static func westernDigits(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.map { scalar in
            switch scalar.value {
            case 0x0660...0x0669: Unicode.Scalar(scalar.value - 0x0660 + 48) ?? scalar
            case 0x06F0...0x06F9: Unicode.Scalar(scalar.value - 0x06F0 + 48) ?? scalar
            case 0x060C: Unicode.Scalar(44)!
            default: scalar
            }
        }))
    }

    /// A date written in the chosen calendar and digits, in Arabic or English.
    static func date(_ date: Date, calendar: Calendar, numerals: Numerals, arabic: Bool) -> String {
        // The identifier carries both choices, as the desktop's `Intl` tag
        // does: the calendar and the digits, on the language the mark reads in.
        let language = arabic ? (calendar == .hijri ? "ar_SA" : "ar") : "en_GB"
        let extensions = "calendar=\(calendar == .hijri ? "islamic-umalqura" : "gregorian");numbers=\(numerals == .arabic ? "arab" : "latn")"
        let formatter = DateFormatter()
        formatter.locale = Foundation.Locale(identifier: "\(language)@\(extensions)")
        formatter.calendar = Foundation.Calendar(identifier: calendar == .hijri ? .islamicUmmAlQura : .gregorian)
        formatter.dateStyle = .long
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    /// A PDF date (`D:YYYYMMDDHHmmSSZ`), in UTC.
    static func pdfDate(_ date: Date) -> String {
        var calendar = Foundation.Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let p = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let two = { (n: Int?) in String(format: "%02d", n ?? 0) }
        return "D:\(p.year ?? 0)\(two(p.month))\(two(p.day))\(two(p.hour))\(two(p.minute))\(two(p.second))Z"
    }

    /// `n` in the chosen digits, as the core writes page numbers.
    static func inDigits(_ n: Int, _ numerals: Numerals) -> String {
        let plain = String(n)
        guard numerals == .arabic else { return plain }
        return String(String.UnicodeScalarView(plain.unicodeScalars.map {
            Unicode.Scalar($0.value - 48 + 0x0660) ?? $0
        }))
    }

    /// A Bates mark's first number as the core draws it: the start padded to
    /// its digits (always Western), between the prefix and the suffix.
    static func batesSample(_ form: Form) -> String {
        let width = min(20, max(1, form.batesDigits))
        let number = String(max(0, form.batesStart))
        let padded = String(repeating: "0", count: max(0, width - number.count)) + number
        return "\(form.batesPrefix)\(padded)\(form.batesSuffix)"
    }

    /// Pages as a person reads them: "1–3, 5". An empty list is every page,
    /// which the caller says in words instead.
    static func pagesLabel(_ pages: [Int]) -> String {
        var runs: [String] = []
        var start = -1
        var previous = -2
        func close() {
            guard start >= 0 else { return }
            runs.append(previous > start ? "\(start + 1)–\(previous + 1)" : "\(start + 1)")
        }
        for page in pages {
            if page != previous + 1 {
                close()
                start = page
            }
            previous = page
        }
        close()
        return runs.joined(separator: ", ")
    }
}

/// JSON as the core's specs hold it: a string, a number, a boolean or an
/// array of them. Encoded straight, so a mark goes into the file as the
/// interface described it and comes back the same.
enum JSONValue: Encodable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value):
            // A whole number is written whole: the core reads either, but a
            // spec kept in the file reads better as `10` than `10.0`.
            if value == value.rounded(), abs(value) < 1e15 {
                try container.encode(Int(value))
            } else {
                try container.encode(value)
            }
        case let .bool(value): try container.encode(value)
        case let .array(values): try container.encode(values)
        }
    }
}
