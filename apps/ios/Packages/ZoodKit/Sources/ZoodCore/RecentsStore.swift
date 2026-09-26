import Foundation

/// One recent file. Mirrors the web `RecentItem`, plus how to find the file again on iOS.
public struct RecentDocument: Codable, Sendable, Identifiable, Hashable {
    public var id: String
    public var name: String
    /// URL bookmark (created by the app; Files-app documents opened in place).
    public var bookmark: Data?
    /// Path relative to the app's Documents folder, for files the app itself owns (scans,
    /// combined/compressed copies). Survives container moves, unlike absolute paths.
    public var documentsPath: String?
    public var size: Int64
    public var pageCount: Int?
    public var openedAt: Date
    public var starred: Bool
    public var tags: [String]
    public var hasThumbnail: Bool

    public init(
        id: String = UUID().uuidString, name: String, bookmark: Data? = nil, documentsPath: String? = nil,
        size: Int64, pageCount: Int? = nil, openedAt: Date, starred: Bool = false, tags: [String] = [],
        hasThumbnail: Bool = false
    ) {
        self.id = id
        self.name = name
        self.bookmark = bookmark
        self.documentsPath = documentsPath
        self.size = size
        self.pageCount = pageCount
        self.openedAt = openedAt
        self.starred = starred
        self.tags = tags
        self.hasThumbnail = hasThumbnail
    }
}

/// Recent files, stored as `recents.json` plus `thumbs/<id>.png` in a directory that the app
/// and its widgets share (the App Group container). Nothing leaves the device.
public actor RecentsStore {
    public static let maxItems = 60
    public nonisolated let directory: URL
    private let now: @Sendable () -> Date

    public init(directory: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.now = now
    }

    nonisolated var indexURL: URL { directory.appendingPathComponent("recents.json") }
    public nonisolated func thumbnailURL(id: String) -> URL {
        directory.appendingPathComponent("thumbs", isDirectory: true)
            .appendingPathComponent("\(Self.safeID(id)).png")
    }

    /// Synchronous read for widgets and Spotlight/App Intents entity queries.
    public nonisolated static func snapshot(directory: URL) -> [RecentDocument] {
        let url = directory.appendingPathComponent("recents.json")
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return (try? decoder.decode([RecentDocument].self, from: data)) ?? []
    }

    /// Newest first.
    public func list() -> [RecentDocument] {
        load()
    }

    public func item(id: String) -> RecentDocument? {
        load().first { $0.id == id }
    }

    /// Add or refresh an entry. Entries match by `documentsPath`, else by bookmark bytes, else by
    /// name + size (a file re-picked from Files gets a new bookmark each time).
    @discardableResult
    public func record(
        name: String, bookmark: Data?, documentsPath: String?, size: Int64, pageCount: Int?
    ) throws -> RecentDocument {
        var items = load()
        let index = items.firstIndex { r in
            if let p = documentsPath, r.documentsPath == p { return true }
            if let b = bookmark, r.bookmark == b { return true }
            return r.name == name && r.size == size
        }
        var entry: RecentDocument
        if let i = index {
            entry = items.remove(at: i)
            entry.name = name
            entry.bookmark = bookmark ?? entry.bookmark
            entry.documentsPath = documentsPath ?? entry.documentsPath
            entry.size = size
            entry.pageCount = pageCount ?? entry.pageCount
            entry.openedAt = now()
        } else {
            entry = RecentDocument(
                name: name, bookmark: bookmark, documentsPath: documentsPath, size: size,
                pageCount: pageCount, openedAt: now())
        }
        items.insert(entry, at: 0)
        if items.count > Self.maxItems {
            for dropped in items[Self.maxItems...] {
                try? FileManager.default.removeItem(at: thumbnailURL(id: dropped.id))
            }
            items.removeLast(items.count - Self.maxItems)
        }
        try save(items)
        return entry
    }

    public func setStarred(id: String, _ starred: Bool) throws {
        try mutate(id) { $0.starred = starred }
    }

    public func setTags(id: String, _ tags: [String]) throws {
        let clean = Self.cleanTags(tags)
        try mutate(id) { $0.tags = clean }
    }

    public func rename(id: String, to name: String) throws {
        try mutate(id) { $0.name = name }
    }

    public func update(id: String, size: Int64, pageCount: Int?) throws {
        try mutate(id) {
            $0.size = size
            $0.pageCount = pageCount ?? $0.pageCount
        }
    }

    public func remove(id: String) throws {
        var items = load()
        items.removeAll { $0.id == id }
        try? FileManager.default.removeItem(at: thumbnailURL(id: id))
        try save(items)
    }

    public func writeThumbnail(id: String, png: Data) throws {
        let url = thumbnailURL(id: id)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: url, options: .atomic)
        try mutate(id) { $0.hasThumbnail = true }
    }

    /// Drop the first-page picture (after redaction or protection, like the web app) so no
    /// earlier content lingers on the device.
    public func forgetThumbnail(id: String) throws {
        try? FileManager.default.removeItem(at: thumbnailURL(id: id))
        try mutate(id) { $0.hasThumbnail = false }
    }

    public func starred() -> [RecentDocument] {
        load().filter(\.starred)
    }

    /// Every tag in use, sorted with the Arabic-aware comparison of the current locale.
    public func allTags() -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for t in load().flatMap(\.tags) where seen.insert(SearchNormalizer.normalize(t)).inserted {
            out.append(t)
        }
        return out.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    public func tagged(_ tag: String) -> [RecentDocument] {
        let key = SearchNormalizer.normalize(tag)
        return load().filter { $0.tags.contains { SearchNormalizer.normalize($0) == key } }
    }

    /// Web rule: every query term must occur in the name or a tag (Arabic-normalised).
    public func search(_ query: String) -> [RecentDocument] {
        load().filter { SearchNormalizer.matches(query: query, fields: [$0.name] + $0.tags) }
    }

    /// Trim, collapse inner whitespace, drop empties and duplicates (Arabic-normalised), cap at 20.
    public static func cleanTags(_ tags: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in tags {
            let t = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            guard !t.isEmpty, t.count <= 40 else { continue }
            if seen.insert(SearchNormalizer.normalize(t)).inserted { out.append(t) }
            if out.count == 20 { break }
        }
        return out
    }

    // MARK: - Storage

    private static func safeID(_ id: String) -> String {
        String(id.unicodeScalars.filter { $0.properties.isAlphabetic || ("0"..."9").contains($0) || $0 == "-" }
            .map(Character.init))
    }

    private func mutate(_ id: String, _ change: (inout RecentDocument) -> Void) throws {
        var items = load()
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[i])
        try save(items)
    }

    /// Read from disk every time: the widgets and other app processes (App Intents) write too,
    /// and the index is small (≤ 60 entries).
    private func load() -> [RecentDocument] {
        Self.snapshot(directory: directory).sorted { $0.openedAt > $1.openedAt }
    }

    private func save(_ items: [RecentDocument]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        e.outputFormatting = [.sortedKeys]
        try e.encode(items).write(to: indexURL, options: .atomic)
    }
}
