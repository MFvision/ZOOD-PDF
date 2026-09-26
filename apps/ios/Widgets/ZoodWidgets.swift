import AppIntents
import SwiftUI
import UIKit
import WidgetKit
import ZoodCore

@main
struct ZoodWidgetBundle: WidgetBundle {
    var body: some Widget {
        RecentsWidget()
        ScanWidget()
        LockScreenScanWidget()
        ScanControl()
    }
}

// MARK: - Recents (Home Screen, small/medium/large)

struct RecentsEntry: TimelineEntry {
    struct Item: Identifiable {
        let id: String
        let name: String
        let openedAt: Date
        /// Small PNG of the first page (Data keeps the entry Sendable).
        let thumbnail: Data?
    }

    let date: Date
    let items: [Item]
}

struct RecentsProvider: TimelineProvider {
    func placeholder(in context: Context) -> RecentsEntry {
        RecentsEntry(date: .now, items: [])
    }

    func getSnapshot(in context: Context, completion: @escaping (RecentsEntry) -> Void) {
        completion(load(limit: context.family == .systemLarge ? 6 : 4))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RecentsEntry>) -> Void) {
        // The app reloads the timelines whenever recents change; refresh hourly as a fallback.
        let entry = load(limit: context.family == .systemLarge ? 6 : 4)
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(3600))))
    }

    private func load(limit: Int) -> RecentsEntry {
        guard let dir = ZoodShared.groupRecentsDirectory() else { return RecentsEntry(date: .now, items: []) }
        let store = RecentsStore(directory: dir)
        let items = RecentsStore.snapshot(directory: dir)
            .sorted { $0.openedAt > $1.openedAt }
            .prefix(limit)
            .map { r in
                let thumb = r.hasThumbnail
                    ? UIImage(contentsOfFile: store.thumbnailURL(id: r.id).path)?
                        .preparingThumbnail(of: CGSize(width: 120, height: 160))?.pngData()
                    : nil
                return RecentsEntry.Item(id: r.id, name: FileNaming.baseName(r.name), openedAt: r.openedAt, thumbnail: thumb)
            }
        return RecentsEntry(date: .now, items: Array(items))
    }
}

struct RecentsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: ZoodShared.widgetKindRecents, provider: RecentsProvider()) { entry in
            RecentsWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("widget.recents.name")
        .description("widget.recents.description")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct RecentsWidgetView: View {
    let entry: RecentsEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if entry.items.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "doc.richtext").font(.title)
                Text("widget.recents.empty").font(.caption).multilineTextAlignment(.center)
            }
            .foregroundStyle(.secondary)
            .widgetURL(DeepLink.home.url)
        } else if family == .systemSmall, let first = entry.items.first {
            VStack(alignment: .leading, spacing: 6) {
                thumb(first).frame(maxHeight: .infinity)
                Text(verbatim: first.name).font(.caption.weight(.semibold)).lineLimit(1)
            }
            .widgetURL(DeepLink.openRecent(id: first.id).url)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Label("widget.recents.name", systemImage: "clock").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                let columns = family == .systemLarge ? 3 : 4
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: columns), spacing: 8) {
                    ForEach(entry.items) { item in
                        Link(destination: DeepLink.openRecent(id: item.id).url) {
                            VStack(spacing: 4) {
                                thumb(item).frame(height: family == .systemLarge ? 110 : 70)
                                Text(verbatim: item.name).font(.caption2).lineLimit(1)
                            }
                        }
                    }
                }
            }
        }
    }

    private func thumb(_ item: RecentsEntry.Item) -> some View {
        Group {
            if let data = item.thumbnail, let t = UIImage(data: data) {
                Image(uiImage: t).resizable().scaledToFit()
            } else {
                Image(systemName: "doc.text").font(.title2).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityLabel(Text(verbatim: item.name))
    }
}

// MARK: - Scan (Home Screen small) and Lock Screen accessory

struct StaticEntry: TimelineEntry {
    let date: Date
}

struct StaticProvider: TimelineProvider {
    func placeholder(in context: Context) -> StaticEntry { StaticEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (StaticEntry) -> Void) { completion(StaticEntry(date: .now)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<StaticEntry>) -> Void) {
        completion(Timeline(entries: [StaticEntry(date: .now)], policy: .never))
    }
}

struct ScanWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: ZoodShared.widgetKindScan, provider: StaticProvider()) { _ in
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: "doc.viewfinder")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 52, height: 52)
                    .background(Color.accentColor.gradient, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                Spacer()
                Text("widget.scan.title").font(.headline)
                Text("app.name").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(DeepLink.scan(.document).url)
            .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("widget.scan.title")
        .description("widget.scan.description")
        .supportedFamilies([.systemSmall])
    }
}

struct LockScreenScanWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: ZoodShared.widgetKindLockScan, provider: StaticProvider()) { _ in
            LockScreenScanView()
                .widgetURL(DeepLink.scan(.document).url)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("widget.scan.title")
        .description("widget.scan.description")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct LockScreenScanView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "doc.viewfinder").font(.title2)
            }
            .accessibilityLabel(Text("widget.scan.title"))
        case .accessoryInline:
            Label("widget.scan.title", systemImage: "doc.viewfinder")
        default:
            HStack {
                Image(systemName: "doc.viewfinder").font(.title2)
                VStack(alignment: .leading) {
                    Text("widget.scan.title").font(.headline)
                    Text("app.name").font(.caption)
                }
            }
        }
    }
}

// MARK: - Control Center (iOS 18 control)

struct ScanControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: ZoodShared.controlKindScan) {
            ControlWidgetButton(action: ScanDocumentIntent()) {
                Label("widget.scan.title", systemImage: "doc.viewfinder")
            }
        }
        .displayName("widget.scan.title")
        .description("widget.scan.description")
    }
}
