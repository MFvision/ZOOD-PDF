import Foundation

/// Starred: a flag the person puts on a document on this device. Kept as
/// a set of file paths in a JSON file of the shared container (which is
/// the device's own, never iCloud's), so the widgets could read it too.
public struct StarredStore: Sendable {
    public let fileURL: URL

    public init(fileURL: URL = AppGroup.containerURL.appending(path: "starred.json")) {
        self.fileURL = fileURL
    }

    /// The paths starred, standardized.
    public func load() -> Set<String> {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return Set((try? JSONDecoder().decode([String].self, from: data)) ?? [])
    }

    public func save(_ paths: Set<String>) throws {
        AppGroup.ensure(fileURL.deletingLastPathComponent())
        try JSONEncoder().encode(paths.sorted()).write(to: fileURL, options: .atomic)
    }

    public static func key(for url: URL) -> String {
        url.standardizedFileURL.path
    }

    public func isStarred(_ url: URL) -> Bool {
        load().contains(Self.key(for: url))
    }

    /// Stars the file, or takes the star off; answers the new state.
    @discardableResult
    public func toggle(_ url: URL) throws -> Bool {
        var paths = load()
        let key = Self.key(for: url)
        let on = !paths.contains(key)
        if on { paths.insert(key) } else { paths.remove(key) }
        try save(paths)
        return on
    }

    public func clear() throws {
        try save([])
    }
}
