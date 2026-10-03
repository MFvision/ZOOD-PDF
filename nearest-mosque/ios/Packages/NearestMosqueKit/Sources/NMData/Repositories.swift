import Foundation
import GRDB
import NMCore

/// Outcome of a nearest-mosque query; every empty case is distinct.
public enum MosqueResult: Sendable {
    case found([RankedMosque], coverage: [String])
    case noRecordsInCoverage(String, radiusMeters: Double)
    case areaNotDownloaded(installed: [String])
}

public final class MosqueRepository: @unchecked Sendable {
    let db: AppDatabase
    public init(db: AppDatabase) { self.db = db }

    public func nearest(_ center: LatLng, radiusMeters: Double, lang: String) throws -> MosqueResult {
        let packs = try PackManager(db: db, bundledRoot: nil).installed().filter { $0.kind == "mosques" }
        guard !packs.isEmpty else { return .areaNotDownloaded(installed: []) }
        let box = Geo.boundingBox(center, radiusM: radiusMeters)
        let rows: [Mosque] = try db.writer.read { db in
            try box.longitudeRanges.flatMap { r in
                try Row.fetchAll(db, sql: "SELECT * FROM mosque WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?",
                                 arguments: [box.minLat, box.maxLat, r.lowerBound, r.upperBound]).compactMap(Self.mosque)
            }
        }
        let ranked = MosqueRanking.rank(center: center, candidates: rows, radiusMeters: radiusMeters)
        let covering = packs.filter { p in
            guard let b = p.manifest.coverage?.bbox else { return false }
            return (b.minLat...b.maxLat).contains(center.latitude) && (b.minLng...b.maxLng).contains(center.longitude)
        }
        func name(_ p: InstalledPack) -> String { p.manifest.coverage?.name ?? p.manifest.title(lang) }
        if !ranked.isEmpty { return .found(ranked, coverage: covering.map(name)) }
        if let c = covering.first { return .noRecordsInCoverage(name(c), radiusMeters: radiusMeters) }
        return .areaNotDownloaded(installed: packs.map(name))
    }

    public func byIds(_ ids: [String]) throws -> [Mosque] {
        guard !ids.isEmpty else { return [] }
        return try db.writer.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM mosque WHERE sourceId IN (\(ids.map { _ in "?" }.joined(separator: ",")))",
                             arguments: StatementArguments(ids)).compactMap(Self.mosque)
        }
    }

    public func favorites() throws -> Set<String> {
        try db.writer.read { db in Set(try String.fetchAll(db, sql: "SELECT sourceId FROM favorite")) }
    }

    public func setFavorite(_ id: String, _ on: Bool) throws {
        try db.writer.write { db in
            if on { try db.execute(sql: "INSERT OR REPLACE INTO favorite VALUES (?, ?)", arguments: [id, Date().timeIntervalSince1970]) }
            else { try db.execute(sql: "DELETE FROM favorite WHERE sourceId = ?", arguments: [id]) }
        }
    }

    static func mosque(_ r: Row) -> Mosque? {
        guard let loc = LatLng(r["lat"], r["lng"]) else { return nil }
        let names = (try? JSONDecoder().decode([String: String].self, from: Data((r["namesJson"] as String).utf8))) ?? [:]
        return Mosque(sourceId: r["sourceId"], packId: r["packId"], category: MosqueCategory(rawValue: r["category"]) ?? .mosque,
                      names: names, location: loc, address: r["address"], phone: r["phone"], website: r["website"],
                      openingHoursRaw: r["openingHoursRaw"], sourceTimestamp: r["sourceTimestamp"])
    }
}

/// FTS5 candidates for the retriever.
public final class GRDBChunkStore: ChunkStore, @unchecked Sendable {
    let db: AppDatabase
    public let totalChunks: Int
    public let averageLength: Double

    public init(db: AppDatabase) throws {
        self.db = db
        (totalChunks, averageLength) = try db.writer.read { db in
            (try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM source_chunk") ?? 0,
             try Double.fetchOne(db, sql: "SELECT COALESCE(AVG(tokenCount), 0) FROM source_chunk") ?? 0)
        }
    }

    static func quote(_ t: String) -> String { "\"" + t.replacingOccurrences(of: "\"", with: "") + "\"" }

    public func documentFrequency(_ term: String) -> Int {
        (try? db.writer.read { db in try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM source_chunk_fts WHERE source_chunk_fts MATCH ?", arguments: [Self.quote(term)]) }) ?? 0
    }

    public func candidates(_ terms: [String]) -> [CandidateChunk] {
        guard !terms.isEmpty else { return [] }
        let match = terms.map(Self.quote).joined(separator: " OR ")
        return (try? db.writer.read { db in
            try Row.fetchAll(db, sql: """
                SELECT c.id, c.seq, c.searchText FROM source_chunk c
                JOIN source_chunk_fts f ON f.rowid = c.rowid WHERE source_chunk_fts MATCH ?
                """, arguments: [match]).map { r in
                let text: String = r["searchText"]
                return CandidateChunk(id: r["id"], seq: r["seq"], tokens: text.isEmpty ? [] : text.split(separator: " ").map(String.init))
            }
        }) ?? []
    }
}

public struct ResolvedCitation: Identifiable, Sendable {
    public var id: String { chunk.id }
    public let chunk: SourceChunk
    public let packId: String
    public let documents: [String: SourceDocument]
}

public final class AskRepository: @unchecked Sendable {
    let db: AppDatabase
    let stopwords: [String: [String]]
    private var cache: (key: String, retriever: Retriever, questions: [CommonQuestion])?
    private let lock = NSLock()

    public init(db: AppDatabase, stopwords: [String: [String]]) { self.db = db; self.stopwords = stopwords }

    private func retriever() throws -> (Retriever, [CommonQuestion]) {
        lock.lock(); defer { lock.unlock() }
        let key = try db.writer.read { db in
            try String.fetchOne(db, sql: "SELECT group_concat(id || ':' || installedAt) FROM installed_pack WHERE kind = 'sources'") ?? ""
        }
        if let c = cache, c.key == key { return (c.retriever, c.questions) }
        let qs = try db.writer.read { db in
            try String.fetchAll(db, sql: "SELECT json FROM common_question ORDER BY packId, position")
        }.compactMap { try? JSONDecoder().decode(CommonQuestion.self, from: Data($0.utf8)) }
        let r = Retriever(store: try GRDBChunkStore(db: db), commonQuestions: qs, stopwords: stopwords)
        cache = (key, r, qs)
        return (r, qs)
    }

    public func commonQuestions() throws -> [CommonQuestion] { try retriever().1 }

    public func retrieve(_ q: String, context: [String] = []) throws -> RetrievalResult { try retriever().0.retrieve(q, context: context) }

    public func ask(_ q: String, context: [String] = []) throws -> Answer { AnswerComposer.compose(q, try retrieve(q, context: context)) }

    /// A tapped common question always shows that question's answer, plus extra passages found.
    public func answer(for q: CommonQuestion, displayed: String) throws -> Answer {
        var r = try retrieve(displayed)
        r.kind = .common
        r.commonQuestion = q
        return AnswerComposer.compose(displayed, r)
    }

    public func resolve(_ ids: [String]) throws -> [ResolvedCitation] {
        guard !ids.isEmpty else { return [] }
        return try db.writer.read { db in
            let docs = Dictionary(uniqueKeysWithValues: try String.fetchAll(db, sql: "SELECT json FROM source_document")
                .compactMap { try? JSONDecoder().decode(SourceDocument.self, from: Data($0.utf8)) }.map { ($0.id, $0) })
            let rows = try Row.fetchAll(db, sql: "SELECT id, packId, json FROM source_chunk WHERE id IN (\(ids.map { _ in "?" }.joined(separator: ",")))", arguments: StatementArguments(ids))
            let byId = Dictionary(uniqueKeysWithValues: rows.map { ($0["id"] as String, $0) })
            return ids.compactMap { id in
                guard let r = byId[id], let c = try? JSONDecoder().decode(SourceChunk.self, from: Data((r["json"] as String).utf8)) else { return nil }
                return ResolvedCitation(chunk: c, packId: r["packId"], documents: docs)
            }
        }
    }

    public func context(_ c: ResolvedCitation, around: Int = 3) throws -> [SourceChunk] {
        try db.writer.read { db in
            try String.fetchAll(db, sql: "SELECT json FROM source_chunk WHERE packId = ? AND seq BETWEEN ? AND ? ORDER BY seq",
                                arguments: [c.packId, c.chunk.seq - around, c.chunk.seq + around])
        }.compactMap { try? JSONDecoder().decode(SourceChunk.self, from: Data($0.utf8)) }
    }

    public static func parseStopwords(_ data: Data) -> [String: [String]] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj.filter { !$0.key.hasPrefix("_") }.compactMapValues { $0 as? [String] }
    }
}
