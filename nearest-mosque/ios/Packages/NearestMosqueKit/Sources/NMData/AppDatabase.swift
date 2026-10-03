import Foundation
import GRDB
import NMCore

/// SQLite schema (GRDB). Mirrors the Android Room schema; the UI reads only from here.
public final class AppDatabase: @unchecked Sendable {
    public let writer: any DatabaseWriter

    public init(_ writer: any DatabaseWriter) throws {
        self.writer = writer
        try Self.migrator.migrate(writer)
    }

    /// On-disk database in Application Support, excluded from iCloud/iTunes backup (packs are
    /// re-installable; favorites are local by design) and protected until first unlock.
    public static func onDisk() throws -> AppDatabase {
        let fm = FileManager.default
        var dir = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        dir.appendPathComponent("NearMosque", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        #if os(iOS)
        try? fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: dir.path)
        #endif
        let pool = try DatabasePool(path: dir.appendingPathComponent("near-mosque.sqlite").path)
        return try AppDatabase(pool)
    }

    public static func inMemory() throws -> AppDatabase { try AppDatabase(DatabaseQueue()) }

    static var migrator: DatabaseMigrator {
        var m = DatabaseMigrator()
        m.registerMigration("v1") { db in
            try db.create(table: "installed_pack") { t in
                t.primaryKey("id", .text)
                t.column("kind", .text).notNull()
                t.column("version", .integer).notNull()
                t.column("schemaVersion", .integer).notNull()
                t.column("manifestJson", .text).notNull()
                t.column("recordCount", .integer).notNull()
                t.column("bytes", .integer).notNull()
                t.column("installedAt", .double).notNull()
                t.column("builtin", .boolean).notNull()
            }
            try db.create(table: "mosque") { t in
                t.primaryKey("sourceId", .text)
                t.column("packId", .text).notNull().indexed()
                t.column("category", .text).notNull()
                t.column("namesJson", .text).notNull()
                t.column("lat", .double).notNull()
                t.column("lng", .double).notNull()
                t.column("address", .text)
                t.column("phone", .text)
                t.column("website", .text)
                t.column("openingHoursRaw", .text)
                t.column("sourceTimestamp", .text)
            }
            try db.create(index: "mosque_lat_lng", on: "mosque", columns: ["lat", "lng"])
            // Favorites reference source ids only, so they survive pack updates and removal.
            try db.create(table: "favorite") { t in
                t.primaryKey("sourceId", .text)
                t.column("addedAt", .double).notNull()
            }
            try db.create(table: "source_document") { t in
                t.primaryKey("id", .text)
                t.column("packId", .text).notNull().indexed()
                t.column("json", .text).notNull()
            }
            try db.create(table: "source_chunk") { t in
                t.primaryKey("id", .text)
                t.column("packId", .text).notNull().indexed()
                t.column("seq", .integer).notNull().indexed()
                t.column("anchor", .text).notNull()
                t.column("json", .text).notNull()
                t.column("searchText", .text).notNull()
                t.column("tokenCount", .integer).notNull()
            }
            try db.create(virtualTable: "source_chunk_fts", using: FTS5()) { t in
                t.synchronize(withTable: "source_chunk")
                // Text is pre-normalized; the tokenizer only splits on spaces.
                t.tokenizer = .unicode61(diacritics: .keep)
                t.column("searchText")
            }
            try db.create(table: "common_question") { t in
                t.primaryKey("id", .text)
                t.column("packId", .text).notNull().indexed()
                t.column("position", .integer).notNull()
                t.column("json", .text).notNull()
            }
        }
        return m
    }
}
