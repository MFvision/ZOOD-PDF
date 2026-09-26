import SwiftUI
import ZoodCore

struct RecentsGrid: View {
    let items: [RecentDocument]
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let columns = [GridItem(.adaptive(minimum: sizeClass == .regular ? 170 : 140), spacing: 16)]
        LazyVGrid(columns: columns, alignment: .leading, spacing: 18) {
            ForEach(items) { RecentCard(recent: $0) }
        }
    }
}

/// A recent file: first-page picture, name, date (Gregorian · Hijri in the locale's numerals),
/// ⋯ menu. Drag it to another window (or app) to hand over the PDF itself.
struct RecentCard: View {
    let recent: RecentDocument
    @Environment(Library.self) private var library
    @Environment(WindowRouter.self) private var router
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows
    @Environment(\.locale) private var locale
    @State private var editingTags = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: open) {
                thumbnail
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel(Text(verbatim: recent.name))
            .accessibilityHint(Text("recents.openHint"))
            .accessibilityIdentifier("recent.\(recent.name)")

            HStack(alignment: .top, spacing: 4) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        if recent.starred {
                            Image(systemName: "star.fill").foregroundStyle(.yellow).font(.caption)
                                .accessibilityLabel(Text("recents.starred"))
                        }
                        Text(verbatim: FileNaming.baseName(recent.name)).font(.subheadline.weight(.medium)).lineLimit(2)
                    }
                    Text(verbatim: DateFormatting.both(recent.openedAt, locale: locale))
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 0)
                menu
            }
        }
        .draggable(dragPayload) {
            thumbnail.frame(width: 90)
        }
        .sheet(isPresented: $editingTags) {
            TagEditor(recent: recent)
        }
    }

    private var dragPayload: PDFFile {
        PDFFile(url: library.url(for: recent) ?? URL(fileURLWithPath: "/dev/null"))
    }

    @ViewBuilder private var thumbnail: some View {
        let shape = RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous)
        Group {
            if let img = library.thumbnail(for: recent) {
                Image(uiImage: img).resizable().scaledToFit()
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "doc.richtext").font(.largeTitle).foregroundStyle(.secondary)
                    Text("recents.noThumbnail").font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .aspectRatio(3 / 4, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: .systemBackground), in: shape)
        .overlay(shape.strokeBorder(Color.primary.opacity(0.1)))
        .shadow(color: .black.opacity(0.08), radius: 6, y: 3)
        .id(library.thumbnailsVersion)
    }

    private var menu: some View {
        Menu {
            Button("recents.open", systemImage: "doc", action: open)
            if supportsMultipleWindows {
                Button("recents.openNewWindow", systemImage: "macwindow.badge.plus") {
                    openWindow(id: "document", value: DeepLink.openRecent(id: recent.id).url)
                }
            }
            if let url = library.url(for: recent) {
                ShareLink(item: url) { Label("common.share", systemImage: "square.and.arrow.up") }
            }
            Button(
                recent.starred ? LocalizedStringKey("recents.unstar") : LocalizedStringKey("recents.star"),
                systemImage: recent.starred ? "star.slash" : "star"
            ) {
                Task { await library.setStarred(recent, !recent.starred) }
            }
            Button("recents.editTags", systemImage: "tag") { editingTags = true }
            Divider()
            Button("recents.remove", systemImage: "minus.circle", role: .destructive) {
                Task { await library.remove(recent) }
            }
        } label: {
            Image(systemName: "ellipsis.circle").font(.body).padding(4)
        }
        .accessibilityLabel(Text("recents.actions \(recent.name)"))
    }

    private func open() {
        guard let url = library.url(for: recent) else {
            router.toast = Toast(message: String(localized: "recents.reselect \(recent.name)"), isError: true)
            return
        }
        router.show(OpenedDocument(url: url, recentID: recent.id))
    }
}

struct RecentsScreen: View {
    enum Filter { case all, starred, tag(String) }
    let filter: Filter
    @Environment(Library.self) private var library

    var body: some View {
        let items: [RecentDocument] = switch filter {
        case .all: library.recents
        case .starred: library.recents.filter(\.starred)
        case .tag(let t): library.recents.filter { $0.tags.contains(t) }
        }
        ScrollView {
            if items.isEmpty {
                ContentUnavailableView {
                    Label(emptyTitle, systemImage: emptySymbol)
                } description: {
                    Text(emptyText)
                }
                .padding(.top, 60)
            } else {
                RecentsGrid(items: items).padding(20)
            }
        }
        .background(AppBackdrop())
        .navigationTitle(Text(title))
    }

    private var title: LocalizedStringKey {
        switch filter {
        case .all: "section.recents.title"
        case .starred: "section.starred.title"
        case .tag(let t): "section.tag.title \(t)"
        }
    }

    private var emptyTitle: LocalizedStringKey {
        switch filter {
        case .all: "section.recents.title"
        case .starred: "section.starred.title"
        case .tag: "section.tags.title"
        }
    }

    private var emptyText: LocalizedStringKey {
        switch filter {
        case .all: "home.recents.empty"
        case .starred: "section.starred.empty"
        case .tag: "section.tags.empty"
        }
    }

    private var emptySymbol: String {
        switch filter {
        case .all: "clock"
        case .starred: "star"
        case .tag: "tag"
        }
    }
}

struct TagsScreen: View {
    @Environment(Library.self) private var library

    var body: some View {
        List {
            if library.tags.isEmpty {
                Text("section.tags.empty").foregroundStyle(.secondary)
            }
            ForEach(library.tags, id: \.self) { tag in
                NavigationLink {
                    RecentsScreen(filter: .tag(tag))
                } label: {
                    Label { Text(verbatim: tag) } icon: { Image(systemName: "tag") }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(AppBackdrop())
        .navigationTitle(Text("section.tags.title"))
    }
}

struct TagEditor: View {
    let recent: RecentDocument
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var tags: [String] = []
    @State private var newTag = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("tags.sheet.placeholder", text: $newTag)
                            .onSubmit(add)
                        Button("tags.sheet.add", action: add).disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                Section {
                    if tags.isEmpty { Text("tags.sheet.none").foregroundStyle(.secondary) }
                    ForEach(tags, id: \.self) { Text(verbatim: $0) }
                        .onDelete { tags.remove(atOffsets: $0) }
                }
            }
            .navigationTitle(Text("tags.sheet.title \(recent.name)"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("common.cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("common.done") {
                        Task {
                            await library.setTags(recent, tags)
                            dismiss()
                        }
                    }
                }
            }
        }
        .onAppear { tags = recent.tags }
        .presentationDetents([.medium, .large])
    }

    private func add() {
        tags = RecentsStore.cleanTags(tags + [newTag])
        newTag = ""
    }
}
