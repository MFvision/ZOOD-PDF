import Foundation
import Observation
import PDFKit
import WidgetKit

/// A PDF in the app's own Documents folder (visible in Files under the
/// app's name), as the grid lists it.
struct LocalDocument: Identifiable, Hashable, Sendable {
    let url: URL
    let name: String
    let size: Int
    let modified: Date

    var id: URL { url }
}

/// What the Library's shell shows and does: the recents list (shared with
/// the widgets), the app's own Documents folder, the Inbox the share
/// extension fills, and the document open on screen.
@MainActor @Observable
final class LibraryModel {
    private(set) var recents: [RecentDocument] = []
    private(set) var documents: [LocalDocument] = []
    /// The document on screen, in the detail column or pushed on the stack.
    var opened: DocumentModel?
    /// Something that went wrong opening a file, shown once.
    var error: String?

    let store: RecentsStore
    let documentsFolder: URL

    init(store: RecentsStore = RecentsStore(),
         documentsFolder: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]) {
        self.store = store
        self.documentsFolder = documentsFolder
    }

    // MARK: - Listing

    func refresh() {
        recents = store.load()
        documents = listDocuments()
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
    /// under a name that is not taken.
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

    // MARK: - Opening

    /// Opens a file where it is and remembers it.
    func open(url: URL) {
        do {
            let model = try DocumentModel(url: url)
            opened?.close()
            opened = model
            Task {
                await model.load()
                await remember(model)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func open(_ recent: RecentDocument) {
        guard let url = recent.resolveURL() else {
            error = String(localized: "This file is no longer where it was.")
            try? store.forget(id: recent.id)
            refresh()
            return
        }
        open(url: url)
    }

    func open(_ local: LocalDocument) {
        open(url: local.url)
    }

    /// A URL the app was asked to open: a file, or `pdfeditor://open/<id>`
    /// from a widget.
    func handle(_ url: URL) {
        if url.isFileURL {
            open(url: url)
            return
        }
        guard url.scheme == AppGroup.urlScheme else { return }
        if url.host() == "open", let id = UUID(uuidString: url.lastPathComponent),
           let recent = store.load().first(where: { $0.id == id }) {
            open(recent)
        }
    }

    func closeDocument() {
        opened?.close()
        opened = nil
    }

    // MARK: - Remembering

    /// Adds the document to the recents with a thumbnail of its first page,
    /// and tells the widgets. A protected document is not remembered.
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
    }

    /// Deletes a file from the app's Documents folder.
    func delete(_ local: LocalDocument) {
        do {
            try FileManager.default.removeItem(at: local.url)
            if let recent = recents.first(where: { $0.resolveURL()?.standardizedFileURL == local.url.standardizedFileURL }) {
                forget(recent)
            }
            documents = listDocuments()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
