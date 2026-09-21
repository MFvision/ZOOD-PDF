import SwiftUI

/// The Library's search results: every line that matched, grouped by
/// document, the matched words marked, the page named; a tap opens the
/// document at that page. Filters narrow by kind, tag, scans only and the
/// documents' own dates.
struct LibrarySearchResults: View {
    let library: LibraryModel
    let query: String
    @Binding var filters: SearchFilters
    @State private var result = SearchResult.empty
    @State private var searching = false
    @State private var showingFilters = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var groups: [(key: String, name: String, kind: LibraryKind, tags: [String], hits: [SearchHit])] {
        var order: [String] = []
        var byKey: [String: [SearchHit]] = [:]
        for hit in result.hits {
            if byKey[hit.key] == nil { order.append(hit.key) }
            byKey[hit.key, default: []].append(hit)
        }
        return order.compactMap { key in
            guard let hits = byKey[key], let first = hits.first else { return nil }
            return (key, first.name, first.kind, first.tags, hits)
        }
    }

    var body: some View {
        List {
            Section {
                filterBar
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: Space.x5, bottom: 0, trailing: Space.x5))
            if result.hits.isEmpty, !searching {
                ContentUnavailableView.search(text: query)
                    .listRowBackground(Color.clear)
            }
            ForEach(groups, id: \.key) { group in
                Section {
                    ForEach(group.hits) { hit in
                        hitRow(hit)
                    }
                } header: {
                    HStack(spacing: Space.x3) {
                        Image(systemName: group.kind.symbol)
                        Text(group.name)
                            .lineLimit(1)
                        Spacer()
                        ForEach(group.tags, id: \.self) { tag in
                            Text(tag)
                                .font(TextStyle.caption)
                                .padding(.horizontal, Space.x3)
                                .padding(.vertical, Space.x1)
                                .background(Surface.grouped, in: Capsule())
                        }
                    }
                    .textCase(nil)
                    .font(TextStyle.headline)
                    .foregroundStyle(Surface.label)
                    .accessibilityIdentifier("search.document.\(group.name)")
                }
            }
        }
        .listStyle(.plain)
        .background(Surface.window)
        .overlay(alignment: .top) {
            if searching {
                ProgressView()
                    .padding(Space.x4)
            }
        }
        .accessibilityIdentifier("library.searchResults")
        .task(id: SearchKey(query: query, filters: filters)) {
            await search()
        }
        .sheet(isPresented: $showingFilters) {
            SearchFiltersSheet(library: library, filters: $filters)
        }
        .animation(Motion.travel(reduceMotion: reduceMotion), value: result.hits.count)
    }

    private struct SearchKey: Hashable {
        let query: String
        let filters: SearchFilters
    }

    private func search() async {
        searching = true
        // A short pause: results narrow as the person types, not on every key.
        try? await Task.sleep(for: .milliseconds(180))
        guard !Task.isCancelled else { return }
        result = await library.search(query, filters: filters)
        searching = false
    }

    private var filterBar: some View {
        HStack(spacing: Space.x3) {
            Text("\(result.total) matches")
                .font(TextStyle.caption)
                .foregroundStyle(Surface.secondaryLabel)
                .tabularNumbers()
                .accessibilityIdentifier("search.total")
            Spacer()
            Button {
                showingFilters = true
            } label: {
                Label(filters.isEmpty ? String(localized: "Filters") : String(localized: "Filters on"),
                      systemImage: filters.isEmpty ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                    .font(TextStyle.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityIdentifier("search.filters")
        }
        .padding(.vertical, Space.x2)
    }

    private func hitRow(_ hit: SearchHit) -> some View {
        Button {
            library.rememberSearch(query, hits: result.total)
            library.open(key: hit.key, page: hit.page)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: Space.x4) {
                Text("p. \(hit.page)")
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
                    .tabularNumbers()
                    .frame(minWidth: 36, alignment: .leading)
                Text(hit.marked)
                    .font(TextStyle.body)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Page \(hit.page): \(hit.text)"))
        .accessibilityHint(Text("Opens the document at this page"))
        .accessibilityIdentifier("search.hit.\(hit.page)")
    }
}

/// The filters, as a sheet: kinds, tags, scans only, a date range.
struct SearchFiltersSheet: View {
    let library: LibraryModel
    @Binding var filters: SearchFilters
    @State private var useFrom = false
    @State private var useTo = false
    @State private var from = Date.now
    @State private var to = Date.now

    private var tags: [String] {
        (library.indexer?.stats.tags.keys).map(Array.init)?.sorted() ?? []
    }

    var body: some View {
        AppSheet(title: "Filters") {
            Form {
                Section("Kind") {
                    ForEach(LibraryKind.readable) { kind in
                        Toggle(isOn: binding(kind: kind)) {
                            Label(kind.title, systemImage: kind.symbol)
                        }
                        .accessibilityIdentifier("filters.kind.\(kind.rawValue)")
                    }
                    Toggle("Scans only", isOn: Binding(get: { filters.scannedOnly == true }, set: { filters.scannedOnly = $0 ? true : nil }))
                        .accessibilityIdentifier("filters.scannedOnly")
                }
                if !tags.isEmpty {
                    Section("Tags") {
                        ForEach(tags, id: \.self) { tag in
                            Toggle(tag, isOn: binding(tag: tag))
                        }
                    }
                }
                if library.chosenFolder != nil {
                    Section("Where") {
                        Toggle("My documents", isOn: binding(folder: .documents))
                        Toggle(library.chosenFolder?.name ?? String(localized: "Chosen folder"), isOn: binding(folder: .folder))
                    }
                }
                Section {
                    Toggle("From", isOn: $useFrom)
                    if useFrom {
                        DatePicker("From", selection: $from, displayedComponents: .date)
                    }
                    Toggle("To", isOn: $useTo)
                    if useTo {
                        DatePicker("To", selection: $to, displayedComponents: .date)
                    }
                } header: {
                    Text("The document's own date")
                } footer: {
                    Text("The date read from the document's first pages, Gregorian or Hijri.")
                }
                Section {
                    Button("Clear filters", role: .destructive) {
                        filters = .none
                        useFrom = false
                        useTo = false
                    }
                    .disabled(filters.isEmpty)
                }
            }
            .onChange(of: useFrom) { _, on in filters.from = on ? Self.iso(from) : nil }
            .onChange(of: useTo) { _, on in filters.to = on ? Self.iso(to) : nil }
            .onChange(of: from) { _, date in if useFrom { filters.from = Self.iso(date) } }
            .onChange(of: to) { _, date in if useTo { filters.to = Self.iso(date) } }
            .onAppear {
                if let string = filters.from, let date = Self.date(string) { from = date; useFrom = true }
                if let string = filters.to, let date = Self.date(string) { to = date; useTo = true }
            }
        }
    }

    private func binding(kind: LibraryKind) -> Binding<Bool> {
        Binding(
            get: { filters.kinds?.contains(kind) ?? false },
            set: { on in
                var kinds = Set(filters.kinds ?? [])
                if on { kinds.insert(kind) } else { kinds.remove(kind) }
                filters.kinds = kinds.isEmpty ? nil : LibraryKind.allCases.filter { kinds.contains($0) }
            }
        )
    }

    private func binding(tag: String) -> Binding<Bool> {
        Binding(
            get: { filters.tags?.contains(tag) ?? false },
            set: { on in
                var tags = Set(filters.tags ?? [])
                if on { tags.insert(tag) } else { tags.remove(tag) }
                filters.tags = tags.isEmpty ? nil : tags.sorted()
            }
        )
    }

    private func binding(folder: LibrarySource) -> Binding<Bool> {
        Binding(
            get: { filters.folders?.contains(folder.folderFilter) ?? false },
            set: { on in
                var folders = Set(filters.folders ?? [])
                if on { folders.insert(folder.folderFilter) } else { folders.remove(folder.folderFilter) }
                filters.folders = folders.isEmpty ? nil : folders.sorted()
            }
        )
    }

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func iso(_ date: Date) -> String { formatter.string(from: date) }
    static func date(_ string: String) -> Date? { formatter.date(from: string) }
}
