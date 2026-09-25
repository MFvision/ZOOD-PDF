import Foundation
import Observation
import PDFKit
import SwiftUI
import UIKit
import WidgetKit

/// A PDF in the app's own Documents folder (visible in Files under the
/// app's name), as the grid lists it.
struct LocalDocument: Identifiable, Hashable, Sendable {
    let url: URL
    let name: String
    let size: Int
    let modified: Date

    var id: URL { url }
    /// Its key in the Library's index.
    var key: String { LibrarySource.documents.keyPrefix + url.lastPathComponent }
}

/// What the Library's shell shows and does: the recents list (shared with
/// the widgets), the app's own Documents folder, the folder chosen in
/// Files, the Inbox the share extension fills, the index over all of them,
/// and the document open on screen.
@MainActor @Observable
final class LibraryModel {
    private(set) var recents: [RecentDocument] = []
    private(set) var documents: [LocalDocument] = []
    /// The files of the chosen folder, as listed on the last refresh.
    private(set) var folderFiles: [LibraryFile] = []
    private(set) var chosenFolder: ChosenFolder?
    /// The document on screen, in the detail column or pushed on the stack.
    var opened: DocumentModel?
    /// Something that went wrong opening a file, shown once: one of the
    /// app's own messages (a key of the String Catalog), or the system's.
    var error: LocalizedStringKey?
    /// The Library's index and the runs over it, once the index is open.
    private(set) var indexer: LibraryIndexer?
    /// A search asked for from outside (a widget, a Shortcut): the search
    /// field takes it.
    var requestedSearch: String?
    /// A scan asked for from outside (a widget, the control, a Shortcut).
    var scanRequested = false

    let store: RecentsStore
    let searches: SearchesStore
    let documentsFolder: URL
    let indexURL: URL

    init(store: RecentsStore = RecentsStore(),
         searches: SearchesStore = SearchesStore(),
         documentsFolder: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0],
         indexURL: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
             .appending(path: "Library/library.wlx")) {
        self.store = store
        self.searches = searches
        self.documentsFolder = documentsFolder
        self.indexURL = indexURL
    }

    // MARK: - Listing

    func refresh() {
        recents = store.load()
        documents = listDocuments()
        chosenFolder = ChosenFolder.current()
        folderFiles = chosenFolder.map { chosen in
            LibraryListing.files(documentsFolder: documentsFolder, chosen: chosen).filter { $0.source == .folder }
        } ?? []
    }

    private func listDocuments() -> [LocalDocument] {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        guard let urls = try? FileManager.default.contentsOfDirectory(at: documentsFolder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
            return []
        }
        return urls
            .filter { $0.pathExtension.lowercased() == "pdf" }
            .compactMap { url -> LocalDocument? in
                guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { return nil }
                return LocalDocument(url: url,
                                     name: url.deletingPathExtension().lastPathComponent,
                                     size: values.fileSize ?? 0,
                                     modified: values.contentModificationDate ?? .distantPast)
            }
            .sorted { $0.modified > $1.modified }
    }

    /// Moves what the share extension left in the Inbox into Documents,
    /// under a name that is not taken, and reads the new files into the index.
    func takeInbox() {
        let inbox = AppGroup.inboxURL
        guard let files = try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else {
            return
        }
        var moved = false
        for file in files where file.pathExtension.lowercased() == "pdf" {
            let destination = freeName(for: file.lastPathComponent, in: documentsFolder)
            if (try? FileManager.default.moveItem(at: file, to: destination)) != nil {
                moved = true
            }
        }
        if moved {
            documents = listDocuments()
            indexNow()
        }
    }

    /// "Name.pdf", then "Name 2.pdf", "Name 3.pdf"…
    func freeName(for fileName: String, in folder: URL) -> URL {
        let base = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension
        var candidate = folder.appending(path: fileName)
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appending(path: "\(base) \(n).\(ext)")
            n += 1
        }
        return candidate
    }

    /// Puts a file made by the app (a scan, a PDF made from pictures) into
    /// Documents and the index, and opens it.
    func adopt(bytes: Data, name: String, open: Bool = true) throws -> URL {
        let destination = freeName(for: "\(name).pdf", in: documentsFolder)
        try bytes.write(to: destination, options: .atomic)
        documents = listDocuments()
        indexNow()
        if open {
            self.open(url: destination)
        }
        return destination
    }

    // MARK: - The index

    /// Opens the index file (or starts a new one) and reads what it holds.
    func prepareIndex() async {
        guard indexer == nil else { return }
        do {
            let index = try await LibraryIndex.open(at: indexURL)
            let indexer = LibraryIndexer(index: index, documentsFolder: documentsFolder)
            self.indexer = indexer
            let files = LibraryListing.files(documentsFolder: documentsFolder, chosen: chosenFolder)
            await indexer.reloadCatalog(files: files)
        } catch {
            self.error = LocalizedStringKey(error.localizedDescription)
        }
    }

    /// Reads new and changed files into the index, now.
    func indexNow() {
        guard let indexer else { return }
        indexer.run(chosen: chosenFolder)
    }

    func stopIndexing() {
        indexer?.stop()
    }

    /// The Library's search, over everything indexed.
    func search(_ query: String, filters: SearchFilters = .none) async -> SearchResult {
        guard let indexer else { return .empty }
        return (try? await indexer.index.search(query, filters: filters)) ?? .empty
    }

    /// Keeps a search the person ran, for the widget.
    func rememberSearch(_ query: String, hits: Int) {
        try? searches.remember(RecentSearch(query: query, hits: hits))
        WidgetCenter.shared.reloadTimelines(ofKind: "app.warraq.ios.widgets.search")
    }

    /// The thumbnail for a file in the Library: the one the index drew, or
    /// the one the recents keep.
    func thumbnail(forKey key: String, url: URL?) -> UIImage? {
        if let file = indexer?.thumbnailURL(for: key), let image = UIImage(contentsOfFile: file.path) {
            return image
        }
        if let url, let recent = recents.first(where: { $0.resolveURL()?.standardizedFileURL == url.standardizedFileURL }),
           let file = recent.thumbnailURL, let image = UIImage(contentsOfFile: file.path) {
            return image
        }
        return nil
    }

    // MARK: - The chosen folder

    func choose(folder url: URL) {
        do {
            try ChosenFolder.choose(url)
            refresh()
            indexNow()
        } catch {
            self.error = LocalizedStringKey(error.localizedDescription)
        }
    }

    /// Lets go of the folder: its documents leave the index and Spotlight;
    /// the files are the person's and stay where they are.
    func forgetFolder() async {
        let keys = folderFiles.map(\.key) + (indexer?.catalog.keys.filter { $0.hasPrefix(LibrarySource.folder.keyPrefix) } ?? [])
        ChosenFolder.forget()
        refresh()
        await indexer?.forget(keys: Array(Set(keys)))
    }

    // MARK: - Opening

    /// Opens a file where it is and remembers it; at `page` (from one)
    /// when a search hit asked for it.
    func open(url: URL, page: Int? = nil) {
        do {
            let model = try DocumentModel(url: url)
            if let page, page > 0 {
                model.currentPage = page - 1
            }
            opened?.close()
            opened = model
            Task {
                await model.load()
                await remember(model)
            }
        } catch {
            self.error = LocalizedStringKey(error.localizedDescription)
        }
    }

    func open(_ recent: RecentDocument) {
        guard let url = recent.resolveURL() else {
            error = "This file is no longer where it was."
            try? store.forget(id: recent.id)
            refresh()
            return
        }
        open(url: url)
    }

    func open(_ local: LocalDocument) {
        open(url: local.url)
    }

    /// Opens a document the index knows by its key, at a page.
    func open(key: String, page: Int? = nil) {
        guard let url = LibraryListing.url(for: key, documentsFolder: documentsFolder, chosen: chosenFolder) else {
            error = "This file is no longer where it was."
            return
        }
        if url.pathExtension.lowercased() == "pdf" {
            open(url: url, page: page)
        } else {
            openPicture(at: url, key: key)
        }
    }

    /// A picture in the Library opens as a one-page PDF made from it.
    private func openPicture(at url: URL, key: String) {
        Task {
            do {
                let bytes = try chosenFolder?.withAccess { _ in try Data(contentsOf: url) } ?? Data(contentsOf: url)
                let made = try await PDFMaker.pdf(fromPictures: [bytes])
                let model = DocumentModel(bytes: made, name: url.deletingPathExtension().lastPathComponent)
                opened?.close()
                opened = model
                await model.load()
            } catch {
                self.error = LocalizedStringKey(error.localizedDescription)
            }
        }
    }

    /// A URL the app was asked to open: a file, or one of the app's own
    /// routes from a widget.
    func handle(_ url: URL) {
        if url.isFileURL {
            open(url: url)
            return
        }
        if let route = AppRoute(url: url) {
            handle(route)
        }
    }

    /// One of the places a widget, a control, a Shortcut or a quick action
    /// sends the app.
    func handle(_ route: AppRoute) {
        switch route {
        case .scan:
            scanRequested = true
        case let .open(id):
            if let recent = store.load().first(where: { $0.id == id }) {
                open(recent)
            }
        case let .openKey(key):
            open(key: key)
        case let .search(query):
            requestedSearch = query
        case .lastDocument:
            if let recent = store.load().first {
                open(recent)
            }
        }
    }

    /// Takes the route an intent left before the app came to the front.
    func takePendingRoute() {
        if let route = AppRoute.takePending() {
            handle(route)
        }
    }

    func closeDocument() {
        opened?.close()
        opened = nil
    }

    // MARK: - Remembering

    /// Adds the document to the recents with a thumbnail of its first page,
    /// and tells the widgets and the Home Screen's quick actions. A
    /// protected document is not remembered.
    func remember(_ model: DocumentModel) async {
        guard model.isReady, model.metadata?.encrypted != true, let url = model.url else { return }
        guard let bookmark = try? url.bookmarkData(options: .minimalBookmark) else { return }
        let id = recents.first { $0.resolveURL()?.standardizedFileURL == url.standardizedFileURL }?.id ?? UUID()
        let thumbnailFile = writeThumbnail(of: model, id: id)
        let entry = RecentDocument(id: id, name: model.name, bookmark: bookmark, lastOpened: .now,
                                   pageCount: model.pageCount, thumbnailFile: thumbnailFile)
        try? store.remember(entry)
        recents = store.load()
        WidgetCenter.shared.reloadAllTimelines()
        QuickActions.update(lastDocument: entry)
    }

    private func writeThumbnail(of model: DocumentModel, id: UUID) -> String? {
        guard let page = model.pdf?.page(at: 0) else { return nil }
        let image = page.thumbnail(of: CGSize(width: 320, height: 452), for: .cropBox)
        guard let png = image.pngData() else { return nil }
        let folder = AppGroup.ensure(AppGroup.thumbnailsURL)
        let file = "\(id.uuidString).png"
        guard (try? png.write(to: folder.appending(path: file), options: .atomic)) != nil else { return nil }
        return file
    }

    func forget(_ recent: RecentDocument) {
        try? store.forget(id: recent.id)
        recents = store.load()
        WidgetCenter.shared.reloadAllTimelines()
        QuickActions.update(lastDocument: recents.first)
    }

    /// Deletes a file from the app's Documents folder, and from the index.
    func delete(_ local: LocalDocument) {
        do {
            try FileManager.default.removeItem(at: local.url)
            if let recent = recents.first(where: { $0.resolveURL()?.standardizedFileURL == local.url.standardizedFileURL }) {
                forget(recent)
            }
            documents = listDocuments()
            Task { await indexer?.forget(keys: [local.key]) }
        } catch {
            self.error = LocalizedStringKey(error.localizedDescription)
        }
    }

    /// "Delete everything": the documents, the index, Spotlight's items,
    /// the recents, the thumbnails, the searches, the Inbox, the chosen
    /// folder's bookmark (never the folder) and the settings.
    func deleteEverything() async {
        closeDocument()
        await indexer?.deleteEverything()
        for document in documents {
            try? FileManager.default.removeItem(at: document.url)
        }
        try? store.clear()
        try? searches.clear()
        try? FileManager.default.removeItem(at: AppGroup.inboxURL)
        try? FileManager.default.removeItem(at: AppGroup.thumbnailsURL)
        try? FileManager.default.removeItem(at: indexURL.deletingLastPathComponent())
        ChosenFolder.forget()
        for key in [SettingsKey.language, SettingsKey.appearance, SettingsKey.scanMode, SettingsKey.ocrLanguages, SettingsKey.appLock, "AppleLanguages"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
        _ = AppRoute.takePending()
        indexer = nil
        refresh()
        WidgetCenter.shared.reloadAllTimelines()
        QuickActions.update(lastDocument: nil)
        await prepareIndex()
    }
}
