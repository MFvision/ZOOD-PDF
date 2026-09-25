import CoreSpotlight
import SwiftUI
import UniformTypeIdentifiers
import ZoodCore

/// iPad (regular width): NavigationSplitView with the sidebar of the web app.
/// iPhone (compact): tabs Home · Recents · Tools, each a NavigationStack.
struct RootView: View {
    @Environment(Library.self) private var library
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var router = WindowRouter()

    var body: some View {
        @Bindable var router = router
        Group {
            if sizeClass == .regular {
                SplitRoot()
            } else {
                CompactRoot()
            }
        }
        .environment(router)
        .toast($router.toast)
        .onOpenURL { router.handle(url: $0, library: library) }
        .onContinueUserActivity(CSSearchableItemActionType) { router.continueSpotlight($0, library: library) }
        .fileImporter(
            isPresented: Binding(get: { router.importerTool != nil }, set: { if !$0 { router.importerTool = nil } }),
            allowedContentTypes: [.pdf]
        ) { result in
            let tool = router.importerTool
            router.importerTool = nil
            if case .success(let url) = result {
                router.openFile(url, tool: tool, library: library)
            }
        }
        .fullScreenCover(item: Binding(
            get: { router.scanMode.map(ScanModeBox.init) },
            set: { router.scanMode = $0?.mode })
        ) { box in
            ScanScreen(initialMode: box.mode) { url in
                router.scanMode = nil
                router.openFile(url, library: library)
            }
        }
        .sheet(isPresented: $router.showCombine) {
            CombineView(seed: router.combineSeed) { url in
                router.showCombine = false
                router.openFile(url, library: library)
            }
        }
        .sheet(isPresented: $router.showMoreTools) {
            NavigationStack { ToolsGrid(dismissOnPick: true) }
                .presentationDetents([.medium, .large])
        }
        .dropDestination(for: PDFFile.self) { files, _ in
            guard let first = files.first else { return false }
            router.openFile(first.url, library: library)
            return true
        }
    }
}

struct ScanModeBox: Identifiable {
    let mode: DeepLink.ScanMode
    var id: String { mode.rawValue }
}

// MARK: - iPad

struct SplitRoot: View {
    @Environment(WindowRouter.self) private var router
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $columns) {
            SidebarView(selection: $router.sidebar)
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 340)
        } detail: {
            NavigationStack(path: $router.path) {
                DetailContent(item: router.sidebar ?? .home)
                    .navigationDestination(for: OpenedDocument.self) { DocumentScreen(document: $0) }
            }
        }
        .onChange(of: router.sidebar) { _, item in
            router.path = []
            if case .tool(let tool) = item {
                router.start(tool)
                router.sidebar = .home
            }
        }
    }
}

struct SidebarView: View {
    @Binding var selection: SidebarItem?
    @Environment(Library.self) private var library

    var body: some View {
        List(selection: $selection) {
            Section {
                AppMark()
                    .listRowBackground(Color.clear)
                    .selectionDisabled()
            }
            Section {
                Label("nav.home", systemImage: "house").tag(SidebarItem.home)
                Label("nav.recents", systemImage: "clock").tag(SidebarItem.recents)
                Label("nav.starred", systemImage: "star").tag(SidebarItem.starred)
                Label("nav.tags", systemImage: "tag").tag(SidebarItem.tags)
            }
            Section("nav.tools") {
                ForEach(ToolKind.tools) { tool in
                    Label {
                        Text(tool.title)
                    } icon: {
                        ToolTile(tool: tool, size: 26)
                    }
                    .tag(SidebarItem.tool(tool))
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(AppBackdrop())
    }
}

/// App mark + tagline at the top of the sidebar (original icon, no avatar/bell/quota).
struct AppMark: View {
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.text.fill")
                .font(.title2)
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(
                    LinearGradient(
                        colors: [Color(red: 0.31, green: 0.62, blue: 1), Color(red: 0.23, green: 0.39, blue: 0.94), Color(red: 0.48, green: 0.30, blue: 0.95)],
                        startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("app.name").font(.headline)
                Text("app.tagline").font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct DetailContent: View {
    let item: SidebarItem

    var body: some View {
        switch item {
        case .home, .tool: HomeView()
        case .recents: RecentsScreen(filter: .all)
        case .starred: RecentsScreen(filter: .starred)
        case .tags: TagsScreen()
        }
    }
}

// MARK: - iPhone

struct CompactRoot: View {
    @Environment(WindowRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.compactTab) {
            Tab("nav.home", systemImage: "house", value: WindowRouter.CompactTab.home) {
                NavigationStack(path: $router.path) {
                    HomeView()
                        .navigationDestination(for: OpenedDocument.self) { DocumentScreen(document: $0) }
                }
            }
            Tab("nav.recents", systemImage: "clock", value: WindowRouter.CompactTab.recents) {
                NavigationStack {
                    RecentsScreen(filter: .all)
                        .navigationDestination(for: OpenedDocument.self) { DocumentScreen(document: $0) }
                }
            }
            Tab("nav.tools", systemImage: "square.grid.2x2", value: WindowRouter.CompactTab.tools) {
                NavigationStack { ToolsGrid(dismissOnPick: false) }
            }
        }
    }
}
