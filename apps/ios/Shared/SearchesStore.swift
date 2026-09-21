import Foundation

/// A search the person ran in the Library, kept so the Library search
/// widget can offer it again.
public struct RecentSearch: Codable, Identifiable, Hashable, Sendable {
    public var query: String
    public var date: Date
    /// How many hits it had when it was run.
    public var hits: Int

    public var id: String { query }

    public init(query: String, date: Date = .now, hits: Int) {
        self.query = query
        self.date = date
        self.hits = hits
    }
}

/// The last searches as a JSON file in the shared container, newest first,
/// at most `limit`, each query once. Written by the app, read by the widget.
public struct SearchesStore: Sendable {
    public static let limit = 8
    public let fileURL: URL

    public init(fileURL: URL = AppGroup.searchesFileURL) {
        self.fileURL = fileURL
    }

    public func load() -> [RecentSearch] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let list = (try? decoder.decode([RecentSearch].self, from: data)) ?? []
        return list.sorted { $0.date > $1.date }
    }

    public func save(_ searches: [RecentSearch]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let kept = Array(searches.sorted { $0.date > $1.date }.prefix(Self.limit))
        AppGroup.ensure(fileURL.deletingLastPathComponent())
        try encoder.encode(kept).write(to: fileURL, options: .atomic)
    }

    /// Puts a query at the top; the same query again replaces its entry.
    public func remember(_ search: RecentSearch) throws {
        let trimmed = search.query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var list = load()
        list.removeAll { $0.query.compare(trimmed, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }
        list.insert(RecentSearch(query: trimmed, date: search.date, hits: search.hits), at: 0)
        try save(list)
    }

    public func clear() throws {
        try save([])
    }
}
