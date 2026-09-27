import CryptoKit
import Foundation
import UniformTypeIdentifiers

/// Where the Library's documents come from: the app's own Documents folder,
/// and a folder the person chose in Files or iCloud Drive, kept through a
/// security-scoped bookmark. Each gives its files a key — `documents/<name>`
/// or `folder/<path inside the folder>` — that the index stores and the
/// folder filter matches as a prefix.
enum LibrarySource: String, CaseIterable, Sendable {
    case documents
    case folder

    var keyPrefix: String { rawValue + "/" }

    /// The folder filter for this whole source.
    var folderFilter: String { rawValue }
}

/// A file one of the sources holds, as listed: no bytes read yet.
struct LibraryFile: Identifiable, Hashable, Sendable {
    let key: String
    let url: URL
    let name: String
    /// Whole milliseconds since the epoch, the same count as the desktop's.
    let modified: Int
    let size: Int
    let kind: LibraryFileKind

    var id: String { key }
    var source: LibrarySource? { LibrarySource.allCases.first { key.hasPrefix($0.keyPrefix) } }
}

/// What a file's name says it is.
enum LibraryFileKind: Sendable {
    case pdf
    case image

    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "heic", "heif", "tif", "tiff", "gif", "bmp", "webp"]

    init?(url: URL) {
        let ext = url.pathExtension.lowercased()
        if ext == "pdf" {
            self = .pdf
        } else if Self.imageExtensions.contains(ext) {
            self = .image
        } else {
            return nil
        }
    }
}

/// The folder chosen in Files or iCloud Drive: its bookmark in the app's
/// defaults, resolved and held open while the Library reads it.
struct ChosenFolder: Sendable {
    static let bookmarkKey = "libraryFolderBookmark"

    let url: URL
    /// The folder's name, for the sidebar.
    var name: String { url.lastPathComponent }

    /// Remembers a folder the picker handed over.
    static func choose(_ url: URL) throws {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        UserDefaults.standard.set(bookmark, forKey: bookmarkKey)
    }

    static func forget() {
        UserDefaults.standard.removeObject(forKey: bookmarkKey)
    }

    /// The chosen folder, or nil when none was chosen or it is gone.
    static func current() -> ChosenFolder? {
        guard let bookmark = UserDefaults.standard.data(forKey: bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: bookmark, bookmarkDataIsStale: &stale) else { return nil }
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            UserDefaults.standard.set(fresh, forKey: bookmarkKey)
        }
        return ChosenFolder(url: url)
    }

    /// Runs `body` with the folder readable.
    func withAccess<T>(_ body: (URL) throws -> T) rethrows -> T {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try body(url)
    }
}

/// Lists the sources' files, one `stat` each and never a byte of content,
/// within bounds: a folder of any size lists at most `maxFiles`, no deeper
/// than `maxDepth`.
enum LibraryListing {
    static let maxFiles = 4000
    static let maxDepth = 8

    static func files(documentsFolder: URL, chosen: ChosenFolder?) -> [LibraryFile] {
        var files = list(folder: documentsFolder, source: .documents, deep: false)
        if let chosen {
            files += chosen.withAccess { list(folder: $0, source: .folder, deep: true) }
        }
        return files
    }

    private static func list(folder: URL, source: LibrarySource, deep: Bool) -> [LibraryFile] {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isDirectoryKey, .fileSizeKey, .contentModificationDateKey, .nameKey, .isHiddenKey,
                                         .ubiquitousItemDownloadingStatusKey]
        guard let enumerator = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: Array(keys),
                                                              options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
        var files: [LibraryFile] = []
        let base = folder.standardizedFileURL.path
        for case let url as URL in enumerator {
            if files.count >= maxFiles { break }
            if enumerator.level > (deep ? maxDepth : 1) {
                enumerator.skipDescendants()
                continue
            }
            guard let values = try? url.resourceValues(forKeys: keys) else { continue }
            if values.isDirectory == true {
                if !deep { enumerator.skipDescendants() }
                continue
            }
            guard values.isRegularFile == true, let kind = LibraryFileKind(url: url) else { continue }
            // An iCloud file not yet on this device is asked for, and read on
            // the run after it arrives, rather than waited for here.
            if let status = values.ubiquitousItemDownloadingStatus, status != .current {
                try? FileManager.default.startDownloadingUbiquitousItem(at: url)
                continue
            }
            let path = url.standardizedFileURL.path
            let relative = path.hasPrefix(base + "/") ? String(path.dropFirst(base.count + 1)) : url.lastPathComponent
            let modified = values.contentModificationDate.map { Int(($0.timeIntervalSince1970 * 1000).rounded()) } ?? 0
            files.append(LibraryFile(key: source.keyPrefix + relative, url: url,
                                     name: url.deletingPathExtension().lastPathComponent,
                                     modified: modified, size: values.fileSize ?? 0, kind: kind))
        }
        return files.sorted { $0.key < $1.key }
    }

    /// The file a key names now, or nil when it is gone.
    static func url(for key: String, documentsFolder: URL, chosen: ChosenFolder?) -> URL? {
        if key.hasPrefix(LibrarySource.documents.keyPrefix) {
            let url = documentsFolder.appending(path: String(key.dropFirst(LibrarySource.documents.keyPrefix.count)))
            return FileManager.default.fileExists(atPath: url.path) ? url : nil
        }
        if key.hasPrefix(LibrarySource.folder.keyPrefix), let chosen {
            let url = chosen.url.appending(path: String(key.dropFirst(LibrarySource.folder.keyPrefix.count)))
            return chosen.withAccess { _ in FileManager.default.fileExists(atPath: url.path) } ? url : nil
        }
        return nil
    }

    /// A file name for a key, safe for the thumbnails folder.
    static func thumbnailFile(for key: String) -> String {
        let digest = SHA256.hash(data: Data(key.utf8))
        return "key-" + digest.prefix(12).map { String(format: "%02x", $0) }.joined() + ".png"
    }
}
