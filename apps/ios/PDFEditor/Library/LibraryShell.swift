import CoreSpotlight
import SwiftUI
import UniformTypeIdentifiers

/// The sections of the Library. Folder appears once a folder is chosen in
/// Settings; nothing is listed before it works.
enum LibrarySection: String, CaseIterable, Identifiable {
    case recents
    case documents
    case folder
    case tags

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .recents: "Recents"
        case .documents: "My documents"
        case .folder: "Folder"
        case .tags: "Tags"
        }
    }

    var symbol: String {
        switch self {
        case .recents: "clock"
        case .documents: "folder"
        case .folder: "icloud"
        case .tags: "tag"
        }
    }
}

/// The Library: a three-column split view on iPad (sections, documents, the
/// document), a stack on iPhone. Which section and which document are on
/// screen come back with the scene. Search above the documents searches
/// inside every document the index holds.
struct LibraryShell: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var library = LibraryModel()
    @State private var lock = AppLock()
    @SceneStorage("library.section") private var sectionID = LibrarySection.recents.rawValue
    @SceneStorage("library.document") private var restoredBookmark: String?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showingSettings = false
    @State private var showingImporter = false
    @State private var restored = false

    private var section: Binding<LibrarySection?> {
        Binding(
            get: { LibrarySection(rawValue: sectionID) ?? .recents },
            set: { sectionID = ($0 ?? .recents).rawValue }
        )
    }

    private var sections: [LibrarySection] {
        LibrarySection.allCases.filter { $0 != .folder || library.chosenFolder != nil }
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
        .sheet(isPresented: $library.scanRequested) {
            ScanEntry(library: library)
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.pdf]) { result in
            if case let .success(url) = result {
                library.open(url: url)
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
                    library.indexNow()
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
            AppGroup.sharedDefaults.set(ScanEntry.cameraAvailable, forKey: "cameraAvailable")
            lock.lock()
            restoreScene()
        }
    }

    // MARK: - iPad

    private var regular: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: section) {
                Section("Library") {
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
                }
            }
            .navigationTitle(Text(verbatim: AppName.isolated))
            .toolbar { libraryToolbar }
        } content: {
            content(for: section.wrappedValue ?? .recents)
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

    @ViewBuilder
    private func content(for section: LibrarySection) -> some View {
        if section == .tags {
            TagsView(library: library)
        } else {
            DocumentGrid(library: library, section: section)
        }
    }

    // MARK: - iPhone

    private var compact: some View {
        NavigationStack {
            DocumentGrid(library: library, section: nil)
                .navigationTitle(Text(verbatim: AppName.isolated))
                .toolbar { libraryToolbar }
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
        // A UI test, or a run from the command line: `-warraqReset 1` starts
        // from an empty Library, `-warraqImport <folder>` copies its PDFs and
        // pictures into Documents, `-warraqOpen <path>` opens a file.
        if UserDefaults.standard.bool(forKey: "warraqReset") {
            try? library.store.clear()
            restoredBookmark = nil
            library.refresh()
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
/// sections, one after the other, with Tags and the chosen folder as rows
/// above. Searching searches inside every document the index holds.
struct DocumentGrid: View {
    let library: LibraryModel
    /// One section, or nil for all of them with headings.
    let section: LibrarySection?
    @State private var query = ""
    @State private var filters = SearchFilters.none
    @State private var pendingDelete: LocalDocument?
    @State private var tagging: IndexedDocument?
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows

    private let columns = [GridItem(.adaptive(minimum: 140, maximum: 200), spacing: Space.x5, alignment: .top)]

    var body: some View {
        Group {
            if !query.isEmpty {
                LibrarySearchResults(library: library, query: query, filters: $filters)
            } else {
                grid
            }
        }
        .searchable(text: $query, prompt: Text("Search inside every document"))
        .onSubmit(of: .search) {
            Task {
                let result = await library.search(query, filters: filters)
                library.rememberSearch(query, hits: result.total)
            }
        }
        .onChange(of: library.requestedSearch, initial: true) { _, requested in
            if let requested {
                query = requested
                library.requestedSearch = nil
            }
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

    private var grid: some View {
        ScrollView {
            IndexStatusView(library: library)
            if section == nil {
                compactSections
            }
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
                if section == .folder || (section == nil && !library.folderFiles.isEmpty) {
                    gridSection(.folder, isEmpty: library.folderFiles.isEmpty) {
                        ForEach(library.folderFiles) { file in
                            folderCell(file)
                        }
                    }
                }
            }
            .padding(.horizontal, Space.x5)
            .padding(.vertical, Space.x4)
        }
        .background(Surface.window)
        .overlay {
            if recents.isEmpty, documents.isEmpty, section != .folder || library.folderFiles.isEmpty {
                emptyState
            }
        }
        .refreshable {
            library.refresh()
            library.indexNow()
        }
    }

    /// On iPhone: Tags and the chosen folder as rows into their screens.
    private var compactSections: some View {
        VStack(spacing: 0) {
            NavigationLink(value: LibrarySection.tags) {
                row(LibrarySection.tags.title, symbol: "tag", detail: Text((library.indexer?.stats.tags.count ?? 0), format: .number))
            }
            .accessibilityIdentifier("sidebar.tags")
            if let folder = library.chosenFolder {
                Divider().padding(.leading, Space.x10)
                NavigationLink(value: LibrarySection.folder) {
                    row(LocalizedStringKey(folder.name), symbol: "icloud", detail: Text(library.folderFiles.count, format: .number))
                }
                .accessibilityIdentifier("sidebar.folder")
            }
        }
        .background(Surface.grouped, in: RoundedRectangle(cornerRadius: Radius.group, style: .continuous))
        .padding(.horizontal, Space.x5)
        .padding(.top, Space.x3)
    }

    private func row(_ title: LocalizedStringKey, symbol: String, detail: Text) -> some View {
        HStack {
            Label(title, systemImage: symbol)
            Spacer()
            detail.foregroundStyle(Surface.secondaryLabel).tabularNumbers()
            Image(systemName: "chevron.forward").font(TextStyle.caption).foregroundStyle(Surface.tertiaryLabel)
        }
        .padding(.horizontal, Space.x5)
        .padding(.vertical, Space.x4)
        .contentShape(Rectangle())
    }

    private var recents: [RecentDocument] { library.recents }
    private var documents: [LocalDocument] { library.documents }

    @ViewBuilder
    private func gridSection<Cells: View>(_ which: LibrarySection, isEmpty: Bool, @ViewBuilder cells: () -> Cells) -> some View {
        if section == nil, !isEmpty {
            Section {
                cells()
            } header: {
                Text(which == .folder ? LocalizedStringKey(library.chosenFolder?.name ?? "") : which.title)
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
        if section == .documents {
            EmptyState(symbol: "folder", title: "No documents yet", message: "PDFs saved here from the share sheet, and scans, appear in this list.")
        } else if section == .folder {
            EmptyState(symbol: "icloud", title: "Nothing in this folder yet", message: "PDFs and pictures in the chosen folder appear here once they are on this device.")
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
        let indexed = library.indexer?.catalog[local.key]
        return DocumentGridCell(
            name: local.name,
            detail: detail(for: local, indexed: indexed),
            thumbnail: library.thumbnail(forKey: local.key, url: local.url)
        ) {
            library.open(local)
        }
        .contextMenu {
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
            if let indexed {
                Button("Tags…", systemImage: "tag") {
                    tagging = indexed
                }
            }
        }
        .accessibilityIdentifier("folderFile.\(file.name)")
    }
}
