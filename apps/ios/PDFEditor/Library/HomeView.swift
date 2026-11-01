import SwiftUI

/// The home screen, to the owner's design target: a calm, translucent
/// space — a greeting by the time of day, the headline, a row of large
/// action cards (each a thing the app does now), then rows of real
/// first pages: Recents, Starred, My documents, the chosen folder. On
/// iPhone the sections below are rows into their screens. Search above it
/// searches inside every document.
struct HomeView: View {
    let library: LibraryModel
    let actions: HomeActions
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.appTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.x7) {
                IndexStatusView(library: library)
                hero
                    .padding(.horizontal, Space.x5)
                ActionCardsRow(actions: actions)
                    .padding(.horizontal, Space.x5)
                DocumentRow(library: library, title: "Recents", section: .recents, items: library.recents.map(library.item),
                            emptyMessage: "Documents you open appear here, with their first page.")
                if !library.starredItems.isEmpty {
                    DocumentRow(library: library, title: "Starred", section: .starred, items: library.starredItems, emptyMessage: nil)
                }
                DocumentRow(library: library, title: "My documents", section: .documents, items: library.documents.map(library.item),
                            emptyMessage: "PDFs saved here from the share sheet, and scans, appear in this row.")
                if library.chosenFolder != nil {
                    DocumentRow(library: library, title: LocalizedStringKey(library.chosenFolder?.name ?? ""), section: .folder,
                                items: library.folderFiles.map(library.item), emptyMessage: "Nothing in this folder is on this device yet.")
                }
                if sizeClass == .compact {
                    compactSections
                }
            }
            .padding(.vertical, Space.x5)
        }
        // Pulling down reads the Library's folders again.
        .refreshable { library.refresh() }
        .themedGround()
        .accessibilityIdentifier("library.home")
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: Space.x3) {
            // The app's own mark, the same drawing as the icon on the Home
            // Screen, beside the greeting.
            HStack(spacing: Space.x4) {
                ZoodMark(size: 34)
                Text(Self.greeting())
                    .themeFont(.subheadline)
                    .foregroundStyle(Surface.secondaryLabel)
            }
            Text("PDFs, done right.")
                .themeFont(.display)
                .foregroundStyle(Surface.label)
                .fixedSize(horizontal: false, vertical: true)
            Text("Open, scan, search — everything stays on this device.")
                .themeFont(.body)
                .foregroundStyle(Surface.secondaryLabel)
                .fixedSize(horizontal: false, vertical: true)
        }
        // On ZOOD's theme the hero is a panel of its own, as the brand's
        // envelope is (guide p. 30): the woven pattern on the trailing side
        // of an iPad's, along the top of a phone's — never under the words.
        .frame(maxWidth: theme == .zood && sizeClass == .regular ? 440 : .infinity, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(theme == .zood ? Space.x6 : 0)
        .padding(.top, theme == .zood && sizeClass != .regular ? ZoodHeroPanel.band : 0)
        .background {
            if theme == .zood {
                ZoodHeroPanel(alongTop: sizeClass != .regular)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("home.hero")
    }

    /// By the time of day only: there is no account to greet by name.
    static func greeting(now: Date = .now) -> LocalizedStringKey {
        switch Calendar.current.component(.hour, from: now) {
        case 5..<12: "Good morning"
        case 12..<17: "Good afternoon"
        default: "Good evening"
        }
    }

    // MARK: - iPhone rows into the sections

    private var compactSections: some View {
        VStack(spacing: 0) {
            sectionRow(.documents, detail: library.documents.count)
            Divider().padding(.leading, Space.x10)
            sectionRow(.recents, detail: library.recents.count)
            Divider().padding(.leading, Space.x10)
            sectionRow(.starred, detail: library.starredItems.count)
            Divider().padding(.leading, Space.x10)
            sectionRow(.tags, detail: library.indexer?.stats.tags.count ?? 0)
            if let folder = library.chosenFolder {
                Divider().padding(.leading, Space.x10)
                NavigationLink(value: LibrarySection.folder) {
                    row(Text(verbatim: folder.name), symbol: LibrarySection.folder.symbol, detail: library.folderFiles.count)
                }
                .accessibilityIdentifier("sidebar.folder")
            }
        }
        .themedCard()
        .padding(.horizontal, Space.x5)
    }

    private func sectionRow(_ section: LibrarySection, detail: Int) -> some View {
        NavigationLink(value: section) {
            row(Text(section.title), symbol: section.symbol, detail: detail)
        }
        .accessibilityIdentifier("sidebar.\(section.rawValue)")
    }

    private func row(_ title: Text, symbol: String, detail: Int) -> some View {
        HStack {
            Label { title } icon: { Image(systemName: symbol) }
            Spacer()
            Text(detail, format: .number).foregroundStyle(Surface.secondaryLabel).tabularNumbers()
            Image(systemName: "chevron.forward").font(TextStyle.caption).foregroundStyle(Surface.tertiaryLabel)
        }
        .padding(.horizontal, Space.x5)
        .padding(.vertical, Space.x4)
        .contentShape(Rectangle())
    }
}

/// What the action cards and the sidebar's tools do; the shell owns the
/// sheets and pickers.
struct HomeActions {
    var open: () -> Void
    var scan: () -> Void
    var create: () -> Void
    var combine: () -> Void
    var search: () -> Void
    var settings: () -> Void
    var batch: () -> Void = {}
    /// Every other tool (Ask ZOOD, Quick tools, Sort, Cloud drives, Help):
    /// the shell opens its screen.
    var tool: (LibraryTool) -> Void = { _ in }
    /// The phone remote for ZOOD PDF on a computer.
    var remote: () -> Void = {}

    func run(_ tool: LibraryTool) {
        switch tool {
        case .scan: scan()
        case .create: create()
        case .combine: combine()
        case .search: search()
        case .batch: batch()
        default: self.tool(tool)
        }
    }
}

extension LibraryTool {
    /// The large cards on Home, in order; every other tool is a small tile
    /// under them. Together they are every tool (`HomeToolsTests`), so Home
    /// reaches all of them in both menu styles — Classic has no Tools tab.
    static let homeCards: [LibraryTool] = [.scan, .create, .combine, .cloud, .askZood, .quickTools, .sort]
    static var homeTiles: [LibraryTool] { allCases.filter { !homeCards.contains($0) } }

    /// The card's title on Home: shorter than the Tools list's where the
    /// hint says the rest.
    var cardTitle: LocalizedStringKey {
        switch self {
        case .create: "Create"
        case .combine: "Combine"
        default: title
        }
    }

    var hint: LocalizedStringKey {
        switch self {
        case .scan: "Paper into a PDF"
        case .create: "A PDF from pictures"
        case .combine: "Several files into one PDF"
        case .cloud: "OneDrive and Google Drive"
        case .askZood: "Ask about a PDF, or anything"
        case .quickTools: "Convert, split, shrink, protect"
        case .sort: "Name, merge and file PDFs"
        case .search: "Words inside every document"
        case .batch: "Steps run over many files"
        case .help: "Guides, and a message to us"
        }
    }

    var tint: Color {
        switch self {
        case .scan: .teal
        case .create: .purple
        case .combine: .orange
        case .cloud: .cyan
        case .askZood: .pink
        case .quickTools: .yellow
        case .sort: .brown
        case .search: .indigo
        case .batch: .green
        case .help: .mint
        }
    }
}

/// Home's tools: Open and the large cards (each a thing the app does now),
/// then every other tool, the phone remote and Settings as small tiles —
/// so nothing the Tools tab has is missing from Home, in either menu style.
struct ActionCardsRow: View {
    let actions: HomeActions
    private let columns = [GridItem(.adaptive(minimum: 150, maximum: 220), spacing: Space.x4)]
    private let tileColumns = [GridItem(.adaptive(minimum: 96, maximum: 160), spacing: Space.x3)]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.x5) {
            LazyVGrid(columns: columns, spacing: Space.x4) {
                ActionCard(title: "Open", hint: "A PDF from Files or iCloud Drive", symbol: "folder", tint: .blue, id: "home.open", action: actions.open)
                ForEach(LibraryTool.homeCards) { tool in
                    ActionCard(title: tool.cardTitle, hint: tool.hint, symbol: tool.symbol, tint: tool.tint,
                               id: "home.\(tool.rawValue)") { actions.run(tool) }
                }
            }
            Text("More tools")
                .themeFont(.headline)
                .foregroundStyle(Surface.secondaryLabel)
            LazyVGrid(columns: tileColumns, spacing: Space.x3) {
                ForEach(LibraryTool.homeTiles) { tool in
                    ToolTile(title: tool.title, symbol: tool.symbol, tint: tool.tint, id: "home.\(tool.rawValue)") { actions.run(tool) }
                }
                ToolTile(title: "Phone remote", symbol: "iphone.radiowaves.left.and.right", tint: .blue, id: "home.remote", action: actions.remote)
                ToolTile(title: "Settings", symbol: "gearshape", tint: .gray, id: "home.settings", action: actions.settings)
            }
        }
        .accessibilityIdentifier("home.actions")
    }
}

/// A small tool on Home: the icon in its pastel over the name.
struct ToolTile: View {
    let title: LocalizedStringKey
    let symbol: String
    let tint: Color
    let id: String
    let action: () -> Void
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var style: ThemeStyle {
        ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: Space.x2) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: style.glyphWeight))
                    .foregroundStyle(style.tile(tint).glyph)
                    .frame(width: 36, height: 36)
                    .background(style.tile(tint).plate, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                Text(title)
                    .themeFont(.caption)
                    .foregroundStyle(Surface.label)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: 84)
            .padding(Space.x3)
            .glassCard(radius: Radius.card)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(title))
        .accessibilityIdentifier(id)
    }
}

struct ActionCard: View {
    let title: LocalizedStringKey
    let hint: LocalizedStringKey
    let symbol: String
    let tint: Color
    let id: String
    let action: () -> Void
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    /// The tile is the theme's: its own pastel on the system and glass
    /// themes, ZOOD's copper on navy on ZOOD's.
    private var style: ThemeStyle {
        ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: Space.x4) {
                Image(systemName: symbol)
                    .font(.system(size: 22, weight: style.glyphWeight))
                    .foregroundStyle(style.tile(tint).glyph)
                    .frame(width: 44, height: 44)
                    .background(style.tile(tint).plate, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                VStack(alignment: .leading, spacing: Space.x1) {
                    Text(title)
                        .themeFont(.headline)
                        .foregroundStyle(Surface.label)
                    Text(hint)
                        .themeFont(.caption)
                        .foregroundStyle(Surface.secondaryLabel)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.x5)
            .glassCard()
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(title))
        .accessibilityHint(Text(hint))
        .accessibilityIdentifier(id)
    }
}

/// A row of documents as tall paper cards with their real first pages,
/// the name and the date, a ⋯ menu on each; "See all" into the section,
/// and paging arrows where there is a pointer.
struct DocumentRow: View {
    let library: LibraryModel
    let title: LocalizedStringKey
    let section: LibrarySection
    let items: [LibraryItem]
    let emptyMessage: LocalizedStringKey?
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.layoutDirection) private var direction
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows

    private static let cardWidth: CGFloat = 148

    var body: some View {
        VStack(alignment: .leading, spacing: Space.x3) {
            HStack {
                Text(title)
                    .themeFont(.title)
                    .foregroundStyle(Surface.label)
                Spacer()
                if !items.isEmpty {
                    NavigationLink(value: section) {
                        Text("See all")
                            .font(TextStyle.subheadline)
                    }
                    .accessibilityIdentifier("home.seeAll.\(section.rawValue)")
                }
            }
            .padding(.horizontal, Space.x5)
            if items.isEmpty, let emptyMessage {
                Text(emptyMessage)
                    .themeFont(.subheadline)
                    .foregroundStyle(Surface.secondaryLabel)
                    .padding(.horizontal, Space.x5)
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(alignment: .top, spacing: Space.x4) {
                            ForEach(items) { item in
                                card(item)
                                    .id(item.id)
                            }
                        }
                        .padding(.horizontal, Space.x5)
                    }
                    .overlay(alignment: .trailing) {
                        if sizeClass == .regular, items.count > 4 {
                            pagingArrows(proxy)
                        }
                    }
                }
            }
        }
        .accessibilityIdentifier("home.row.\(section.rawValue)")
    }

    private func pagingArrows(_ proxy: ScrollViewProxy) -> some View {
        HStack(spacing: Space.x2) {
            Button { proxy.scrollTo(items.first?.id, anchor: .leading) } label: {
                Image(systemName: "chevron.backward")
            }
            Button { proxy.scrollTo(items.last?.id, anchor: .trailing) } label: {
                Image(systemName: "chevron.forward")
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .padding(.trailing, Space.x5)
        .padding(.top, Space.x2)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func card(_ item: LibraryItem) -> some View {
        let starred = library.isStarred(item.url)
        // The same document can be in two rows; each card is its own source.
        let source = "\(section).\(item.id)"
        return Button {
            library.open(item)
            library.zoomSource = source
        } label: {
            VStack(alignment: .leading, spacing: Space.x3) {
                Depth.page(
                    ZStack(alignment: .topTrailing) {
                        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            .fill(Surface.paper)
                        if let thumbnail = library.thumbnail(for: item) {
                            Image(uiImage: thumbnail)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: Self.cardWidth - Space.x5 * 2, height: (Self.cardWidth - Space.x5 * 2) * 297 / 210, alignment: .top)
                                .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                        } else {
                            Image(systemName: "doc.text")
                                .font(.system(size: 30, weight: .light))
                                .foregroundStyle(Surface.tertiaryLabel)
                                .frame(width: Self.cardWidth - Space.x5 * 2, height: (Self.cardWidth - Space.x5 * 2) * 297 / 210)
                        }
                        if starred {
                            Image(systemName: "star.fill")
                                .font(.caption)
                                .foregroundStyle(.yellow)
                                .padding(Space.x2)
                                .background(.thinMaterial, in: Circle())
                                .padding(Space.x2)
                        }
                    }
                )
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: Space.x1) {
                        Text(item.name)
                            .themeFont(.callout)
                            .foregroundStyle(Surface.label)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Text(DocumentDate.text(item.date))
                            .themeFont(.caption)
                            .foregroundStyle(Surface.secondaryLabel)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 28)
                }
            }
            .padding(Space.x5)
            .frame(width: Self.cardWidth)
            .glassCard()
        }
        .buttonStyle(.pressable)
        .zoomSource(source)
        .contextMenu { menu(item, starred: starred) }
        // The ⋯ menu sits over the card, not inside its button, so its own
        // tap is its own.
        .overlay(alignment: .bottomTrailing) {
            Menu {
                menu(item, starred: starred)
            } label: {
                Image(systemName: "ellipsis.circle")
                    .foregroundStyle(Surface.secondaryLabel)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .padding(.trailing, Space.x3)
            .padding(.bottom, Space.x3)
            .accessibilityLabel(Text("More"))
            .accessibilityIdentifier("home.more.\(item.name)")
        }
        .accessibilityLabel(Text(item.name))
        .accessibilityHint(Text("Opens the document"))
        .accessibilityIdentifier(identifier(item))
    }

    /// The same identifiers the grid's cells carry, so a test finds a
    /// document under one name wherever it is shown.
    private func identifier(_ item: LibraryItem) -> String {
        if let id = item.recentID { return "recent.\(id.uuidString)" }
        if let key = item.key, key.hasPrefix(LibrarySource.folder.keyPrefix) { return "folderFile.\(item.name)" }
        return "document.\(item.name)"
    }

    @ViewBuilder
    private func menu(_ item: LibraryItem, starred: Bool) -> some View {
        Button("Open", systemImage: "doc.text") {
            library.open(item)
        }
        Button(starred ? "Unstar" : "Star", systemImage: starred ? "star.slash" : "star") {
            library.toggleStar(item.url)
        }
        .accessibilityIdentifier("home.star.\(item.name)")
        if supportsMultipleWindows, let url = item.url, let reference = DocumentReference(url: url) {
            Button("Open in New Window", systemImage: "macwindow.badge.plus") {
                openWindow(id: "document", value: reference)
            }
        }
        if item.key == nil, let url = item.url, !library.isInLibrary(url) {
            Button("Add to My documents", systemImage: "tray.and.arrow.down") {
                library.addToLibrary(url: url)
            }
            .accessibilityIdentifier("home.add.\(item.name)")
        }
        if let id = item.recentID, let recent = library.recents.first(where: { $0.id == id }) {
            Button("Remove from Recents", systemImage: "clock.badge.xmark") {
                library.forget(recent)
            }
        }
    }
}

/// "Today, 9:41 AM", "Yesterday, 4:10 PM", else the date — the system's
/// relative day names, in the person's language.
enum DocumentDate {
    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        formatter.doesRelativeDateFormatting = true
        return formatter
    }()

    static func text(_ date: Date) -> String {
        formatter.string(from: date)
    }
}

extension View {
    /// A card on the home screen. The ground it sits on, the material it is
    /// filled with and the edge around it are the chosen theme's
    /// (`Design/Themes.swift`), so the same card is glass, system material or
    /// ZOOD's paper without the screen knowing which.
    func glassCard(radius: CGFloat = Radius.sheet) -> some View {
        themedCard(radius: radius)
    }
}

/// ZOOD's hero panel: its paper (or its navy) as a card, the woven pattern
/// in the part of it the words do not use, fading out before they begin.
private struct ZoodHeroPanel: View {
    /// A phone's: the pattern is a band along the top.
    let alongTop: Bool
    /// How tall that band is.
    static let band: CGFloat = 64

    var body: some View {
        GeometryReader { proxy in
            if alongTop {
                ZoodPattern(kind: .woven)
                    .frame(width: proxy.size.width, height: Self.band + Space.x6)
                    .clipped()
                    .mask(LinearGradient(colors: [.black, .black, .clear], startPoint: .top, endPoint: .bottom))
            } else {
                ZoodPattern(kind: .woven)
                    .frame(width: proxy.size.width * 0.36, height: proxy.size.height)
                    .clipped()
                    .mask(LinearGradient(colors: [.clear, .black, .black], startPoint: .leading, endPoint: .trailing))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Radius.sheet, style: .continuous))
        .themedCard()
    }
}
