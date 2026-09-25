import Foundation
import PDFKit
import UniformTypeIdentifiers
import ZoodCore

/// Where files live and how the app reads/writes them.
///
/// * Files picked in the Files app are opened **in place** (LSSupportsOpeningDocumentsInPlace):
///   the app keeps a URL bookmark in recents and writes saves back through NSFileCoordinator.
/// * Files the app creates (scans, combined/compressed copies, extracted pages) go into the
///   app's Documents folder, which the Files app shows under "On My iPhone › ZOOD PDF".
enum DocumentLibrary {
    enum LibraryError: LocalizedError {
        case unreadable(String)
        case notFound

        var errorDescription: String? {
            switch self {
            case .unreadable(let name): String(localized: "error.unreadable \(name)")
            case .notFound: String(localized: "error.notFound")
            }
        }
    }

    /// Largest file the app opens (the engine's own limits still apply below this).
    static let maxFileBytes: Int64 = 1_500_000_000

    static var documentsDirectory: URL {
        URL.documentsDirectory
    }

    /// Recents index + thumbnails: the App Group (shared with widgets) or Application Support.
    static var recentsDirectory: URL {
        ZoodShared.groupRecentsDirectory()
            ?? URL.applicationSupportDirectory.appendingPathComponent("Recents", isDirectory: true)
    }

    /// Path relative to Documents when `url` is inside it.
    static func documentsRelativePath(_ url: URL) -> String? {
        let docs = documentsDirectory.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        guard path.hasPrefix(docs + "/") else { return nil }
        return String(path.dropFirst(docs.count + 1))
    }

    static func bookmark(for url: URL) -> Data? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    /// Find a recent file again.
    static func resolve(_ recent: RecentDocument) throws -> URL {
        if let rel = recent.documentsPath {
            let url = documentsDirectory.appendingPathComponent(rel)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        if let data = recent.bookmark {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) {
                return url
            }
        }
        throw LibraryError.notFound
    }

    /// Read a file (security-scoped, coordinated). Runs off the main actor.
    static func read(_ url: URL) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            var coordError: NSError?
            var result: Result<Data, any Error> = .failure(LibraryError.unreadable(url.lastPathComponent))
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordError) { readURL in
                do {
                    let size = (try? readURL.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
                    if size > maxFileBytes { throw LibraryError.unreadable(url.lastPathComponent) }
                    result = .success(try Data(contentsOf: readURL, options: .mappedIfSafe))
                } catch {
                    result = .failure(error)
                }
            }
            if let coordError { throw coordError }
            return try result.get()
        }.value
    }

    /// Replace a file's contents (security-scoped, coordinated, atomic).
    static func write(_ data: Data, to url: URL) async throws {
        try await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            var coordError: NSError?
            var writeError: (any Error)?
            NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordError) { writeURL in
                do { try data.write(to: writeURL, options: .atomic) } catch { writeError = error }
            }
            if let coordError { throw coordError }
            if let writeError { throw writeError }
        }.value
    }

    /// Save a new file in Documents/<folder>/ with a unique, sanitised name.
    static func saveNew(_ data: Data, name: String, folder: String? = nil) throws -> URL {
        var dir = documentsDirectory
        if let folder { dir = dir.appendingPathComponent(folder, isDirectory: true) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let existing = Set((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
        let fileName = FileNaming.unique(FileNaming.pdfName(name), existing: existing)
        let url = dir.appendingPathComponent(fileName)
        try data.write(to: url, options: .atomic)
        return url
    }

    /// A temporary copy for sharing (Share sheet / drag) under a readable name.
    static func temporaryCopy(_ data: Data, name: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(FileNaming.pdfName(name))
        try data.write(to: url, options: .atomic)
        return url
    }
}
