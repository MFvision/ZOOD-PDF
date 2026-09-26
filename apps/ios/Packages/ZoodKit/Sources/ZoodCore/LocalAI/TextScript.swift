import Foundation

/// The two languages the app reads, answers and speaks in. Anything that is not Arabic script is
/// treated as English (Latin letters, digits-only text follows its neighbours).
public enum ContentLanguage: String, Sendable, Codable, CaseIterable {
    case arabic = "ar"
    case english = "en"

    /// Name used inside model instructions.
    public var englishName: String { self == .arabic ? "Arabic" : "English" }

    /// The other language (translation target).
    public var other: ContentLanguage { self == .arabic ? .english : .arabic }

    /// From a locale or BCP-47 identifier ("ar-SA", "en_US"); nil for other languages.
    public init?(identifier: String) {
        let code = identifier.lowercased().prefix { $0.isLetter }
        switch code {
        case "ar": self = .arabic
        case "en": self = .english
        default: return nil
        }
    }
}

/// Script statistics used to pick a voice, a model and a translation direction.
public enum TextScript {
    public static func isArabicLetter(_ u: Unicode.Scalar) -> Bool {
        switch u.value {
        case 0x0621...0x064A, 0x066E...0x06D3, 0x06D5, 0x06EE...0x06FF, 0x0750...0x077F,
             0x08A0...0x08FF, 0xFB50...0xFDFF, 0xFE70...0xFEFC:
            return true
        default:
            return false
        }
    }

    public static func isLatinLetter(_ u: Unicode.Scalar) -> Bool {
        switch u.value {
        case 0x41...0x5A, 0x61...0x7A, 0xC0...0x24F:
            return u.value != 0xD7 && u.value != 0xF7
        default:
            return false
        }
    }

    /// Counts of Arabic and Latin letters.
    public static func letterCounts(_ text: String) -> (arabic: Int, latin: Int) {
        var a = 0
        var l = 0
        for u in text.unicodeScalars {
            if isArabicLetter(u) { a += 1 } else if isLatinLetter(u) { l += 1 }
        }
        return (a, l)
    }

    /// The dominant language, or nil when the text has no letters (numbers, punctuation).
    public static func dominantLanguage(_ text: String) -> ContentLanguage? {
        let c = letterCounts(text)
        if c.arabic == 0 && c.latin == 0 { return nil }
        return c.arabic >= c.latin ? .arabic : .english
    }
}
