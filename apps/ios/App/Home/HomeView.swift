import SwiftUI
import ZoodCore

/// Home: hero «ملفات PDF، من جديد», six action cards, Recents with real thumbnails.
/// No avatar, bell or storage quota — there are no accounts.
struct HomeView: View {
    @Environment(Library.self) private var library
    @Environment(WindowRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var query = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if query.isEmpty {
                    hero
                    actionCards
                    recentsSection
                } else {
                    SearchResults(query: query)
                }
            }
            .padding(sizeClass == .regular ? 32 : 16)
            .frame(maxWidth: 1100, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(AppBackdrop())
        .navigationTitle(Text("nav.home"))
        .toolbarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: Text("search.placeholder"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("plus.open", systemImage: "folder") { router.start(.open) }
                    Button("plus.scan", systemImage: "doc.viewfinder") { router.start(.scan) }
                    Button("plus.combine", systemImage: "square.stack.3d.down.right") { router.start(.combine) }
                } label: {
                    Label("plus.label", systemImage: "plus")
                }
                .accessibilityIdentifier("home.plus")
            }
        }
        .refreshable { await library.refresh() }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("home.hero.title")
                .font(.system(size: sizeClass == .regular ? 44 : 32, weight: .bold, design: .default))
                .accessibilityAddTraits(.isHeader)
            Text("home.hero.subtitle")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 8)
    }

    private var actionCards: some View {
        let columns = [GridItem(.adaptive(minimum: sizeClass == .regular ? 160 : 150), spacing: 14)]
        return LazyVGrid(columns: columns, spacing: 14) {
            ForEach(ToolKind.homeCards) { tool in
                Button { router.start(tool) } label: {
                    ActionCard(tool: tool)
                }
                .buttonStyle(PressableStyle())
                .accessibilityIdentifier("card.\(tool.rawValue)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("home.actions"))
    }

    private var recentsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("home.recents.title").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                if !library.recents.isEmpty {
                    Button("home.recents.seeAll") {
                        if sizeClass == .regular { router.sidebar = .recents } else { router.compactTab = .recents }
                    }
                }
            }
            if library.recents.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("home.recents.empty").foregroundStyle(.secondary)
                    Button("home.recents.emptyAction") { router.start(.open) }
                        .buttonStyle(.borderedProminent)
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glass()
            } else {
                RecentsGrid(items: Array(library.recents.prefix(sizeClass == .regular ? 8 : 6)))
            }
        }
    }
}

struct ActionCard: View {
    let tool: ToolKind

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ToolTile(tool: tool, size: 40)
            Text(tool.title).font(.headline).foregroundStyle(.primary)
            Text(tool.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
        }
        .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
        .padding(16)
        .glass(Theme.radiusLarge)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

struct SearchResults: View {
    let query: String
    @Environment(Library.self) private var library

    var body: some View {
        let results = library.search(query)
        VStack(alignment: .leading, spacing: 12) {
            if results.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                RecentsGrid(items: results)
            }
        }
    }
}
