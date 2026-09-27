import SwiftUI
import WidgetKit

/// Scan: one tap opens the app on the scanner. A small Home Screen widget
/// and a Lock Screen circle. Where the device has no camera it says so and
/// opens the pictures-to-PDF path instead.
struct ScanWidget: Widget {
    static let kind = "app.warraq.ios.widgets.scan"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: ScanProvider()) { entry in
            ScanWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(AppRoute.scan.url)
        }
        .configurationDisplayName("Scan")
        .description("Scan a paper document into a PDF with one tap.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryInline])
    }
}

struct ScanWidgetEntry: TimelineEntry {
    let date: Date
    let cameraAvailable: Bool
}

struct ScanProvider: TimelineProvider {
    static func entry() -> ScanWidgetEntry {
        ScanWidgetEntry(date: .now, cameraAvailable: WidgetTimelines.cameraAvailable)
    }

    func placeholder(in context: Context) -> ScanWidgetEntry {
        ScanWidgetEntry(date: .now, cameraAvailable: true)
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (ScanWidgetEntry) -> Void) {
        completion(Self.entry())
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<ScanWidgetEntry>) -> Void) {
        completion(Timeline(entries: [Self.entry()], policy: .never))
    }
}

struct ScanWidgetView: View {
    let entry: ScanWidgetEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "doc.viewfinder")
                    .font(.title2)
            }
            .accessibilityLabel(Text("Scan a document"))
        case .accessoryInline:
            Label("Scan a document", systemImage: "doc.viewfinder")
        default:
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: "doc.viewfinder")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(.tint)
                Spacer(minLength: 0)
                Text("Scan")
                    .font(.headline)
                Text(entry.cameraAvailable ? "A paper document, into a PDF." : "From pictures, into a PDF.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text("Scan a document"))
        }
    }
}
