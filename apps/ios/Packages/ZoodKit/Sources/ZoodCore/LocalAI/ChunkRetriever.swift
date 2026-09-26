import Foundation

/// Picks the parts of a document that fit a small on-device model's context.
///
/// Questions use BM25 over Arabic-normalised terms (the search rules of `SearchNormalizer`,
/// plus light prefix/suffix stripping so «والعقد» finds «العقد» and «عقود» is not needed);
/// whole-document tasks take chunks spread evenly over the document.
public enum ChunkRetriever {
    /// Terms of `text`: normalised (tashkeel, alef/yaa/taa marbuta forms, digits, case),
    /// split on anything that is not a letter or digit, stop words removed, lightly stemmed.
    public static func terms(_ text: String) -> [String] {
        let normalized = SearchNormalizer.normalize(text)
        var out: [String] = []
        var word = ""
        func flush() {
            if !word.isEmpty {
                let s = stem(word)
                if s.count >= 2 && !stopWords.contains(s) && !stopWords.contains(word) { out.append(s) }
                word = ""
            }
        }
        for ch in normalized {
            if ch.isLetter || ch.isNumber { word.append(ch) } else { flush() }
        }
        flush()
        return out
    }

    /// Light stemmer: Arabic conjunction/preposition + article prefixes and common suffixes;
    /// English plural "s". Keeps at least three letters of the word.
    static func stem(_ w: String) -> String {
        var s = w
        let arabic = s.unicodeScalars.contains(where: TextScript.isArabicLetter)
        if arabic {
            for p in ["وال", "بال", "كال", "فال", "لل", "ال"] where s.hasPrefix(p) && s.count - p.count >= 3 {
                s.removeFirst(p.count)
                break
            }
            if s.count >= 5, let f = s.first, "وفب".contains(f) { s.removeFirst() }
            for suf in ["ات", "ون", "ين", "ها", "هم", "ه", "ي"] where s.hasSuffix(suf) && s.count - suf.count >= 3 {
                s.removeLast(suf.count)
                break
            }
        } else if s.count > 3, s.hasSuffix("s"), !s.hasSuffix("ss") {
            s.removeLast()
        }
        return s
    }

    static let stopWords: Set<String> = [
        // English
        "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "what",
        "which", "who", "how", "when", "where", "why", "this", "that", "these", "those", "it", "its", "with",
        "as", "by", "at", "from", "does", "do", "did", "about", "there", "can", "document", "pdf",
        // Arabic (normalised forms)
        "في", "من", "الي", "علي", "عن", "ما", "ماذا", "هل", "هو", "هي", "هذا", "هذه", "ذلك", "تلك", "التي",
        "الذي", "ان", "او", "و", "ثم", "كيف", "متي", "اين", "لماذا", "كم", "مع", "كل", "قد", "لا", "لم", "لن",
        "المستند", "الملف",
    ]

    /// BM25 scores of every chunk for `query` (0 when no term matches).
    public static func scores(query: String, chunks: [TextChunk]) -> [Double] {
        let q = Array(Set(terms(query)))
        guard !q.isEmpty, !chunks.isEmpty else { return Array(repeating: 0, count: chunks.count) }
        let docs = chunks.map { terms($0.text) }
        let avg = max(Double(docs.reduce(0) { $0 + $1.count }) / Double(docs.count), 1)
        var df: [String: Int] = [:]
        for d in docs {
            for t in Set(d) where q.contains(t) { df[t, default: 0] += 1 }
        }
        let n = Double(docs.count)
        let k1 = 1.2
        let b = 0.75
        return docs.map { d in
            var tf: [String: Int] = [:]
            for t in d where df[t] != nil { tf[t, default: 0] += 1 }
            var score = 0.0
            for t in q {
                guard let f = tf[t], let nq = df[t] else { continue }
                let idf = log(1 + (n - Double(nq) + 0.5) / (Double(nq) + 0.5))
                let ff = Double(f)
                let lengthRatio: Double = Double(d.count) / avg
                let norm: Double = k1 * (1 - b + b * lengthRatio)
                let gain: Double = ff * (k1 + 1) / (ff + norm)
                score += idf * gain
            }
            return score
        }
    }

    /// Best chunks for a question within `budget` characters, returned in document order.
    /// When nothing matches, the start of the document is used.
    public static func forQuestion(_ query: String, chunks: [TextChunk], budget: Int) -> [TextChunk] {
        let s = scores(query: query, chunks: chunks)
        let ranked = chunks.indices.filter { s[$0] > 0 }.sorted { s[$0] != s[$1] ? s[$0] > s[$1] : $0 < $1 }
        guard !ranked.isEmpty else { return leading(chunks, budget: budget) }
        var picked: [Int] = []
        var used = 0
        for i in ranked {
            let c = chunks[i].text.count
            if used + c > budget { continue }
            picked.append(i)
            used += c
        }
        if picked.isEmpty, let first = ranked.first {
            // One oversized chunk: cut it rather than send nothing.
            let c = chunks[first]
            return [TextChunk(id: c.id, page: c.page, text: String(c.text.prefix(budget)))]
        }
        return picked.sorted().map { chunks[$0] }
    }

    /// Chunks from the start of the document within `budget`.
    public static func leading(_ chunks: [TextChunk], budget: Int) -> [TextChunk] {
        var out: [TextChunk] = []
        var used = 0
        for c in chunks {
            if used + c.text.count > budget {
                if out.isEmpty { out.append(TextChunk(id: c.id, page: c.page, text: String(c.text.prefix(budget)))) }
                break
            }
            out.append(c)
            used += c.text.count
        }
        return out
    }

    /// Chunks spread evenly over the whole document within `budget` (for summaries and key
    /// points of documents longer than the context). Everything when it fits.
    public static func spread(_ chunks: [TextChunk], budget: Int) -> [TextChunk] {
        let total = chunks.reduce(0) { $0 + $1.text.count }
        if total <= budget { return chunks }
        guard !chunks.isEmpty else { return [] }
        let average = max(total / chunks.count, 1)
        let count = max(1, min(chunks.count, budget / average))
        var picked: [Int] = []
        var used = 0
        for k in 0..<count {
            let i = Int((Double(k) * Double(chunks.count) / Double(count)).rounded(.down))
            let c = chunks[i].text.count
            if used + c > budget { continue }
            picked.append(i)
            used += c
        }
        if picked.isEmpty { return leading(chunks, budget: budget) }
        return picked.map { chunks[$0] }
    }
}
