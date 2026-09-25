/// Arabic-aware search normalisation. Mirrors `normalizeForSearch` in
/// `packages/ui/src/services/recents.ts` (and the engine's search rules) so that a query typed
/// on iOS finds exactly what it finds on the web:
///
/// * tashkeel (U+0610–061A, U+064B–065F, U+0670, U+06D6–06ED) and tatweel (U+0640) are dropped;
/// * alef forms آ أ إ ٱ → ا, alef maksura ى → ي, taa marbuta ة → ه;
/// * Arabic-Indic (٠–٩) and Persian (۰–۹) digits → ASCII;
/// * lower-cased.
public enum SearchNormalizer {
    public static func normalize(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for u in text.unicodeScalars {
            switch u.value {
            case 0x0610...0x061A, 0x064B...0x065F, 0x0670, 0x06D6...0x06ED, 0x0640:
                continue
            case 0x0622, 0x0623, 0x0625, 0x0671:
                out.append("\u{0627}")
            case 0x0649:
                out.append("\u{064A}")
            case 0x0629:
                out.append("\u{0647}")
            case 0x0660...0x0669:
                out.append(Unicode.Scalar(UInt8(u.value - 0x0660 + 0x30)))
            case 0x06F0...0x06F9:
                out.append(Unicode.Scalar(UInt8(u.value - 0x06F0 + 0x30)))
            default:
                out.append(u)
            }
        }
        return String(out).lowercased()
    }

    /// Whitespace-separated query terms after normalisation.
    public static func terms(_ query: String) -> [String] {
        normalize(query).split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// True when every term of `query` occurs in at least one of `fields` (the web rule).
    /// An empty query matches nothing.
    public static func matches(query: String, fields: [String]) -> Bool {
        let t = terms(query)
        guard !t.isEmpty else { return false }
        let hay = normalize(fields.joined(separator: " "))
        return t.allSatisfy { hay.contains($0) }
    }
}
