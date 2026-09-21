import SwiftUI
import UniformTypeIdentifiers

/// The sections of the Library. Others (Scans, Tags, Folders) join as the
/// features behind them are built; nothing is listed before it works.
enum LibrarySection: String, CaseIterable, Identifiable {
    case recents
    case documents

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .recents: "Recents"
        case .documents: "My documents"
        }
    }

    var symbol: String {
        switch self {
        case .recents: "clock"
        case .documents: "folder"
        }
    }
}

/// The Library: a three-column split view on iPad (sections, documents, the
/// document), a stack on iPhone. Which section and which document are on
/// screen come back with the scene.
struct LibraryShell: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var library: LibraryModel
    @SceneStorage("library.section") private var sectionID = LibrarySection.recents.rawValue
    @SceneStorage("library.document") private var restoredBookmark: String?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showingSettings = false
    @State private var showingImporter = false
    @State private var showingScanner = false
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
            get: { LibrarySection(rawValue: sectionID) ?? .recents },
            set: { sectionID = ($0 ?? .recents).rawValue }
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
        .sheet(isPresented: $showingSettings) {
            SettingsView()
        }
        .fullScreenCover(isPresented: $showingScanner) {
            ScanView(documentsFolder: library.documentsFolder) { url in
                library.refresh()
                library.open(url: url)
            }
            .appEnvironment()
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.pdf]) { result in
            if case let .success(url) = result {
                library.open(url: url)
            }
        }
        .onOpenURL { url in
            library.handle(url)
        }
        .alert("Could not open", isPresented: Binding(get: { library.error != nil }, set: { if !$0 { library.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(library.error ?? "")
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            if phase == .active {
                library.takeInbox()
                library.refresh()
            }
        }
        .onChange(of: library.opened?.id) {
            // The scene remembers the open document by a bookmark.
            restoredBookmark = library.opened?.url.flatMap { try? $0.bookmarkData(options: .minimalBookmark).base64EncodedString() }
        }
        .task {
            guard !restored else { return }
            restored = true
            restoreScene()
        }
    }

    // MARK: - iPad

    private var regular: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: section) {
                Section("Library") {
                    ForEach(LibrarySection.allCases) { item in
                        Label(item.title, systemImage: item.symbol)
                            .tag(item)
                            .accessibilityIdentifier("sidebar.\(item.rawValue)")
                    }
                }
            }
            .navigationTitle(Text(verbatim: AppName.plain))
            .toolbar { libraryToolbar }
        } content: {
            DocumentGrid(library: library, section: section.wrappedValue)
                .navigationTitle(section.wrappedValue?.title ?? "Recents")
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

    // MARK: - iPhone

    private var compact: some View {
        NavigationStack {
            DocumentGrid(library: library, section: nil)
                .navigationTitle(Text(verbatim: AppName.plain))
                .toolbar { libraryToolbar }
                .navigationDestination(item: $library.opened) { model in
                    DocumentView(model: model)
                }
        }
    }

    @ToolbarContentBuilder
    private var libraryToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button("Scan", systemImage: "doc.viewfinder") {
                showingScanner = true
            }
            .accessibilityIdentifier("library.scan")
            Button("Open…", systemImage: "folder.badge.plus") {
                showingImporter = true
            }
            .accessibilityIdentifier("library.open")
            Button("Settings", systemImage: "gearshape") {
                showingSettings = true
            }
            .accessibilityIdentifier("library.settings")
        }
    }

    // MARK: - Restoring

    private func restoreScene() {
        #if DEBUG
        // A UI test, or a run from the command line: `-warraqOpen <path>`;
        // `-warraqScan <path>[,…]` opens the scanner on those photos.
        if let path = UserDefaults.standard.string(forKey: "warraqOpen"), !path.isEmpty {
            library.open(url: URL(filePath: path))
            return
        }
        if let photos = UserDefaults.standard.string(forKey: "warraqScan"), !photos.isEmpty {
            showingScanner = true
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

/// The documents of a section as a grid of first pages; on iPhone all
/// sections, one after the other. Searching filters by name.
struct DocumentGrid: View {
    let library: LibraryModel
    /// One section, or nil for all of them with headings.
    let section: LibrarySection?
    @State private var query = ""
    @State private var pendingDelete: LocalDocument?
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows

    private let columns = [GridItem(.adaptive(minimum: 140, maximum: 200), spacing: Space.x5, alignment: .top)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, alignment: .leading, spacing: Space.x6) {
                if section == nil || section == .recents {
                    gridSection(.recents, isEmpty: recents.isEmpty) {
                        ForEach(recents) { recent in
                            recentCell(recent)
                        }
                    }
                }
                if section == nil || section == .documents {
                    gridSection(.documents, isEmpty: documents.isEmpty) {
                        ForEach(documents) { local in
                            localCell(local)
                        }
                    }
                }
            }
            .padding(.horizontal, Space.x5)
            .padding(.vertical, Space.x4)
        }
        .background(Surface.window)
        .overlay {
            if recents.isEmpty, documents.isEmpty {
                emptyState
            }
        }
        .searchable(text: $query, prompt: Text("Search by name"))
        .accessibilityIdentifier("library.grid")
        .confirmationDialog("Delete this document?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible, presenting: pendingDelete) { local in
            Button("Delete", role: .destructive) {
                library.delete(local)
            }
        } message: { local in
            Text("\(local.name) will be deleted from this device.")
        }
    }

    private var recents: [RecentDocument] {
        library.recents.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
    }

    private var documents: [LocalDocument] {
        library.documents.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
    }

    @ViewBuilder
    private func gridSection<Cells: View>(_ which: LibrarySection, isEmpty: Bool, @ViewBuilder cells: () -> Cells) -> some View {
        if section == nil, !isEmpty {
            Section {
                cells()
            } header: {
                Text(which.title)
                    .font(TextStyle.headline)
                    .foregroundStyle(Surface.secondaryLabel)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Space.x3)
            }
        } else {
            cells()
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !query.isEmpty {
            ContentUnavailableView.search(text: query)
        } else if section == .documents {
            EmptyState(symbol: "folder", title: "No documents yet", message: "PDFs saved here from the share sheet, and scans, appear in this list.")
        } else {
            EmptyState(symbol: "clock", title: "Nothing opened yet", message: "Documents you open appear here, with their first page.")
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
            if supportsMultipleWindows, let url = recent.resolveURL(), let reference = DocumentReference(url: url) {
                Button("Open in New Window", systemImage: "macwindow.badge.plus") {
                    openWindow(id: "document", value: reference)
                }
            }
            Button("Remove from Recents", systemImage: "clock.badge.xmark") {
                library.forget(recent)
            }
        }
        .accessibilityIdentifier("recent.\(recent.id.uuidString)")
    }

    private func localCell(_ local: LocalDocument) -> some View {
        DocumentGridCell(
            name: local.name,
            detail: Text("\(Int64(local.size), format: .byteCount(style: .file)) · \(local.modified, format: .relative(presentation: .named))"),
            thumbnail: library.recents.first { $0.resolveURL()?.standardizedFileURL == local.url.standardizedFileURL }?
                .thumbnailURL.flatMap { UIImage(contentsOfFile: $0.path) }
        ) {
            library.open(local)
        }
        .contextMenu {
            if supportsMultipleWindows, let reference = DocumentReference(url: local.url) {
                Button("Open in New Window", systemImage: "macwindow.badge.plus") {
                    openWindow(id: "document", value: reference)
                }
            }
            Button("Delete", systemImage: "trash", role: .destructive) {
                pendingDelete = local
            }
        }
        .accessibilityIdentifier("document.\(local.name)")
    }
}
