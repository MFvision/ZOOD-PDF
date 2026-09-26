import Foundation

/// A model answer split into text and tappable page citations.
public enum AnswerSegment: Equatable, Sendable {
    case text(String)
    /// 1-based page numbers, each within the document.
    case citation([Int])
}

/// Finds page citations in answers: `[p. 3]`, `[p.3, 5]`, `[pp. 2-4]`, `(page 7)`, `[ص ٣]`,
/// `[صفحة 4]`, `[الصفحة ٢]`. Numbers may use Arabic-Indic digits. Citations of pages that do not
/// exist stay plain text (a small model can invent page numbers).
public enum CitationParser {
    static let prefixes = ["pages", "page", "pp.", "pp", "p.", "p", "الصفحات", "الصفحة", "صفحة", "ص."]
    static let arabicShort = "ص"

    public static func parse(_ answer: String, pageCount: Int) -> [AnswerSegment] {
        var out: [AnswerSegment] = []
        var text = ""
        let chars = Array(answer)
        var i = 0
        while i < chars.count {
            let open = chars[i]
            if open == "[" || open == "(" {
                let close: Character = open == "[" ? "]" : ")"
                if let end = chars[(i + 1)...].prefix(40).firstIndex(of: close) {
                    let inner = String(chars[(i + 1)..<end])
                    if let pages = pagesIn(inner, pageCount: pageCount) {
                        if !text.isEmpty { out.append(.text(text)); text = "" }
                        out.append(.citation(pages))
                        i = end + 1
                        continue
                    }
                }
            }
            text.append(open)
            i += 1
        }
        if !text.isEmpty { out.append(.text(text)) }
        return out
    }

    /// Pages named by the inside of a bracket, or nil when it is not a (valid) citation.
    static func pagesIn(_ inner: String, pageCount: Int) -> [Int]? {
        var s = SearchNormalizer.normalize(inner).trimmingCharacters(in: .whitespaces)
        var matched = false
        for p in prefixes.map(SearchNormalizer.normalize) where s.hasPrefix(p) {
            s.removeFirst(p.count)
            matched = true
            break
        }
        if !matched, s.hasPrefix(arabicShort) {
            s.removeFirst()
            matched = true
        }
        guard matched else { return nil }
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: " .:"))
        guard let first = s.first, first.isASCII, first.isNumber else { return nil }
        var pages: [Int] = []
        let parts = s.replacingOccurrences(of: "،", with: ",")
            .replacingOccurrences(of: " and ", with: ",")
            .replacingOccurrences(of: " و", with: ",")
            .split(separator: ",")
        for part in parts {
            let range = part.split(whereSeparator: { $0 == "-" || $0 == "–" }).map {
                $0.trimmingCharacters(in: .whitespaces)
            }
            let nums = range.compactMap { Int($0) }
            guard nums.count == range.count, (1...2).contains(nums.count) else { return nil }
            let lo = nums[0]
            let hi = nums.count == 2 ? nums[1] : nums[0]
            guard lo >= 1, hi >= lo, hi - lo <= 50 else { return nil }
            pages.append(contentsOf: lo...hi)
        }
        guard !pages.isEmpty, pages.allSatisfy({ $0 <= pageCount }) else { return nil }
        var seen = Set<Int>()
        return pages.filter { seen.insert($0).inserted }
    }
}
