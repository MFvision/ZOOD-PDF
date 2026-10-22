import AppIntents
import Foundation
import UniformTypeIdentifiers
import WarraqCore

/// A document as Shortcuts and Siri name it: one the person opened
/// (recents) or one the Library indexed, by its key. Found by name, with
/// Arabic letters matched loosely.
struct DocumentEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Document")
    static let defaultQuery = DocumentQuery()

    /// The route that opens it.
    let id: String
    let name: String
    let pages: Int

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(pages) pages")
    }

    var route: AppRoute? {
        URL(string: id).flatMap(AppRoute.init(url:))
    }

    init(recent: RecentDocument) {
        id = AppRoute.open(id: recent.id).url.absoluteString
        name = recent.name
        pages = recent.pageCount
    }

    init(indexed: IndexedDocument) {
        id = AppRoute.openKey(indexed.key).url.absoluteString
        name = indexed.name
        pages = indexed.pages
    }
}

/// Where the entities come from: the recents list, and the Library's index
/// when it is open. Reads the shared container and the index file itself,
/// so a Shortcut can ask without the app in front.
struct DocumentQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [DocumentEntity] {
        let all = await Self.allDocuments()
        return identifiers.compactMap { id in all.first { $0.id == id } }
    }

    func entities(matching string: String) async throws -> [DocumentEntity] {
        let all = await Self.allDocuments()
        return all.filter { Self.matches($0.name, string) }
    }

    func suggestedEntities() async throws -> [DocumentEntity] {
        Array(await Self.allDocuments().prefix(10))
    }

    /// Diacritics and case aside, does `query` occur in `name`?
    static func matches(_ name: String, _ query: String) -> Bool {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty || name.range(of: trimmed, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]) != nil
    }

    /// Recents first, then what the index holds that the recents do not.
    static func allDocuments(store: RecentsStore = RecentsStore(), index: IndexReader = .shared) async -> [DocumentEntity] {
        var seen: Set<String> = []
        var result: [DocumentEntity] = []
        for recent in store.load() where recent.resolveURL() != nil {
            result.append(DocumentEntity(recent: recent))
            seen.insert(recent.name)
        }
        for document in await index.documents() where !seen.contains(document.name) {
            result.append(DocumentEntity(indexed: document))
            seen.insert(document.name)
        }
        return result
    }
}

/// The Library's index read by an intent, outside the Library's own
/// session: opened from its file when asked, closed after.
actor IndexReader {
    static let shared = IndexReader()

    let indexURL: URL
    let documentsFolder: URL
    let keysURL: URL

    init(indexURL: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "Library/library.wlx"),
         documentsFolder: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]) {
        self.indexURL = indexURL
        self.documentsFolder = documentsFolder
        self.keysURL = indexURL.deletingLastPathComponent().appending(path: "library-keys.json")
    }

    private func withIndex<T>(_ body: (LibraryIndex) async throws -> T) async throws -> T {
        let index = try await LibraryIndex.open(at: indexURL)
        defer { Task { await index.close() } }
        return try await body(index)
    }

    /// The documents the index holds, by the keys the last run wrote down.
    func documents() async -> [IndexedDocument] {
        guard FileManager.default.fileExists(atPath: indexURL.path),
              let keys = try? JSONDecoder().decode([String].self, from: Data(contentsOf: keysURL)) else { return [] }
        return (try? await withIndex { index in
            var found: [IndexedDocument] = []
            for key in keys.prefix(500) {
                if let document = try? await index.document(key: key) {
                    found.append(document)
                }
            }
            return found
        }) ?? []
    }

    func search(_ query: String, limit: Int) async -> SearchResult {
        guard FileManager.default.fileExists(atPath: indexURL.path) else { return .empty }
        return (try? await withIndex { try await $0.search(query, limit: limit) }) ?? .empty
    }
}

/// "Open <document>".
struct OpenDocumentIntent: AppIntent {
    static let title: LocalizedStringResource = "Open a document"
    static let description = IntentDescription("Opens one of your documents.")
    static let openAppWhenRun = true

    @Parameter(title: "Document")
    var document: DocumentEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$document)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let route = document.route else { return .result() }
        route.post()
        return .result()
    }
}

/// A line that matched, for Shortcuts to show or pass on.
struct SearchHitEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Match")
    static let defaultQuery = SearchHitQuery()

    let id: String
    let document: String
    let page: Int
    let text: String
    let key: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(document) — p. \(page)", subtitle: "\(text)")
    }
}

struct SearchHitQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [SearchHitEntity] { [] }
}

/// "Search my documents for <text>": the same Arabic-aware search as the
/// Library's, answered to Shortcuts as matches.
struct SearchDocumentsIntent: AppIntent {
    static let title: LocalizedStringResource = "Search my documents"
    static let description = IntentDescription("Finds every document holding the words, in Arabic or English, and says where.")

    @Parameter(title: "Text")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Search my documents for \(\.$text)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<[SearchHitEntity]> & ProvidesDialog {
        let result = await IndexReader.shared.search(text, limit: 50)
        let hits = result.hits.map {
            SearchHitEntity(id: $0.id, document: $0.name, page: $0.page, text: $0.text, key: $0.key)
        }
        let documents = Set(hits.map(\.key)).count
        let dialog: IntentDialog = hits.isEmpty
            ? IntentDialog("No document holds “\(text)”.")
            : IntentDialog("\(documents) documents hold “\(text)”, in \(hits.count) places.")
        return .result(value: hits, dialog: dialog)
    }
}

/// "Make a PDF from these files": PDFs and pictures in, one PDF out, saved
/// among My documents and handed back.
struct MakePDFIntent: AppIntent {
    static let title: LocalizedStringResource = "Make a PDF from files"
    static let description = IntentDescription("Joins PDFs and pictures into one PDF, saved in My documents.")

    @Parameter(title: "Files", supportedContentTypes: [.pdf, .image])
    var files: [IntentFile]

    @Parameter(title: "Name", default: "Combined")
    var name: String

    static var parameterSummary: some ParameterSummary {
        Summary("Make a PDF from \(\.$files) named \(\.$name)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<IntentFile> & ProvidesDialog {
        let inputs = files.map { (name: $0.filename, bytes: $0.data) }
        let bytes = try await PDFMaker.pdf(fromFiles: inputs)
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let cleaned = name.trimmingCharacters(in: .whitespaces).isEmpty ? "Combined" : name.trimmingCharacters(in: .whitespaces)
        var destination = folder.appending(path: "\(cleaned).pdf")
        var n = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            destination = folder.appending(path: "\(cleaned) \(n).pdf")
            n += 1
        }
        try bytes.write(to: destination, options: .atomic)
        let made = IntentFile(data: bytes, filename: destination.lastPathComponent, type: .pdf)
        return .result(value: made, dialog: IntentDialog("\(destination.deletingPathExtension().lastPathComponent) is in My documents."))
    }
}

/// The phrases Siri and Shortcuts offer for each intent.
struct PDFEditorShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ScanDocumentIntent(),
                    phrases: ["Scan a document with \(.applicationName)", "Scan with \(.applicationName)"],
                    shortTitle: "Scan a document", systemImageName: "doc.viewfinder")
        AppShortcut(intent: OpenDocumentIntent(),
                    phrases: ["Open a document in \(.applicationName)", "Open \(\.$document) in \(.applicationName)"],
                    shortTitle: "Open a document", systemImageName: "doc.text")
        AppShortcut(intent: SearchDocumentsIntent(),
                    phrases: ["Search my documents in \(.applicationName)", "Search \(.applicationName)"],
                    shortTitle: "Search my documents", systemImageName: "text.magnifyingglass")
        AppShortcut(intent: MakePDFIntent(),
                    phrases: ["Make a PDF with \(.applicationName)"],
                    shortTitle: "Make a PDF", systemImageName: "doc.badge.plus")
        AppShortcut(intent: OpenLastDocumentIntent(),
                    phrases: ["Open my last document in \(.applicationName)"],
                    shortTitle: "Last document", systemImageName: "clock.arrow.circlepath")
        AppShortcut(intent: AskZoodIntent(),
                    phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) about my document"],
                    shortTitle: "Ask ZOOD", systemImageName: "sparkles")
    }
}
