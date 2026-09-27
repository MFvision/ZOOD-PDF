import SwiftUI
import WidgetKit

/// Library search: the last searches the person ran, each a tap back into
/// the same search in the app; the header opens the search field empty.
struct LibrarySearchWidget: Widget {
    static let kind = "app.warraq.ios.widgets.search"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: SearchesProvider()) { entry in
            LibrarySearchView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Library search")
        .description("Your last searches across every document.")
        .supportedFamilies([.systemMedium])
    }
}

struct SearchesEntry: TimelineEntry {
    let date: Date
    let searches: [RecentSearch]
    let placeholder: Bool
}

struct SearchesProvider: TimelineProvider {
    static let capacity = 4

    static func entry(store: SearchesStore = SearchesStore()) -> SearchesEntry {
        SearchesEntry(date: .now, searches: WidgetTimelines.searches(from: store, capacity: capacity), placeholder: false)
    }

    func placeholder(in context: Context) -> SearchesEntry {
        SearchesEntry(date: .now, searches: [], placeholder: true)
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (SearchesEntry) -> Void) {
        completion(Self.entry())
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<SearchesEntry>) -> Void) {
        completion(Timeline(entries: [Self.entry()], policy: .never))
    }
}

struct LibrarySearchView: View {
    let entry: SearchesEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Link(destination: AppRoute.search("").url) {
                HStack(spacing: 6) {
                    Image(systemName: "text.magnifyingglass")
                        .foregroundStyle(.tint)
                    Text("Search my documents")
                        .font(.headline)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.forward")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            if entry.placeholder {
                ForEach(0..<3, id: \.self) { _ in
                    Text("A search").redacted(reason: .placeholder)
                }
            } else if entry.searches.isEmpty {
                Text("Search once in the app and the search appears here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(entry.searches) { search in
                    Link(destination: AppRoute.search(search.query).url) {
                        HStack {
                            Image(systemName: "clock")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(search.query)
                                .font(.subheadline)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            Text("\(search.hits)")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityLabel(Text("Search for \(search.query), \(search.hits) matches"))
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
