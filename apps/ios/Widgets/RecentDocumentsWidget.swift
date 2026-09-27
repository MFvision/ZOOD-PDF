import SwiftUI
import WidgetKit

/// The last documents opened, from the recents list the app keeps in the
/// shared container: small shows the last one with its first page, medium
/// three, large six; the Lock Screen's rectangle and inline line the last
/// one's name. Tapping one opens it in the app (`pdfeditor://open/<id>`).
/// The app asks for a reload whenever the list changes.
struct RecentDocumentsWidget: Widget {
    static let kind = "app.warraq.ios.widgets.recents"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: RecentsProvider()) { entry in
            RecentDocumentsView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Recent documents")
        .description("The documents you opened last.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

struct RecentsEntry: TimelineEntry {
    let date: Date
    let documents: [RecentDocument]
    let placeholder: Bool
}

struct RecentsProvider: TimelineProvider {
    /// How many a widget can show at most (the large one).
    static let capacity = 6

    /// The entry for now, from the shared container.
    static func entry(store: RecentsStore = RecentsStore()) -> RecentsEntry {
        RecentsEntry(date: .now, documents: WidgetTimelines.recents(from: store, capacity: capacity), placeholder: false)
    }

    func placeholder(in context: Context) -> RecentsEntry {
        RecentsEntry(date: .now, documents: [], placeholder: true)
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (RecentsEntry) -> Void) {
        completion(Self.entry())
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<RecentsEntry>) -> Void) {
        // The list changes when the app opens a document, and the app says
        // so through WidgetCenter; there is nothing to refresh on a clock.
        completion(Timeline(entries: [Self.entry()], policy: .never))
    }
}

struct RecentDocumentsView: View {
    let entry: RecentsEntry
    @Environment(\.widgetFamily) private var family

    private var shown: [RecentDocument] {
        let count: Int = switch family {
        case .systemSmall, .accessoryRectangular, .accessoryInline: 1
        case .systemMedium: 3
        default: 6
        }
        return Array(entry.documents.prefix(count))
    }

    var body: some View {
        if entry.placeholder {
            placeholder
        } else if shown.isEmpty {
            empty
        } else {
            switch family {
            case .accessoryRectangular:
                accessory(shown[0])
            case .accessoryInline:
                Label(shown[0].name, systemImage: "doc.text")
                    .widgetURL(AppRoute.open(id: shown[0].id).url)
            case .systemSmall:
                single(shown[0])
            default:
                grid
            }
        }
    }

    private var placeholder: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Recent documents").font(.headline)
            Text("The documents you opened last.").font(.caption).foregroundStyle(.secondary)
        }
        .redacted(reason: .placeholder)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: "doc.text").font(.title2).foregroundStyle(.secondary)
            Text("No documents yet").font(.headline)
            if family != .accessoryRectangular, family != .accessoryInline {
                Text("Open a PDF and it appears here.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(AppRoute.lastDocument.url)
    }

    private func single(_ document: RecentDocument) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            thumbnail(document)
                .frame(maxHeight: .infinity)
            Text(document.name).font(.caption.weight(.semibold)).lineLimit(2)
            Text(document.lastOpened, format: .relative(presentation: .named))
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(AppRoute.open(id: document.id).url)
    }

    private var grid: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 3)
        return LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
            ForEach(shown) { document in
                Link(destination: AppRoute.open(id: document.id).url) {
                    VStack(alignment: .leading, spacing: 4) {
                        thumbnail(document)
                            .frame(maxWidth: .infinity)
                        Text(document.name).font(.caption2.weight(.semibold)).lineLimit(2)
                    }
                }
                .accessibilityLabel(Text(document.name))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func accessory(_ document: RecentDocument) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("Last document", systemImage: "doc.text").font(.caption2).foregroundStyle(.secondary)
            Text(document.name).font(.headline).lineLimit(1)
            Text(document.lastOpened, format: .relative(presentation: .named)).font(.caption2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(AppRoute.open(id: document.id).url)
    }

    private func thumbnail(_ document: RecentDocument) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4, style: .continuous).fill(.white)
            if let url = document.thumbnailURL, let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            } else {
                Image(systemName: "doc.text").foregroundStyle(.tertiary)
            }
        }
        .aspectRatio(210 / 297, contentMode: .fit)
        .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
    }
}
