/// Page-range fields ("1-3, 5, 8-") as typed in the Extract / Delete sheets.
///
/// Input is 1-based as users see it; output is the engine's 0-based indices in the order typed,
/// without duplicates. Accepts ASCII, Arabic-Indic and Persian digits; the Arabic comma «،»,
/// commas, semicolons and spaces as separators; hyphen, en dash, em dash or minus as range marks
/// (with or without spaces around them); and an open end "8-" meaning "to the last page".
public enum PageRanges {
    public enum ParseError: Error, Equatable, Sendable {
        case empty
        case invalid(String)
        case outOfRange(page: Int, pageCount: Int)
        case reversed(String)
    }

    public static func parse(_ text: String, pageCount: Int) throws(ParseError) -> [Int] {
        let tokens = tokenize(SearchNormalizer.normalizeDigits(text))
        guard !tokens.isEmpty else { throw .empty }
        var seen = Set<Int>()
        var out: [Int] = []
        for token in tokens {
            let parts = token.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
            let lo: Int
            let hi: Int
            switch parts.count {
            case 1:
                guard let n = Int(parts[0]) else { throw .invalid(token) }
                (lo, hi) = (n, n)
            case 2:
                guard let a = Int(parts[0]) else { throw .invalid(token) }
                if parts[1].isEmpty {
                    (lo, hi) = (a, pageCount)
                } else {
                    guard let b = Int(parts[1]) else { throw .invalid(token) }
                    (lo, hi) = (a, b)
                }
            default:
                throw .invalid(token)
            }
            guard lo >= 1, lo <= pageCount else { throw .outOfRange(page: lo, pageCount: pageCount) }
            guard hi >= 1, hi <= pageCount else { throw .outOfRange(page: hi, pageCount: pageCount) }
            guard lo <= hi else { throw .reversed(token) }
            // Bounded by pageCount, which the engine already bounds (warraq_pdf::limits).
            for p in lo...hi where seen.insert(p - 1).inserted {
                out.append(p - 1)
            }
        }
        return out
    }

    /// Compact 1-based display form of 0-based indices: [0, 1, 2, 4] → "1-3, 5".
    public static func format(_ indices: [Int]) -> String {
        let sorted = Array(Set(indices)).sorted()
        var parts: [String] = []
        var i = 0
        while i < sorted.count {
            var j = i
            while j + 1 < sorted.count, sorted[j + 1] == sorted[j] + 1 { j += 1 }
            parts.append(i == j ? "\(sorted[i] + 1)" : "\(sorted[i] + 1)-\(sorted[j] + 1)")
            i = j + 1
        }
        return parts.joined(separator: ", ")
    }

    /// Split on separators, gluing "3 - 5" back into "3-5".
    static func tokenize(_ s: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var pendingDash = false
        func flush() {
            if !current.isEmpty { tokens.append(current) }
            current = ""
        }
        for ch in s {
            if ch == "-" {
                if current.isEmpty, let last = tokens.last, !last.contains("-") {
                    // "3 -5" / "3 - 5": the dash belongs to the previous token.
                    current = tokens.removeLast()
                }
                current.append("-")
                pendingDash = true
            } else if ch == "," || ch == "\u{060C}" || ch == ";" {
                flush()
                pendingDash = false
            } else if ch.isWhitespace {
                if !pendingDash { flush() }
            } else {
                current.append(ch)
                pendingDash = false
            }
        }
        flush()
        return tokens
    }
}

extension SearchNormalizer {
    /// Arabic-Indic / Persian digits → ASCII and every dash form → "-"; nothing else changes.
    public static func normalizeDigits(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for u in text.unicodeScalars {
            switch u.value {
            case 0x0660...0x0669: out.append(Unicode.Scalar(UInt8(u.value - 0x0660 + 0x30)))
            case 0x06F0...0x06F9: out.append(Unicode.Scalar(UInt8(u.value - 0x06F0 + 0x30)))
            case 0x2010...0x2015, 0x2212: out.append("-")
            default: out.append(u)
            }
        }
        return String(out)
    }
}
