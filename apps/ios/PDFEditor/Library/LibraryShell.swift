import CoreSpotlight
import SwiftUI
import UniformTypeIdentifiers

/// The sections of the Library: Home first, then the lists. Folder appears
/// once a folder is chosen in Settings; Clouds would join here when a
/// cloud drive exists on this device (none does), so it is not listed.
enum LibrarySection: String, CaseIterable, Identifiable {
    case home
    case recents
    case starred
    case documents
    case folder
    case tags

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .home: "Home"
        case .recents: "Recents"
        case .starred: "Starred"
        case .documents: "My documents"
        case .folder: "Folder"
        case .tags: "Tags"
        }
    }

    var symbol: String {
        switch self {
        case .home: "house"
        case .recents: "clock"
        case .starred: "star"
        case .documents: "folder"
        case .folder: "icloud"
        case .tags: "tag"
        }
    }
}

/// The tools the sidebar lists under "Tools": each one the app does today.
enum LibraryTool: String, CaseIterable, Identifiable {
    case scan
    case create
    case combine
    case search

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .scan: "Scan"
        case .create: "Create a PDF"
        case .combine: "Combine files"
        case .search: "Search"
        }
    }

    var symbol: String {
        switch self {
        case .scan: "doc.viewfinder"
        case .create: "photo.on.rectangle.angled"
        case .combine: "doc.on.doc"
        case .search: "text.magnifyingglass"
        }
    }
}

/// The Library: a three-column split view on iPad (sections and tools, the
/// section, the document), a stack on iPhone with Home at its root. Which
/// section and which document are on screen come back with the scene.
struct LibraryShell: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var library: LibraryModel
    @State private var lock = AppLock()
    @SceneStorage("library.section") private var sectionID = LibrarySection.home.rawValue
    @SceneStorage("library.document") private var restoredBookmark: String?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showingSettings = false
    @State private var showingImporter = false
    @State private var showingCombiner = false
    @State private var restored = false

    init() {
        #if DEBUG
        // A UI test keeps the app's documents in a folder of its own:
        // `-warraqDocumentsFolder <path>`.
        if let folder = UserDefaults.standard.string(forKey: "warraqDocumentsFolder"), !folder.isEmpty {
            _library = State(initialValue: LibraryModel(documentsFolder: URL(filePath: folder, directoryHint: .isDirectory)))
            return
        }
        #endif
        _library = State(initialValue: LibraryModel())
    }

    private var section: Binding<LibrarySection?> {
        Binding(
            get: { LibrarySection(rawValue: sectionID) ?? .home },
            set: { sectionID = ($0 ?? .home).rawValue }
        )
    }

    private var sections: [LibrarySection] {
        LibrarySection.allCases.filter { $0 != .folder || library.chosenFolder != nil }
    }

    private var actions: HomeActions {
        HomeActions(
            open: { showingImporter = true },
            scan: { library.scanRequested = true },
            create: { library.scanRequested = true },
            combine: { showingCombiner = true },
            search: { library.requestedSearch = "" },
            settings: { showingSettings = true }
        )
    }

    var body: some View {
        Group {
            if sizeClass == .compact {
                compact
            } else {
                regular
            }
        }
        .overlay {
            if lock.state != .unlocked {
                LockScreen(lock: lock)
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView(library: library)
        }
        // The scanner itself (part C): the camera where there is one, photos
        // where there is none; what it saves joins the Library and its index.
        .fullScreenCover(isPresented: $library.scanRequested) {
            ScanView(documentsFolder: library.documentsFolder) { url in
                library.refresh()
                library.indexNow()
                library.open(url: url)
            }
            .appEnvironment()
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.pdf]) { result in
            if case let .success(url) = result {
                library.open(url: url)
            }
        }
        .fileImporter(isPresented: $showingCombiner, allowedContentTypes: [.pdf, .image], allowsMultipleSelection: true) { result in
            if case let .success(urls) = result {
                library.combine(urls: urls)
            }
        }
        .onOpenURL { url in
            library.handle(url)
        }
        .onContinueUserActivity(CSSearchableItemActionType) { activity in
            if let key = SpotlightIndex.key(from: activity) {
                library.open(key: key)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: AppRoute.notification)) { _ in
            library.takePendingRoute()
        }
        .alert("Could not open", isPresented: Binding(get: { library.error != nil }, set: { if !$0 { library.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(library.error ?? "")
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            switch phase {
            case .active:
                library.takeInbox()
                library.refresh()
                library.takePendingRoute()
                Task {
                    await library.prepareIndex()
                    // Hosting unit tests, the app leaves the machine to them:
                    // the tests index folders of their own.
                    if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil {
                        library.indexNow()
                    }
                }
                Task { await lock.unlock() }
            case .background:
                lock.lock()
            default:
                break
            }
        }
        .onChange(of: library.opened?.id) {
            // The scene remembers the open document by a bookmark.
            restoredBookmark = library.opened?.url.flatMap { try? $0.bookmarkData(options: .minimalBookmark).base64EncodedString() }
        }
        .task {
            guard !restored else { return }
            restored = true
            AppGroup.setFlag("cameraAvailable", DocumentCameraView.isSupported)
            lock.lock()
            restoreScene()
        }
    }

    // MARK: - iPad

    private var regular: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: section) {
                Section {
                    ForEach(sections) { item in
                        Label {
                            if item == .folder, let folder = library.chosenFolder {
                                Text(folder.name)
                            } else {
                                Text(item.title)
                            }
                        } icon: {
                            Image(systemName: item.symbol)
                        }
                        .tag(item)
                        .accessibilityIdentifier("sidebar.\(item.rawValue)")
                    }
                } header: {
                    VStack(alignment: .leading, spacing: Space.x1) {
                        Text("Library")
                        Text("Nothing leaves this device.")
                            .font(TextStyle.caption)
                            .textCase(nil)
                    }
                }
                Section("Tools") {
                    ForEach(LibraryTool.allCases) { tool in
                        Button {
                            run(tool)
                        } label: {
                            Label(tool.title, systemImage: tool.symbol)
                        }
                        .accessibilityIdentifier("tool.\(tool.rawValue)")
                    }
                }
            }
            // The sidebar takes the theme's ground; on the system theme it
            // keeps the system's own source-list material.
            .themedScrollBackground()
            .navigationTitle(Text(verbatim: AppName.isolated))
        } content: {
            // The actions sit with the content, where the design target puts
            // them, and where they are in portrait too (the sidebar is then
            // an overlay).
            SearchHost(library: library) {
                content(for: section.wrappedValue ?? .home)
            }
            .navigationTitle(section.wrappedValue?.title ?? "Home")
            .toolbar { libraryToolbar }
            .themedToolbar()
            .navigationDestination(for: LibrarySection.self) { section in
                content(for: section)
                    .navigationTitle(section.title)
            }
        } detail: {
            if let opened = library.opened {
                DocumentView(model: opened)
                    .id(opened.id)
            } else {
                EmptyState(symbol: "doc.text", title: "No document open", message: "Choose a document, or open one from Files.", actionTitle: "Open…") {
                    showingImporter = true
                }
                .background(Surface.underPage)
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    private func run(_ tool: LibraryTool) {
        switch tool {
        case .scan: actions.scan()
        case .create: actions.create()
        case .combine: actions.combine()
        case .search: actions.search()
        }
    }

    @ViewBuilder
    private func content(for section: LibrarySection) -> some View {
        switch section {
        case .home: HomeView(library: library, actions: actions)
        case .tags: TagsView(library: library)
        default: DocumentGrid(library: library, section: section)
        }
    }

    // MARK: - iPhone

    private var compact: some View {
        NavigationStack {
            SearchHost(library: library) {
                HomeView(library: library, actions: actions)
            }
            .navigationTitle(Text(verbatim: AppName.isolated))
            .toolbar { libraryToolbar }
            .themedToolbar()
            .navigationDestination(item: $library.opened) { model in
                DocumentView(model: model)
            }
            .navigationDestination(for: LibrarySection.self) { section in
                content(for: section)
                    .navigationTitle(section.title)
            }
        }
    }

    @ToolbarContentBuilder
    private var libraryToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button("Scan", systemImage: "doc.viewfinder") {
                library.scanRequested = true
            }
            .accessibilityIdentifier("library.scan")
            Button("Open…", systemImage: "folder.badge.plus") {
                showingImporter = true
            }
        }
    }

    // MARK: - Restoring

    private func restoreScene() {
        #if DEBUG
        // A UI test, or a run from the command line: `-warraqReset 1` starts
        // from an empty Library, `-warraqImport <folder>` copies its PDFs and
        // pictures into Documents, `-warraqOpen <path>` opens a file.
        if UserDefaults.standard.bool(forKey: "warraqReset") {
            try? library.store.clear()
            restoredBookmark = nil
            library.refresh()
        }
        // `-warraqFresh 1`: the home screen and nothing over it — no document
        // restored from the last scene, no route another test left (a
        // Shortcut's "Scan"), so the test sees what it looks for.
        // It also empties My documents, the index and the thumbnails, so a
        // test starts from the files it imports and nothing an earlier run left.
        if UserDefaults.standard.bool(forKey: "warraqFresh") {
            _ = AppRoute.takePending()
            library.scanRequested = false
            library.requestedSearch = nil
            library.closeDocument()
            restoredBookmark = nil
            sectionID = LibrarySection.home.rawValue
            let files = (try? FileManager.default.contentsOfDirectory(at: library.documentsFolder, includingPropertiesForKeys: nil)) ?? []
            for file in files { try? FileManager.default.removeItem(at: file) }
            try? FileManager.default.removeItem(at: library.indexURL.deletingLastPathComponent())
            try? FileManager.default.removeItem(at: AppGroup.thumbnailsURL)
            try? library.store.clear()
            try? library.stars.clear()
            library.refresh()
            if UserDefaults.standard.string(forKey: "warraqOpen") == nil, UserDefaults.standard.string(forKey: "warraqImport") == nil {
                return
            }
        }
        if let folder = UserDefaults.standard.string(forKey: "warraqImport"), !folder.isEmpty {
            let source = URL(filePath: folder, directoryHint: .isDirectory)
            let files = (try? FileManager.default.contentsOfDirectory(at: source, includingPropertiesForKeys: nil)) ?? []
            for file in files where file.pathExtension.lowercased() == "pdf" || LibraryFileKind.imageExtensions.contains(file.pathExtension.lowercased()) {
                let destination = library.documentsFolder.appending(path: file.lastPathComponent)
                if !FileManager.default.fileExists(atPath: destination.path) {
                    try? FileManager.default.copyItem(at: file, to: destination)
                }
            }
            library.refresh()
            library.indexNow()
        }
        if let path = UserDefaults.standard.string(forKey: "warraqOpen"), !path.isEmpty {
            library.open(url: URL(filePath: path))
            return
        }
        if let photos = UserDefaults.standard.string(forKey: "warraqScan"), !photos.isEmpty {
            library.scanRequested = true
            return
        }
        #endif
        if let restoredBookmark, let data = Data(base64Encoded: restoredBookmark) {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale) {
                library.open(url: url)
            }
        }
    }
}

/// The search field above a screen: while a query is typed the screen is
/// the Library's results (inside every document); a search asked for from
/// outside (a widget, a Shortcut, the Search card) opens the field.
struct SearchHost<Content: View>: View {
    let library: LibraryModel
    @ViewBuilder let content: Content
    @State private var query = ""
    @State private var presented = false
    @State private var filters = SearchFilters.none

    var body: some View {
        Group {
            if !query.isEmpty {
                LibrarySearchResults(library: library, query: query, filters: $filters)
            } else {
                content
            }
        }
        .searchable(text: $query, isPresented: $presented, prompt: Text("Search inside every document"))
        .onSubmit(of: .search) {
            Task {
                let result = await library.search(query, filters: filters)
                library.rememberSearch(query, hits: result.total)
            }
        }
        .onChange(of: library.requestedSearch, initial: true) { _, requested in
            if let requested {
                query = requested
                presented = true
                library.requestedSearch = nil
            }
        }
    }
}

/// The documents of a section as a grid of first pages. Starred shows what
/// was starred from every source.
struct DocumentGrid: View {
    let library: LibraryModel
    let section: LibrarySection
    @State private var pendingDelete: LocalDocument?
    @State private var tagging: IndexedDocument?
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows

    private let columns = [GridItem(.adaptive(minimum: 140, maximum: 200), spacing: Space.x5, alignment: .top)]

    var body: some View {
        ScrollView {
            IndexStatusView(library: library)
            LazyVGrid(columns: columns, alignment: .leading, spacing: Space.x6) {
                switch section {
                case .recents:
                    ForEach(library.recents) { recent in
                        recentCell(recent)
                    }
                case .documents:
                    ForEach(library.documents) { local in
                        localCell(local)
                    }
                case .folder:
                    ForEach(library.folderFiles) { file in
                        folderCell(file)
                    }
                case .starred:
                    ForEach(library.starredItems) { item in
                        itemCell(item)
                    }
                default:
                    EmptyView()
                }
            }
            .padding(.horizontal, Space.x5)
            .padding(.vertical, Space.x4)
        }
        .themedGround(systemColour: Surface.window)
        .overlay {
            if isEmpty {
                emptyState
            }
        }
        .refreshable {
            library.refresh()
            library.indexNow()
        }
        .accessibilityIdentifier("library.grid")
        .confirmationDialog("Delete this document?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible, presenting: pendingDelete) { local in
            Button("Delete", role: .destructive) {
                library.delete(local)
            }
        } message: { local in
            Text("\(local.name) will be deleted from this device.")
        }
        .sheet(item: $tagging) { document in
            DocumentTagsSheet(library: library, document: document)
        }
    }

    private var isEmpty: Bool {
        switch section {
        case .recents: library.recents.isEmpty
        case .documents: library.documents.isEmpty
        case .folder: library.folderFiles.isEmpty
        case .starred: library.starredItems.isEmpty
        default: true
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        switch section {
        case .documents:
            EmptyState(symbol: "folder", title: "No documents yet", message: "PDFs saved here from the share sheet, and scans, appear in this list.")
        case .folder:
            EmptyState(symbol: "icloud", title: "Nothing in this folder yet", message: "PDFs and pictures in the chosen folder appear here once they are on this device.")
        case .starred:
            EmptyState(symbol: "star", title: "Nothing starred yet", message: "Star a document from its menu to keep it here.")
        default:
            EmptyState(symbol: "clock", title: "Nothing opened yet", message: "Documents you open appear here, with their first page.")
        }
    }

    @ViewBuilder
    private func starButton(_ url: URL?) -> some View {
        if let url {
            let starred = library.isStarred(url)
            Button(starred ? "Unstar" : "Star", systemImage: starred ? "star.slash" : "star") {
                library.toggleStar(url)
            }
        }
    }

    private func recentCell(_ recent: RecentDocument) -> some View {
        DocumentGridCell(
            name: recent.name,
            detail: Text("\(recent.pageCount) pages · \(recent.lastOpened, format: .relative(presentation: .named))"),
            thumbnail: recent.thumbnailURL.flatMap { UIImage(contentsOfFile: $0.path) }
        ) {
            library.open(recent)
        }
        .contextMenu {
            starButton(recent.resolveURL())
            if supportsMultipleWindows, let url = recent.resolveURL(), let reference = DocumentReference(url: url) {
                Button("Open in New Window", systemImage: "macwindow.badge.plus") {
                    openWindow(id: "document", value: reference)
                }
            }
            Button("Remove from Recents", systemImage: "clock.badge.xmark") {
                library.forget(recent)
            }
        }
        .draggableToNewWindow(recent.resolveURL().flatMap(DocumentReference.init(url:)), enabled: supportsMultipleWindows)
        .accessibilityIdentifier("recent.\(recent.id.uuidString)")
    }

    private func localCell(_ local: LocalDocument) -> some View {
        let indexed = library.indexer?.catalog[local.key]
        return DocumentGridCell(
            name: local.name,
            detail: detail(for: local, indexed: indexed),
            thumbnail: library.thumbnail(forKey: local.key, url: local.url)
        ) {
            library.open(local)
        }
        .contextMenu {
            starButton(local.url)
            if supportsMultipleWindows, let reference = DocumentReference(url: local.url) {
                Button("Open in New Window", systemImage: "macwindow.badge.plus") {
                    openWindow(id: "document", value: reference)
                }
            }
            if let indexed {
                Button("Tags…", systemImage: "tag") {
                    tagging = indexed
                }
            }
            Button("Delete", systemImage: "trash", role: .destructive) {
                pendingDelete = local
            }
        }
        .draggableToNewWindow(DocumentReference(url: local.url), enabled: supportsMultipleWindows)
        .accessibilityIdentifier("document.\(local.name)")
    }

    private func detail(for local: LocalDocument, indexed: IndexedDocument?) -> Text {
        let size = Text("\(Int64(local.size), format: .byteCount(style: .file)) · \(local.modified, format: .relative(presentation: .named))")
        guard let indexed, !indexed.tags.isEmpty else { return size }
        return size + Text(verbatim: " · ") + Text(indexed.tags.joined(separator: ", "))
    }

    private func folderCell(_ file: LibraryFile) -> some View {
        let indexed = library.indexer?.catalog[file.key]
        return DocumentGridCell(
            name: file.name,
            detail: indexed.map { Text("\($0.pages) pages · \($0.kind.text)") } ?? Text("Not indexed yet"),
            thumbnail: library.thumbnail(forKey: file.key, url: file.url)
        ) {
            library.open(key: file.key)
        }
        .contextMenu {
            starButton(file.url)
            if let indexed {
                Button("Tags…", systemImage: "tag") {
                    tagging = indexed
                }
            }
        }
        .accessibilityIdentifier("folderFile.\(file.name)")
    }

    private func itemCell(_ item: LibraryItem) -> some View {
        DocumentGridCell(
            name: item.name,
            detail: Text(DocumentDate.text(item.date)),
            thumbnail: library.thumbnail(for: item)
        ) {
            library.open(item)
        }
        .contextMenu {
            starButton(item.url)
        }
        .accessibilityIdentifier("starred.\(item.name)")
    }
}

extension View {
    /// On iPad, a cell dragged out of the app and dropped at the screen's
    /// edge opens its document in a new window (the `document` scene takes
    /// a `DocumentReference`).
    @ViewBuilder
    func draggableToNewWindow(_ reference: DocumentReference?, enabled: Bool) -> some View {
        if enabled, let reference {
            draggable(reference)
        } else {
            self
        }
    }
}
