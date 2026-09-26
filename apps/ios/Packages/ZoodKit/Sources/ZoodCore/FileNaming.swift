import Foundation

/// File names the app writes (scans, compressed copies, extracted pages, combined files).
public enum FileNaming {
    /// Longest base name kept (in characters, before ".pdf").
    public static let maxBaseLength = 120

    /// Make a user- or document-supplied name safe to write:
    /// * bidi embedding/override/isolate controls (U+202A–202E, U+2066–2069) and LRM/RLM/ALM are
    ///   removed so a name cannot disguise its extension ("invoice\u{202E}fdp.exe");
    /// * control characters removed; path separators and ':' become '-';
    /// * leading/trailing spaces and dots trimmed; empty names become `fallback`.
    public static func sanitize(_ name: String, fallback: String = "Document") -> String {
        var scalars = String.UnicodeScalarView()
        for u in name.unicodeScalars {
            switch u.value {
            case 0x202A...0x202E, 0x2066...0x2069, 0x200E, 0x200F, 0x061C:
                continue
            case 0x00...0x1F, 0x7F:
                continue
            case 0x2F, 0x5C, 0x3A: // / \ :
                scalars.append("-")
            default:
                scalars.append(u)
            }
        }
        var s = String(scalars).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(["."]))
        if s.count > maxBaseLength { s = String(s.prefix(maxBaseLength)).trimmingCharacters(in: .whitespaces) }
        return s.isEmpty ? fallback : s
    }

    /// Base name without a trailing ".pdf" (any case).
    public static func baseName(_ fileName: String) -> String {
        if fileName.lowercased().hasSuffix(".pdf") { return String(fileName.dropLast(4)) }
        return fileName
    }

    /// Sanitised name with exactly one ".pdf".
    public static func pdfName(_ name: String, fallback: String = "Document") -> String {
        sanitize(baseName(name), fallback: fallback) + ".pdf"
    }

    /// "Report.pdf" + "compressed" → "Report (compressed).pdf". `suffix` is already localised.
    public static func derived(from original: String, suffix: String) -> String {
        let base = sanitize(baseName(original))
        return pdfName("\(base) (\(suffix))")
    }

    /// First name not in `existing` (compared case-insensitively): "Scan.pdf", "Scan 2.pdf", …
    public static func unique(_ name: String, existing: Set<String>) -> String {
        let taken = Set(existing.map { $0.lowercased() })
        if !taken.contains(name.lowercased()) { return name }
        let base = baseName(name)
        var n = 2
        while n < 10_000 {
            let candidate = "\(base) \(n).pdf"
            if !taken.contains(candidate.lowercased()) { return candidate }
            n += 1
        }
        return "\(base) \(UUID().uuidString.prefix(8)).pdf"
    }

    /// "Scan 2026-09-25 14.30.pdf". Digits stay ASCII so files sort the same in every locale;
    /// `prefix` is localised by the caller («مسح ضوئي» in Arabic).
    public static func scanName(prefix: String, date: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = timeZone
        f.dateFormat = "yyyy-MM-dd HH.mm"
        return pdfName("\(prefix) \(f.string(from: date))")
    }
}
