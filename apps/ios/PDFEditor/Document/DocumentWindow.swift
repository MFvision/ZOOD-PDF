import SwiftUI

/// A document named for a window of its own: a bookmark to the file (which
/// keeps the access a file chosen in Files granted) and its name for the
/// window's title. Codable, so the scene comes back after a relaunch.
struct DocumentReference: Codable, Hashable {
    let bookmark: Data
    let name: String

    init?(url: URL) {
        guard let bookmark = try? url.bookmarkData(options: .minimalBookmark) else { return nil }
        self.bookmark = bookmark
        self.name = url.deletingPathExtension().lastPathComponent
    }

    func resolveURL() -> URL? {
        var stale = false
        return try? URL(resolvingBookmarkData: bookmark, bookmarkDataIsStale: &stale)
    }
}

/// The scene a document opens in when dragged out of the Library or
/// opened "in a new window" on iPad: the file, and nothing else.
struct DocumentWindow: View {
    let reference: DocumentReference?
    @State private var model: DocumentModel?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            if let model {
                DocumentView(model: model)
            } else if failed {
                EmptyState(symbol: "doc.questionmark", title: "Cannot open this file", message: "This file is no longer where it was.")
                    .background(Surface.underPage)
            } else {
                ProgressView("Opening…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Surface.underPage)
            }
        }
        .task(id: reference) {
            model?.close()
            model = nil
            guard let url = reference?.resolveURL(), let opened = try? DocumentModel(url: url) else {
                failed = true
                return
            }
            model = opened
        }
    }
}
