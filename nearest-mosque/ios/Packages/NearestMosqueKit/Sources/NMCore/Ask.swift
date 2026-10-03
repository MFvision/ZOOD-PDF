import Foundation

public struct TextPart: Codable, Hashable, Sendable { public let docId: String; public let lang: String; public let text: String }

public struct ChunkSection: Codable, Hashable, Sendable {
    public var surah: Int?
    public var ayah: Int?
    public var nameAr: String?
    public var nameTranslit: String?
    public var nameEn: String?
}

/// One JSON line of a book pack (tools/build_quran_pack.py). Anchors are stable across versions.
public struct SourceChunk: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let seq: Int
    public let anchor: String
    public var section: ChunkSection?
    public let original: TextPart
    public var translations: [TextPart]?
    public var url: String?

    public var allTranslations: [TextPart] { translations ?? [] }
    public func searchText() -> String {
        TextNormalizer.searchText(original.text + " " + allTranslations.map(\.text).joined(separator: " "))
    }
}

public struct SourceDocument: Codable, Hashable, Sendable {
    public let id: String
    public let kind: String
    public let title: [String: String]
    public var edition: String?
    public var publisher: String?
    public var translator: String?
    public var year: Int?
    public let language: String
    public var url: String?
    public var retrievedAt: String?
}

public struct CommonQuestion: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let citations: [String]
    public let reviewStatus: String
    public var reviewedBy: String?
    public var reviewedAt: String?
    public let question: [String: String]
    public let summary: [String: String]
    public var triggers: [String: [String]]?
    public var expansion: [String]?

    public var isReviewed: Bool { reviewStatus == "reviewed" && !(reviewedBy ?? "").isEmpty }
}

public struct CommonQuestionsFile: Codable, Sendable { public let schemaVersion: Int; public let packId: String; public let questions: [CommonQuestion] }

public struct CandidateChunk: Sendable {
    public let id: String; public let seq: Int; public let tokens: [String]
    public init(id: String, seq: Int, tokens: [String]) { self.id = id; self.seq = seq; self.tokens = tokens }
}

/// Full-text candidates for retrieval (GRDB FTS5 in the app, in memory in tests).
public protocol ChunkStore: Sendable {
    var totalChunks: Int { get }
    var averageLength: Double { get }
    func documentFrequency(_ term: String) -> Int
    func candidates(_ terms: [String]) -> [CandidateChunk]
}

public final class InMemoryChunkStore: ChunkStore, @unchecked Sendable {
    private let items: [CandidateChunk]
    private var df: [String: Int] = [:]
    public let totalChunks: Int
    public let averageLength: Double

    public init(_ chunks: [SourceChunk]) {
        items = chunks.map { CandidateChunk(id: $0.id, seq: $0.seq, tokens: TextNormalizer.tokens($0.original.text + " " + $0.allTranslations.map(\.text).joined(separator: " "))) }
        for c in items { for t in Set(c.tokens) { df[t, default: 0] += 1 } }
        totalChunks = items.count
        averageLength = items.isEmpty ? 0 : Double(items.reduce(0) { $0 + $1.tokens.count }) / Double(items.count)
    }

    public func documentFrequency(_ term: String) -> Int { df[term] ?? 0 }
    public func candidates(_ terms: [String]) -> [CandidateChunk] {
        let set = Set(terms)
        return items.filter { $0.tokens.contains(where: set.contains) }
    }
}

public struct ScoredPassage: Hashable, Sendable { public let chunkId: String; public let score: Double; public let coverage: Double }
public enum AnswerKind: String, Sendable { case common, passages, insufficient }

public struct RetrievalResult: Sendable {
    public var kind: AnswerKind
    public var commonQuestion: CommonQuestion?
    public let passages: [ScoredPassage]
    public let contentTerms: [String]
}

/// Cited retrieval with evidence gates (parameters fixed by shared/fixtures/retrieval.json).
public final class Retriever: @unchecked Sendable {
    public static let k1 = 1.2, b = 0.75, expansionWeight = 0.5, contextWeight = 0.3
    public static let maxPassages = 5, minScore = 3.0, minCoverage = 0.5, coordBase = 0.0

    struct Prepared { let q: CommonQuestion; let triggers: [[String]]; let questions: [Set<String>]; let expansion: [String] }
    private let store: ChunkStore
    private let prepared: [Prepared]
    private let stop: Set<String>

    public init(store: ChunkStore, commonQuestions: [CommonQuestion], stopwords: [String: [String]]) {
        self.store = store
        self.prepared = commonQuestions.map { q in
            Prepared(
                q: q,
                triggers: (q.triggers ?? [:]).keys.sorted().flatMap { q.triggers![$0]! }.map(TextNormalizer.tokens).filter { !$0.isEmpty },
                questions: q.question.values.map { Set(TextNormalizer.tokens($0)) },
                expansion: (q.expansion ?? []).flatMap(TextNormalizer.tokens)
            )
        }
        self.stop = Set(stopwords.filter { !$0.key.hasPrefix("_") }.values.flatMap { $0 }.flatMap(TextNormalizer.tokens))
    }

    public func retrieve(_ question: String, context: [String] = []) -> RetrievalResult {
        let tokens = TextNormalizer.tokens(question)
        var seen = Set<String>()
        let content = tokens.filter { !stop.contains($0) && seen.insert($0).inserted }
        let faq = matchQuestion(tokens)
        var weights: [String: Double] = [:]
        var order: [String] = []
        func put(_ t: String, _ w: Double) { if weights[t] == nil { weights[t] = w; order.append(t) } }
        content.forEach { put($0, 1) }
        faq?.expansion.forEach { put($0, Retriever.expansionWeight) }
        if content.count < 4 {
            for prev in context { TextNormalizer.tokens(prev).filter { !stop.contains($0) }.forEach { put($0, Retriever.contextWeight) } }
        }
        let passages = weights.isEmpty ? [] : score(weights, order, content)
        let kind: AnswerKind = faq != nil ? .common : (passages.isEmpty ? .insufficient : .passages)
        return RetrievalResult(kind: kind, commonQuestion: faq?.q, passages: passages, contentTerms: content)
    }

    private func score(_ weights: [String: Double], _ order: [String], _ content: [String]) -> [ScoredPassage] {
        let n = Double(store.totalChunks)
        guard n > 0 else { return [] }
        let avgdl = store.averageLength
        var idf: [String: Double] = [:]
        for t in order {
            let df = Double(store.documentFrequency(t))
            idf[t] = log(1 + (n - df + 0.5) / (df + 0.5))
        }
        struct S { let id: String; let seq: Int; let score: Double; let coverage: Double; let matched: Int }
        let scored: [S] = store.candidates(order).compactMap { c in
            var tf: [String: Int] = [:]
            for t in c.tokens where weights[t] != nil { tf[t, default: 0] += 1 }
            guard !tf.isEmpty else { return nil }
            let dl = Double(c.tokens.count)
            var s = 0.0
            for (t, f) in tf {
                let fd = Double(f)
                s += weights[t]! * idf[t]! * fd * (Retriever.k1 + 1) / (fd + Retriever.k1 * (1 - Retriever.b + Retriever.b * dl / avgdl))
            }
            let matched = content.filter { tf[$0] != nil }.count
            let coverage = content.isEmpty ? 0 : Double(matched) / Double(content.count)
            // Coordination factor: passages containing more of the question's own words rank higher.
            if !content.isEmpty { s *= Retriever.coordBase + (1 - Retriever.coordBase) * coverage }
            return S(id: c.id, seq: c.seq, score: s, coverage: coverage, matched: matched)
        }.sorted { ($0.score, -$0.seq) > ($1.score, -$1.seq) }
        return scored.filter { $0.score >= Retriever.minScore && ($0.coverage >= Retriever.minCoverage || $0.matched >= 2) }
            .prefix(Retriever.maxPassages)
            .map { ScoredPassage(chunkId: $0.id, score: $0.score, coverage: $0.coverage) }
    }

    private func matchQuestion(_ tokens: [String]) -> Prepared? {
        let qset = Set(tokens)
        var best: Prepared?
        var bestHits = 0, bestJac = 0.0
        for p in prepared {
            let hits = p.triggers.filter { containsPhrase(tokens, $0) }.count
            let jac = p.questions.map { s -> Double in
                let union = qset.union(s).count
                return union == 0 ? 0 : Double(qset.intersection(s).count) / Double(union)
            }.max() ?? 0
            if hits == 0 && jac < 0.6 { continue }
            if hits > bestHits || (hits == bestHits && jac > bestJac) { best = p; bestHits = hits; bestJac = jac }
        }
        return best
    }

    private func containsPhrase(_ tokens: [String], _ phrase: [String]) -> Bool {
        if phrase.count == 1 {
            let p = phrase[0]
            if TextNormalizer.containsArabicLetter(p) && p.unicodeScalars.count >= 4 { return tokens.contains { $0.contains(p) } }
            return tokens.contains(p)
        }
        guard tokens.count >= phrase.count else { return false }
        for i in 0...(tokens.count - phrase.count) where Array(tokens[i..<(i + phrase.count)]) == phrase { return true }
        return false
    }
}

/// A composed answer: references to stored passages plus an optional editorial or on-device text.
public struct Answer: Sendable {
    public let question: String
    public let kind: AnswerKind
    public let commonQuestion: CommonQuestion?
    public let citations: [String]
    public let related: [String]
    /// Written on-device from the cited passages only (validated), or nil.
    public var generated: String?
}

public enum AnswerComposer {
    public static func compose(_ question: String, _ r: RetrievalResult) -> Answer {
        let ids = r.passages.map(\.chunkId)
        switch r.kind {
        case .common:
            let cites = r.commonQuestion!.citations
            return Answer(question: question, kind: .common, commonQuestion: r.commonQuestion, citations: cites, related: Array(ids.filter { !cites.contains($0) }.prefix(3)))
        case .passages:
            return Answer(question: question, kind: .passages, commonQuestion: nil, citations: Array(ids.prefix(3)), related: Array(ids.dropFirst(3)))
        case .insufficient:
            return Answer(question: question, kind: .insufficient, commonQuestion: nil, citations: [], related: [])
        }
    }

    /// Accept generated prose only if every paragraph cites at least one supplied passage as [n].
    public static func validateGenerated(_ text: String, passageCount: Int) -> Bool {
        let paragraphs = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !paragraphs.isEmpty, passageCount > 0 else { return false }
        let pattern = try! NSRegularExpression(pattern: "\\[(\\d+)\\]")
        for p in paragraphs {
            let ns = p as NSString
            let refs = pattern.matches(in: p, range: NSRange(location: 0, length: ns.length)).compactMap { Int(ns.substring(with: $0.range(at: 1))) }
            if refs.isEmpty || refs.contains(where: { $0 < 1 || $0 > passageCount }) { return false }
        }
        return true
    }
}
