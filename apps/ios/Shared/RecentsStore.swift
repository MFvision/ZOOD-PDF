import Foundation

/// A document the person opened, remembered so the Library and the widgets
/// can show it again: its name, a bookmark to where it is, when it was last
/// opened, its page count and a thumbnail file. Never the file's bytes, and
/// never for a password-protected file.
public struct RecentDocument: Codable, Identifiable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    /// A bookmark to the file: keeps access to a file chosen in Files.
    public var bookmark: Data
    public var lastOpened: Date
    public var pageCount: Int
    /// The thumbnail's file name inside `AppGroup.thumbnailsURL`, if one was drawn.
    public var thumbnailFile: String?

    public init(id: UUID = UUID(), name: String, bookmark: Data, lastOpened: Date = .now, pageCount: Int, thumbnailFile: String? = nil) {
        self.id = id
        self.name = name
        self.bookmark = bookmark
        self.lastOpened = lastOpened
        self.pageCount = pageCount
        self.thumbnailFile = thumbnailFile
    }

    public var thumbnailURL: URL? {
        thumbnailFile.map { AppGroup.thumbnailsURL.appending(path: $0) }
    }

    /// The file's URL now, or nil when it is gone.
    public func resolveURL() -> URL? {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: bookmark, bookmarkDataIsStale: &stale) else {
            return nil
        }
        return url
    }
}

/// The recents list as a JSON file in the shared container, newest first,
/// at most `limit` entries. Written by the app, read by the widgets.
public struct RecentsStore: Sendable {
    public static let limit = 24
    public let fileURL: URL

    public init(fileURL: URL = AppGroup.recentsFileURL) {
        self.fileURL = fileURL
    }

    public func load() -> [RecentDocument] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        // A damaged file is an empty list, not a crash: it is only a list.
        let list = (try? decoder.decode([RecentDocument].self, from: data)) ?? []
        return list.sorted { $0.lastOpened > $1.lastOpened }
    }

    public func save(_ documents: [RecentDocument]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let kept = Array(documents.sorted { $0.lastOpened > $1.lastOpened }.prefix(Self.limit))
        AppGroup.ensure(fileURL.deletingLastPathComponent())
        try encoder.encode(kept).write(to: fileURL, options: .atomic)
    }

    /// Puts a document at the top, replacing an earlier entry for the same
    /// file (by its bookmark's target, else by name).
    public func remember(_ document: RecentDocument) throws {
        var list = load()
        let target = document.resolveURL()?.standardizedFileURL
        list.removeAll { existing in
            if let target, let other = existing.resolveURL()?.standardizedFileURL {
                return other == target
            }
            return existing.id == document.id
        }
        list.insert(document, at: 0)
        try save(list)
    }

    public func forget(id: UUID) throws {
        var list = load()
        if let gone = list.first(where: { $0.id == id }), let thumbnail = gone.thumbnailURL {
            try? FileManager.default.removeItem(at: thumbnail)
        }
        list.removeAll { $0.id == id }
        try save(list)
    }

    public func clear() throws {
        for document in load() {
            if let thumbnail = document.thumbnailURL {
                try? FileManager.default.removeItem(at: thumbnail)
            }
        }
        try save([])
    }
}
