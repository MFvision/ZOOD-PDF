import AppIntents
import SwiftUI
import WidgetKit

/// Ask ZOOD: one tap opens the document on screen, or the one opened last,
/// with the on-device assistant ready. A small Home Screen widget and a
/// Lock Screen circle.
struct AskZoodWidget: Widget {
    static let kind = "app.warraq.ios.widgets.askzood"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: AskZoodProvider()) { _ in
            AskZoodWidgetView()
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(AppRoute.askZood.url)
        }
        .configurationDisplayName("Ask ZOOD")
        .description("Ask ZOOD about your last document, on the phone.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryInline])
    }
}

struct AskZoodEntry: TimelineEntry {
    let date: Date
}

struct AskZoodProvider: TimelineProvider {
    func placeholder(in context: Context) -> AskZoodEntry { AskZoodEntry(date: .now) }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (AskZoodEntry) -> Void) {
        completion(AskZoodEntry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<AskZoodEntry>) -> Void) {
        completion(Timeline(entries: [AskZoodEntry(date: .now)], policy: .never))
    }
}

struct AskZoodWidgetView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "sparkles")
                    .font(.title2)
            }
            .accessibilityLabel(Text("Ask ZOOD"))
        case .accessoryInline:
            Label("Ask ZOOD", systemImage: "sparkles")
        default:
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(.tint)
                Spacer(minLength: 0)
                Text("Ask ZOOD")
                    .font(.headline)
                Text("About your last document.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text("Ask ZOOD"))
        }
    }
}

/// The Control Center's Ask ZOOD control (iOS 18), also for the Lock
/// Screen's bottom corners and the Action button.
struct AskZoodControl: ControlWidget {
    static let kind = "app.warraq.ios.widgets.askzoodcontrol"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: AskZoodIntent()) {
                Label("Ask ZOOD", systemImage: "sparkles")
            }
        }
        .displayName("Ask ZOOD")
        .description("Opens your last document with the assistant ready.")
    }
}
