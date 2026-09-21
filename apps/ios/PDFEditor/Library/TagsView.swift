import SwiftUI

/// The Tags section: every tag in the index with how many documents carry
/// it, the documents under each, and the rules that put tags on by
/// themselves.
struct TagsView: View {
    let library: LibraryModel
    @State private var showingRules = false
    @State private var editing: IndexedDocument?

    private var tags: [(name: String, count: Int)] {
        (library.indexer?.stats.tags ?? [:]).map { (name: $0.key, count: $0.value) }.sorted { $0.name < $1.name }
    }

    private var documents: [IndexedDocument] {
        (library.indexer?.catalog.values).map(Array.init)?.sorted { $0.name < $1.name } ?? []
    }

    var body: some View {
        List {
            if tags.isEmpty {
                ContentUnavailableView {
                    Label("No tags yet", systemImage: "tag")
                } description: {
                    Text("Tag a document from its menu, or write a rule that tags documents by the words they hold.")
                } actions: {
                    Button("Rules…") { showingRules = true }
                        .buttonStyle(.borderedProminent)
                }
                .listRowBackground(Color.clear)
            }
            ForEach(tags, id: \.name) { tag in
                Section {
                    ForEach(documents.filter { $0.tags.contains(tag.name) }) { document in
                        Button {
                            library.open(key: document.key)
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(document.name).lineLimit(1)
                                    Text("\(document.pages) pages · \(document.kind.title)")
                                        .font(TextStyle.caption)
                                        .foregroundStyle(Surface.secondaryLabel)
                                        .tabularNumbers()
                                }
                            } icon: {
                                Image(systemName: document.kind.symbol)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("Tags…", systemImage: "tag") { editing = document }
                        }
                    }
                } header: {
                    Label {
                        Text(verbatim: tag.name) + Text(verbatim: " · ") + Text(tag.count, format: .number)
                    } icon: {
                        Image(systemName: "tag")
                    }
                    .textCase(nil)
                    .accessibilityIdentifier("tags.tag.\(tag.name)")
                }
            }
        }
        .listStyle(.insetGrouped)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Rules", systemImage: "wand.and.stars") { showingRules = true }
                    .accessibilityIdentifier("tags.rules")
            }
        }
        .sheet(isPresented: $showingRules) {
            RulesSheet(library: library)
        }
        .sheet(item: $editing) { document in
            DocumentTagsSheet(library: library, document: document)
        }
        .accessibilityIdentifier("library.tags")
    }
}

/// The tags on one document: the index's tags as toggles, and a field for
/// a new one.
struct DocumentTagsSheet: View {
    let library: LibraryModel
    let document: IndexedDocument
    @State private var tags: Set<String> = []
    @State private var newTag = ""
    @State private var known: [String] = []

    var body: some View {
        AppSheet(title: "Tags") {
            Form {
                Section(document.name) {
                    ForEach(known, id: \.self) { tag in
                        Toggle(tag, isOn: Binding(get: { tags.contains(tag) }, set: { on in
                            if on { tags.insert(tag) } else { tags.remove(tag) }
                            save()
                        }))
                        .accessibilityIdentifier("docTags.\(tag)")
                    }
                    HStack {
                        TextField("New tag", text: $newTag)
                            .submitLabel(.done)
                            .onSubmit(addNew)
                            .accessibilityIdentifier("docTags.new")
                        Button("Add", action: addNew)
                            .disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier("docTags.add")
                    }
                }
            }
            .onAppear {
                tags = Set(library.indexer?.catalog[document.key]?.tags ?? document.tags)
                known = Set((library.indexer?.stats.tags.keys).map(Array.init) ?? []).union(tags).sorted()
            }
        }
    }

    private func addNew() {
        let tag = newTag.trimmingCharacters(in: .whitespaces)
        guard !tag.isEmpty else { return }
        tags.insert(tag)
        if !known.contains(tag) { known = (known + [tag]).sorted() }
        newTag = ""
        save()
    }

    private func save() {
        let chosen = tags.sorted()
        Task { await library.indexer?.setTags(chosen, on: document.key) }
    }
}

/// The rules: a tag, the words that call for it, where to look, whether
/// every word is needed. Saved into the index; "Apply now" runs them over
/// everything already indexed.
struct RulesSheet: View {
    let library: LibraryModel
    @State private var rules: [TagRule] = []
    @State private var editing: TagRule?
    @State private var adding = false
    @State private var applied: Int?

    var body: some View {
        AppSheet(title: "Rules") {
            List {
                if rules.isEmpty {
                    ContentUnavailableView {
                        Label("No rules yet", systemImage: "wand.and.stars")
                    } description: {
                        Text("A rule puts a tag on every document that holds certain words — “فاتورة” tags the invoices.")
                    }
                    .listRowBackground(Color.clear)
                }
                ForEach(rules) { rule in
                    Button { editing = rule } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Label(rule.tag, systemImage: "tag")
                                if rule.enabled == false {
                                    Text("Off").font(TextStyle.caption).foregroundStyle(Surface.secondaryLabel)
                                }
                            }
                            Text(rule.words.joined(separator: " · "))
                                .font(TextStyle.caption)
                                .foregroundStyle(Surface.secondaryLabel)
                                .lineLimit(2)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("rules.rule.\(rule.tag)")
                }
                .onDelete { offsets in
                    rules.remove(atOffsets: offsets)
                    save(apply: false)
                }
                if !rules.isEmpty {
                    Section {
                        Button("Apply the rules now", systemImage: "play.fill") {
                            save(apply: true)
                        }
                        .accessibilityIdentifier("rules.apply")
                        if let applied {
                            Text("\(applied) documents tagged")
                                .font(TextStyle.caption)
                                .foregroundStyle(Surface.secondaryLabel)
                        }
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Add", systemImage: "plus") { adding = true }
                        .accessibilityIdentifier("rules.add")
                }
            }
            .sheet(isPresented: $adding) {
                RuleEditor(rule: TagRule(tag: "", words: [], all: false, enabled: true, scope: "both", kinds: nil)) { rule in
                    rules.append(rule)
                    save(apply: true)
                }
            }
            .sheet(item: $editing) { rule in
                RuleEditor(rule: rule) { changed in
                    if let at = rules.firstIndex(where: { $0.id == rule.id }) { rules[at] = changed }
                    save(apply: true)
                }
            }
            .onAppear { rules = library.indexer?.rules ?? [] }
        }
    }

    private func save(apply: Bool) {
        let set = rules
        Task {
            let tagged = await library.indexer?.setRules(set, apply: apply) ?? 0
            if apply { applied = tagged }
            rules = library.indexer?.rules ?? set
        }
    }
}

struct RuleEditor: View {
    @State var rule: TagRule
    let done: (TagRule) -> Void
    @State private var words = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Tag", text: $rule.tag)
                        .accessibilityIdentifier("rule.tag")
                    TextField("Words, separated by commas", text: $words)
                        .accessibilityIdentifier("rule.words")
                } footer: {
                    Text("A phrase in quotation marks must appear as written. Tashkeel and letter forms do not matter.")
                }
                Section {
                    Picker("Look in", selection: Binding(get: { rule.scope ?? "both" }, set: { rule.scope = $0 })) {
                        Text("The text").tag("text")
                        Text("The file name").tag("name")
                        Text("Both").tag("both")
                    }
                    Toggle("Every word must appear", isOn: Binding(get: { rule.all ?? false }, set: { rule.all = $0 }))
                    Toggle("Enabled", isOn: Binding(get: { rule.enabled ?? true }, set: { rule.enabled = $0 }))
                }
            }
            .navigationTitle(rule.tag.isEmpty ? Text("New rule") : Text(rule.tag))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var saved = rule
                        saved.tag = rule.tag.trimmingCharacters(in: .whitespaces)
                        saved.words = words.split(whereSeparator: { $0 == "," || $0 == "،" || $0 == "\n" })
                            .map { $0.trimmingCharacters(in: .whitespaces) }
                            .filter { !$0.isEmpty }
                        done(saved)
                        dismiss()
                    }
                    .disabled(rule.tag.trimmingCharacters(in: .whitespaces).isEmpty || words.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("rule.save")
                }
            }
            .onAppear { words = rule.words.joined(separator: ", ") }
        }
        .presentationDetents([.medium, .large])
    }
}
