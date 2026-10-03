import Foundation
import GRDB
import NMCore

public struct InstalledPack: Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let version: Int
    public let manifest: PackManifest
    public let recordCount: Int
    public let bytes: Int
    public let builtin: Bool
}

/// Installs data packs atomically: hashes first, then one SQLite transaction replaces the pack's
/// rows. A failure at any point leaves the previous version installed.
public final class PackManager: @unchecked Sendable {
    let db: AppDatabase
    /// Folder containing cities/, mosques/<id>/, sources/<id>/ (the app bundle's "packs" folder).
    public let bundledRoot: URL?
    let defaults: UserDefaults
    static let removedKey = "removedBuiltinPacks"

    public init(db: AppDatabase, bundledRoot: URL?, defaults: UserDefaults = .standard) {
        self.db = db; self.bundledRoot = bundledRoot; self.defaults = defaults
    }

    public func bundledManifests() -> [(URL, PackManifest)] {
        guard let root = bundledRoot else { return [] }
        let fm = FileManager.default
        return ["mosques", "sources"].flatMap { kind -> [(URL, PackManifest)] in
            let dir = root.appendingPathComponent(kind)
            let names = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
            return names.sorted().compactMap { name in
                let d = dir.appendingPathComponent(name)
                guard let data = try? Data(contentsOf: d.appendingPathComponent("manifest.json")),
                      let m = try? PackVerifier.parseManifest(data) else { return nil }
                return (d, m)
            }
        }
    }

    public func citiesManifest() -> PackManifest? {
        guard let root = bundledRoot, let data = try? Data(contentsOf: root.appendingPathComponent("cities/manifest.json")) else { return nil }
        return try? PackVerifier.parseManifest(data)
    }

    public func installed() throws -> [InstalledPack] {
        try db.writer.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM installed_pack ORDER BY kind, id").compactMap { r in
                guard let m = try? JSONDecoder().decode(PackManifest.self, from: Data((r["manifestJson"] as String).utf8)) else { return nil }
                return InstalledPack(id: r["id"], kind: r["kind"], version: r["version"], manifest: m, recordCount: r["recordCount"], bytes: r["bytes"], builtin: r["builtin"])
            }
        }
    }

    /// Installs missing or older bundled packs unless the user removed them. Returns failed ids.
    @discardableResult
    public func ensureBuiltins() -> [String] {
        let removed = Set(defaults.stringArray(forKey: Self.removedKey) ?? [])
        let current = Dictionary(uniqueKeysWithValues: ((try? installed()) ?? []).map { ($0.id, $0.version) })
        var failed: [String] = []
        for (dir, m) in bundledManifests() where !removed.contains(m.id) {
            if let v = current[m.id], v >= m.version { continue }
            do { try install(m, builtin: true) { try? Data(contentsOf: dir.appendingPathComponent($0)) } } catch { failed.append(m.id) }
        }
        return failed
    }

    public func restoreBuiltins() {
        defaults.removeObject(forKey: Self.removedKey)
        ensureBuiltins()
    }

    public func remove(_ id: String) throws {
        try db.writer.write { db in
            for table in ["mosque", "source_chunk", "source_document", "common_question"] {
                try db.execute(sql: "DELETE FROM \(table) WHERE packId = ?", arguments: [id])
            }
            try db.execute(sql: "DELETE FROM installed_pack WHERE id = ?", arguments: [id])
        }
        if bundledManifests().contains(where: { $0.1.id == id }) {
            defaults.set(Array(Set(defaults.stringArray(forKey: Self.removedKey) ?? []).union([id])), forKey: Self.removedKey)
        }
    }

    /// Install a pack from an unpacked folder chosen by the user (Files app). Hash-verified.
    @discardableResult
    public func importFolder(_ dir: URL) throws -> PackManifest {
        let m = try PackVerifier.parseManifest(Data(contentsOf: dir.appendingPathComponent("manifest.json")))
        guard m.kind != "cities" else { throw PackError.format("cities are built in") }
        try install(m, builtin: false) { try? Data(contentsOf: dir.appendingPathComponent($0)) }
        defaults.set((defaults.stringArray(forKey: Self.removedKey) ?? []).filter { $0 != m.id }, forKey: Self.removedKey)
        return m
    }

    public func install(_ m: PackManifest, builtin: Bool, read: (String) -> Data?) throws {
        try PackVerifier.verify(m, read: read)
        let bytes = m.files.reduce(0) { $0 + $1.bytes }
        let now = Date().timeIntervalSince1970
        let manifestJson = String(decoding: try JSONEncoder().encode(m), as: UTF8.self)
        let dec = JSONDecoder()
        switch m.kind {
        case "mosques":
            guard let file = m.files.first(where: { $0.path.hasSuffix(".jsonl") }), let data = read(file.path) else { throw PackError.format("no data") }
            let rows = String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { line -> Mosque? in
                (try? dec.decode(MosqueRecord.self, from: Data(line.utf8)))?.toMosque(packId: m.id)
            }
            try db.writer.write { db in
                try db.execute(sql: "DELETE FROM mosque WHERE packId = ?", arguments: [m.id])
                let stmt = try db.makeStatement(sql: "INSERT OR REPLACE INTO mosque VALUES (?,?,?,?,?,?,?,?,?,?,?)")
                for r in rows {
                    let names = String(decoding: try JSONEncoder().encode(r.names), as: UTF8.self)
                    try stmt.execute(arguments: [r.sourceId, m.id, r.category.rawValue, names, r.location.latitude, r.location.longitude, r.address, r.phone, r.website, r.openingHoursRaw, r.sourceTimestamp])
                }
                try Self.upsert(db, m, manifestJson, rows.count, bytes, now, builtin)
            }
        case "sources":
            guard let data = read("chunks.jsonl") else { throw PackError.format("no chunks") }
            let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
            let chunks = try lines.map { line -> (SourceChunk, String, String) in
                let c = try dec.decode(SourceChunk.self, from: Data(line.utf8))
                return (c, String(line), c.searchText())
            }
            let docs = (read("documents.json").flatMap { try? dec.decode([SourceDocument].self, from: $0) }) ?? []
            let qs = (read("common-questions.json").flatMap { try? dec.decode(CommonQuestionsFile.self, from: $0) })?.questions ?? []
            let ids = Set(chunks.map(\.0.id))
            let valid = qs.filter { $0.citations.allSatisfy(ids.contains) }
            let enc = JSONEncoder()
            try db.writer.write { db in
                for table in ["source_chunk", "source_document", "common_question"] {
                    try db.execute(sql: "DELETE FROM \(table) WHERE packId = ?", arguments: [m.id])
                }
                let stmt = try db.makeStatement(sql: "INSERT OR REPLACE INTO source_chunk (id, packId, seq, anchor, json, searchText, tokenCount) VALUES (?,?,?,?,?,?,?)")
                for (c, line, text) in chunks {
                    try stmt.execute(arguments: [c.id, m.id, c.seq, c.anchor, line, text, text.isEmpty ? 0 : text.split(separator: " ").count])
                }
                for d in docs {
                    try db.execute(sql: "INSERT OR REPLACE INTO source_document VALUES (?,?,?)", arguments: [d.id, m.id, String(decoding: try enc.encode(d), as: UTF8.self)])
                }
                for (i, q) in valid.enumerated() {
                    try db.execute(sql: "INSERT OR REPLACE INTO common_question VALUES (?,?,?,?)", arguments: [q.id, m.id, i, String(decoding: try enc.encode(q), as: UTF8.self)])
                }
                try Self.upsert(db, m, manifestJson, chunks.count, bytes, now, builtin)
            }
        default:
            throw PackError.format("kind \(m.kind)")
        }
    }

    static func upsert(_ db: Database, _ m: PackManifest, _ json: String, _ count: Int, _ bytes: Int, _ now: Double, _ builtin: Bool) throws {
        try db.execute(
            sql: "INSERT OR REPLACE INTO installed_pack VALUES (?,?,?,?,?,?,?,?,?)",
            arguments: [m.id, m.kind, m.version, m.schemaVersion, json, count, bytes, now, builtin]
        )
    }
}
