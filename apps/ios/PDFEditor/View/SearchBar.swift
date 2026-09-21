import SwiftUI

/// The find bar under the toolbar: the words, how many hits and which one
/// is on screen, previous and next, and a list of the hits with their
/// context — the core's Arabic-aware search, PDFKit's highlights.
struct SearchBar: View {
    @Bindable var search: DocumentSearch
    let model: DocumentModel
    let close: () -> Void
    @FocusState private var focused: Bool
    @State private var showingList = false

    var body: some View {
        VStack(spacing: Space.x3) {
            HStack(spacing: Space.x3) {
                HStack(spacing: Space.x2) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(Surface.secondaryLabel)
                    TextField("Find in document", text: $search.query)
                        .textFieldStyle(.plain)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .focused($focused)
                        .onSubmit { submit() }
                        .accessibilityIdentifier("search.field")
                    if !search.query.isEmpty {
                        Button {
                            search.query = ""
                            search.clear()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(Surface.tertiaryLabel)
                        }
                        .accessibilityLabel(Text("Clear"))
                    }
                }
                .padding(.horizontal, Space.x4)
                .padding(.vertical, Space.x3)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: Radius.group, style: .continuous))

                if search.searching {
                    ProgressView()
                } else if search.hasHits {
                    Button {
                        showingList = true
                    } label: {
                        Text("\(search.current + 1) of \(search.hits.count)")
                            .font(TextStyle.subheadline)
                            .tabularNumbers()
                            .foregroundStyle(Surface.secondaryLabel)
                    }
                    .accessibilityIdentifier("search.count")
                    Button("Previous", systemImage: "chevron.up") { search.previous() }
                        .labelStyle(.iconOnly)
                        .keyboardShortcut("g", modifiers: [.command, .shift])
                        .accessibilityIdentifier("search.previous")
                    Button("Next", systemImage: "chevron.down") { search.next() }
                        .labelStyle(.iconOnly)
                        .keyboardShortcut("g", modifiers: .command)
                        .accessibilityIdentifier("search.next")
                } else if !search.query.isEmpty {
                    Text("No matches")
                        .font(TextStyle.subheadline)
                        .foregroundStyle(Surface.secondaryLabel)
                        .accessibilityIdentifier("search.none")
                }
                Button("Done") { close() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("search.done")
            }
        }
        .padding(.horizontal, Space.x5)
        .padding(.vertical, Space.x3)
        .background(.bar)
        .onAppear { focused = true }
        .onChange(of: search.query) {
            // The results follow the typing, a moment behind it.
            search.run(in: model)
        }
        .sheet(isPresented: $showingList) {
            SearchHitsSheet(search: search)
        }
    }

    private func submit() {
        if search.hasHits {
            search.next()
        } else {
            search.run(in: model)
        }
    }
}

/// Every hit, with the words around it on its line; tapping one goes there.
struct SearchHitsSheet: View {
    @Bindable var search: DocumentSearch
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        AppSheet(title: "Matches") {
            List(Array(search.hits.enumerated()), id: \.offset) { index, hit in
                Button {
                    search.go(to: index)
                    dismiss()
                } label: {
                    VStack(alignment: .leading, spacing: Space.x1) {
                        (Text(hit.before) + Text(" ") + Text(hit.text).bold().foregroundStyle(Color.accentColor) + Text(" ") + Text(hit.after))
                            .font(TextStyle.body)
                            .lineLimit(2)
                        Text("Page \(hit.page + 1)")
                            .font(TextStyle.caption)
                            .foregroundStyle(Surface.secondaryLabel)
                            .tabularNumbers()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .listRowBackground(index == search.current ? Color.accentColor.opacity(0.12) : nil)
                .accessibilityIdentifier("search.hit.\(index)")
            }
            .listStyle(.plain)
            .accessibilityIdentifier("search.list")
        }
    }
}
