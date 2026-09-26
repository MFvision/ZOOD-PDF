import Foundation

/// A rectangle on a page in the engine's text coordinates: PDF points from the top-left of the
/// page's visible box (CropBox), y growing downwards, page rotation not applied.
public struct PageRect: Sendable, Equatable, Codable {
    public let x0: Double
    public let y0: Double
    public let x1: Double
    public let y1: Double

    public init(x0: Double, y0: Double, x1: Double, y1: Double) {
        self.x0 = min(x0, x1)
        self.y0 = min(y0, y1)
        self.x1 = max(x0, x1)
        self.y1 = max(y0, y1)
    }

    /// The same rectangle in PDF page space (origin bottom-left) for a page whose visible box
    /// starts at (`boxX`, `boxY`) with height `boxHeight` — what PDFKit's `PDFPage` uses.
    public func pdfRect(boxX: Double, boxY: Double, boxHeight: Double) -> (x: Double, y: Double, width: Double, height: Double) {
        (boxX + x0, boxY + boxHeight - y1, x1 - x0, y1 - y0)
    }
}

/// One paragraph of logical-order text from the engine (`text.extract`).
public struct TextParagraph: Sendable, Equatable {
    /// 0-based page index.
    public let page: Int
    public let text: String
    public let bbox: PageRect?
    public let rtl: Bool

    public init(page: Int, text: String, bbox: PageRect?, rtl: Bool) {
        self.page = page
        self.text = text
        self.bbox = bbox
        self.rtl = rtl
    }
}

/// One utterance: spoken with one voice, highlighted as one paragraph.
public struct ReadingUnit: Sendable, Equatable, Identifiable {
    public let id: Int
    /// 0-based page index.
    public let page: Int
    /// Index of the paragraph in the plan's input (units of one paragraph share it).
    public let paragraph: Int
    public let text: String
    public let language: ContentLanguage
    public let bbox: PageRect?
}

public enum ReadingPlanner {
    /// Split paragraphs into reading units: sentences grouped by language (so an English
    /// sentence inside an Arabic paragraph gets the English voice), at most `maxCharacters` per
    /// unit. Page numbers and other letterless lines are skipped; tatweel is removed and
    /// whitespace collapsed; tashkeel is kept (it helps pronunciation).
    public static func units(
        _ paragraphs: [TextParagraph], defaultLanguage: ContentLanguage, maxCharacters: Int = 600
    ) -> [ReadingUnit] {
        var out: [ReadingUnit] = []
        var last = defaultLanguage
        for (pi, p) in paragraphs.enumerated() {
            let clean = speakable(p.text)
            guard TextScript.dominantLanguage(clean) != nil else { continue }
            var current = ""
            var currentLanguage = last
            func flush() {
                let t = current.trimmingCharacters(in: .whitespaces)
                if !t.isEmpty {
                    out.append(ReadingUnit(id: out.count, page: p.page, paragraph: pi, text: t, language: currentLanguage, bbox: p.bbox))
                }
                current = ""
            }
            for sentence in DocumentChunker.sentences(clean) {
                for piece in DocumentChunker.split(sentence, limit: maxCharacters) {
                    let lang = TextScript.dominantLanguage(piece) ?? currentLanguage
                    if !current.isEmpty && (lang != currentLanguage || current.count + 1 + piece.count > maxCharacters) {
                        flush()
                    }
                    if current.isEmpty { currentLanguage = lang }
                    current += current.isEmpty ? piece : " " + piece
                }
            }
            flush()
            last = currentLanguage
        }
        return out
    }

    /// Text as it should be spoken.
    public static func speakable(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{0640}", with: "")
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
    }

    /// Paragraphs from page texts when no layout is available (a paragraph per line).
    public static func paragraphs(from pages: [PageContent]) -> [TextParagraph] {
        pages.flatMap { page in
            DocumentChunker.paragraphs(page.text).map {
                TextParagraph(page: page.index, text: $0, bbox: nil, rtl: TextScript.dominantLanguage($0) == .arabic)
            }
        }
    }

    /// The first unit on or after `page` (to start reading where the user is).
    public static func firstUnit(onOrAfter page: Int, in units: [ReadingUnit]) -> Int? {
        units.firstIndex { $0.page >= page }
    }
}

/// Voice quality as `AVSpeechSynthesisVoiceQuality` reports it.
public enum VoiceQuality: Int, Sendable, Comparable, Codable {
    case standard = 1, enhanced = 2, premium = 3
    public static func < (a: VoiceQuality, b: VoiceQuality) -> Bool { a.rawValue < b.rawValue }
}

/// What the app knows about an installed voice (from `AVSpeechSynthesisVoice`).
public struct VoiceInfo: Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    /// BCP-47, e.g. "en-US", "ar-SA".
    public let language: String
    public let quality: VoiceQuality
    /// Novelty voices (Bells, Whisper…) and Personal Voice are never picked automatically.
    public let isNovelty: Bool
    public let isPersonal: Bool

    public init(id: String, name: String, language: String, quality: VoiceQuality, isNovelty: Bool = false, isPersonal: Bool = false) {
        self.id = id
        self.name = name
        self.language = language
        self.quality = quality
        self.isNovelty = isNovelty
        self.isPersonal = isPersonal
    }
}

public enum VoiceRanker {
    /// Preferred regions: Saudi Arabic, US English.
    static let preferredRegion: [ContentLanguage: String] = [.arabic: "SA", .english: "US"]
    /// Voices known to sound good, a small tie-break only (quality always comes first).
    static let knownGood: Set<String> = ["ava", "zoe", "evan", "nathan", "samantha", "majed", "maged", "tarik", "laila", "hala"]

    /// Installed voices for `language`, best first: Premium > Enhanced > default, then the
    /// preferred region, then well-known voices. Novelty and Personal Voice are excluded.
    public static func ranked(_ voices: [VoiceInfo], for language: ContentLanguage) -> [VoiceInfo] {
        voices.filter { ContentLanguage(identifier: $0.language) == language && !$0.isNovelty && !$0.isPersonal }
            .sorted { a, b in
                let sa = score(a, language)
                let sb = score(b, language)
                return sa != sb ? sa > sb : a.name < b.name
            }
    }

    public static func best(_ voices: [VoiceInfo], for language: ContentLanguage) -> VoiceInfo? {
        ranked(voices, for: language).first
    }

    /// The saved choice if it is still installed, else the best voice.
    public static func resolve(savedID: String?, voices: [VoiceInfo], for language: ContentLanguage) -> VoiceInfo? {
        if let savedID, let v = voices.first(where: { $0.id == savedID }), ContentLanguage(identifier: v.language) == language {
            return v
        }
        return best(voices, for: language)
    }

    static func score(_ v: VoiceInfo, _ language: ContentLanguage) -> Int {
        var s = v.quality.rawValue * 100
        let region = v.language.split(whereSeparator: { $0 == "-" || $0 == "_" }).dropFirst().first.map(String.init)
        if let region, region.uppercased() == preferredRegion[language] { s += 20 }
        let first = v.name.lowercased().split(separator: " ").first.map(String.init) ?? ""
        if knownGood.contains(first) { s += 5 }
        return s
    }

    /// True when no Enhanced/Premium voice is installed (the picker then explains how to get one).
    public static func onlyStandard(_ voices: [VoiceInfo], for language: ContentLanguage) -> Bool {
        !ranked(voices, for: language).contains { $0.quality > .standard }
    }
}

/// Reading speed: the user picks a multiplier; `AVSpeechUtterance.rate` is not linear, so the
/// multiplier is mapped around the system default rate.
public enum SpeechRate {
    public static let choices: [Double] = [0.75, 1.0, 1.25, 1.5, 2.0]

    /// - Parameters: the AVFoundation constants (minimum 0, default 0.5, maximum 1 on iOS).
    public static func utteranceRate(multiplier: Double, minimum: Float = 0, normal: Float = 0.5, maximum: Float = 1) -> Float {
        let m = min(max(multiplier, 0.5), 2)
        let r: Float
        if m <= 1 {
            r = normal * Float(m)
        } else {
            // 2× maps to 70 % of the way from normal to maximum (the top of the range is unintelligible).
            r = normal + (maximum - normal) * 0.7 * Float(m - 1)
        }
        return min(max(r, minimum), maximum)
    }
}
