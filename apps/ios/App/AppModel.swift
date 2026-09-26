import CoreSpotlight
import Observation
import SwiftUI
import UniformTypeIdentifiers
import WidgetKit
import ZoodCore
import ZoodEngine

/// Tools shown on Home, in the sidebar and in "More". Every one of them works on iOS.
enum ToolKind: String, CaseIterable, Identifiable, Hashable, Codable {
    case open, scan, edit, convert, ai, more
    case organize, combine, compress, protect

    var id: String { rawValue }

    /// The six Home action cards (spec §4).
    static let homeCards: [ToolKind] = [.open, .scan, .edit, .convert, .ai, .more]
    /// Sidebar / "More" tools.
    static let tools: [ToolKind] = [.scan, .edit, .organize, .combine, .compress, .protect, .convert, .ai]

    var symbol: String {
        switch self {
        case .open: "folder"
        case .scan: "doc.viewfinder"
        case .edit: "pencil.tip.crop.circle"
        case .convert: "arrow.triangle.2.circlepath"
        case .ai: "sparkles"
        case .more: "square.grid.2x2"
        case .organize: "square.grid.3x3.square"
        case .combine: "square.stack.3d.down.right"
        case .compress: "arrow.down.right.and.arrow.up.left"
        case .protect: "lock.doc"
        }
    }

    var title: LocalizedStringResource {
        switch self {
        case .open: "tool.open"
        case .scan: "tool.scan"
        case .edit: "tool.edit"
        case .convert: "tool.convert"
        case .ai: "tool.ai"
        case .more: "tool.more"
        case .organize: "tool.organize"
        case .combine: "tool.combine"
        case .compress: "tool.compress"
        case .protect: "tool.protect"
        }
    }

    var subtitle: LocalizedStringResource {
        switch self {
        case .open: "tool.open.desc"
        case .scan: "tool.scan.desc"
        case .edit: "tool.edit.desc"
        case .convert: "tool.convert.desc"
        case .ai: "tool.ai.desc"
        case .more: "tool.more.desc"
        case .organize: "tool.organize.desc"
        case .combine: "tool.combine.desc"
        case .compress: "tool.compress.desc"
        case .protect: "tool.protect.desc"
        }
    }

    /// Tools that act on one open document (opened first when started from Home).
    var needsDocument: Bool {
        switch self {
        case .edit, .convert, .ai, .organize, .compress, .protect: true
        case .open, .scan, .more, .combine: false
        }
    }
}

enum SidebarItem: Hashable {
    case home, recents, starred, tags
    case tool(ToolKind)
}

/// A document to show: a file URL plus, when it is in recents, its id.
struct OpenedDocument: Hashable, Identifiable {
    let id: UUID
    let url: URL
    let recentID: String?
    var initialTool: ToolKind?

    init(url: URL, recentID: String?, initialTool: ToolKind? = nil) {
        self.id = UUID()
        self.url = url
        self.recentID = recentID
        self.initialTool = initialTool
    }
}

/// Shared by every window: the recents list and how files are opened/recorded.
@MainActor @Observable
final class Library {
    let store = RecentsStore(directory: DocumentLibrary.recentsDirectory)
    private(set) var recents: [RecentDocument] = []
    private(set) var tags: [String] = []
    /// Bumped whenever thumbnails change so grids reload their pictures.
    private(set) var thumbnailsVersion = 0

    func refresh() async {
        recents = await store.list()
        tags = await store.allTags()
    }

    /// Record a file in recents (picture, page count, Spotlight) and return its entry.
    @discardableResult
    func record(url: URL, data: Data? = nil) async -> RecentDocument? {
        let bytes: Data
        if let data {
            bytes = data
        } else if let d = try? await DocumentLibrary.read(url) {
            bytes = d
        } else {
            return nil
        }
        let rel = DocumentLibrary.documentsRelativePath(url)
        let bookmark = rel == nil ? DocumentLibrary.bookmark(for: url) : nil
        let pages = await ThumbnailService.pageCount(bytes)
        guard let entry = try? await store.record(
            name: url.lastPathComponent, bookmark: bookmark, documentsPath: rel,
            size: Int64(bytes.count), pageCount: pages)
        else { return nil }
        let encrypted = (try? WarraqEngine.isEncrypted(bytes))?.encrypted ?? false
        var png: Data?
        if !encrypted, let p = await ThumbnailService.firstPagePNG(bytes) {
            png = p
            try? await store.writeThumbnail(id: entry.id, png: p)
        }
        var text: String?
        if !encrypted { text = await ThumbnailService.plainText(bytes) }
        await SpotlightIndexer.index(entry, text: text, thumbnail: png)
        await refresh()
        thumbnailsVersion += 1
        WidgetCenter.shared.reloadAllTimelines()
        return await store.item(id: entry.id)
    }

    /// After a save: new size/pages, fresh picture (or none for protected files).
    func updateAfterSave(recentID: String, data: Data, protected: Bool) async {
        let pages = await ThumbnailService.pageCount(data)
        try? await store.update(id: recentID, size: Int64(data.count), pageCount: pages)
        if protected {
            try? await store.forgetThumbnail(id: recentID)
            await SpotlightIndexer.remove(id: recentID)
        } else if let png = await ThumbnailService.firstPagePNG(data) {
            try? await store.writeThumbnail(id: recentID, png: png)
        }
        await refresh()
        thumbnailsVersion += 1
        WidgetCenter.shared.reloadAllTimelines()
    }

    func thumbnail(for recent: RecentDocument) -> UIImage? {
        guard recent.hasThumbnail else { return nil }
        return UIImage(contentsOfFile: store.thumbnailURL(id: recent.id).path)
    }

    func setStarred(_ recent: RecentDocument, _ starred: Bool) async {
        try? await store.setStarred(id: recent.id, starred)
        await refresh()
    }

    func setTags(_ recent: RecentDocument, _ tags: [String]) async {
        try? await store.setTags(id: recent.id, tags)
        await refresh()
    }

    func remove(_ recent: RecentDocument) async {
        try? await store.remove(id: recent.id)
        await SpotlightIndexer.remove(id: recent.id)
        await refresh()
        WidgetCenter.shared.reloadAllTimelines()
    }

    func search(_ query: String) -> [RecentDocument] {
        recents.filter { SearchNormalizer.matches(query: query, fields: [$0.name] + $0.tags) }
    }

    func url(for recent: RecentDocument) -> URL? {
        try? DocumentLibrary.resolve(recent)
    }
}

/// Per-window navigation (each iPad window has its own).
@MainActor @Observable
final class WindowRouter {
    var sidebar: SidebarItem? = .home
    var path: [OpenedDocument] = []
    var compactTab: CompactTab = .home
    var scanMode: DeepLink.ScanMode?
    var showCombine = false
    var combineSeed: [URL] = []
    var showMoreTools = false
    var importerTool: ToolKind?
    var toast: Toast?

    enum CompactTab: Hashable { case home, recents, tools }

    func show(_ doc: OpenedDocument) {
        path = [doc]
        compactTab = .home
    }

    /// Start a tool from Home/sidebar: document tools first ask for a file.
    func start(_ tool: ToolKind) {
        switch tool {
        case .scan: scanMode = .document
        case .combine: combineSeed = []; showCombine = true
        case .more: showMoreTools = true
        case .open: importerTool = .open
        default: importerTool = tool
        }
    }

    func handle(_ link: DeepLink, library: Library) {
        switch link {
        case .home:
            path = []
            sidebar = .home
        case .scan(let mode):
            scanMode = mode
        case .combine:
            combineSeed = []
            showCombine = true
        case .compress:
            importerTool = .compress
        case .openRecent(let id):
            Task {
                await library.refresh()
                guard let recent = library.recents.first(where: { $0.id == id }), let url = library.url(for: recent) else {
                    toast = Toast(message: String(localized: "error.notFound"), isError: true)
                    return
                }
                show(OpenedDocument(url: url, recentID: recent.id))
            }
        }
    }

    /// A PDF arrived from the Files app, a share, a drop or the importer.
    func openFile(_ url: URL, tool: ToolKind? = nil, library: Library) {
        Task {
            let recent = await library.record(url: url)
            show(OpenedDocument(url: url, recentID: recent?.id, initialTool: tool == .open ? nil : tool))
        }
    }

    func handle(url: URL, library: Library) {
        if let link = DeepLink(url: url) {
            handle(link, library: library)
        } else if url.isFileURL {
            openFile(url, library: library)
        }
    }

    func continueSpotlight(_ activity: NSUserActivity, library: Library) {
        if let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String {
            handle(.openRecent(id: id), library: library)
        }
    }
}
