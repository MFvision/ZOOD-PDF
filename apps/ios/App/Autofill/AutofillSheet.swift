import PDFKit
import SwiftUI
import ZoodCore

/// Fill a PDF form from "My details" and the document's own text. Every proposal shows where
/// its value comes from and is reviewed (and can be edited or unticked) before anything is
/// written; then the values are written into the form and saved as an incremental update.
struct AutofillSheet: View {
    let session: DocumentSession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var ai = LocalAI.shared
    @State private var entries: [FormReader.Entry] = []
    @State private var rows: [Row] = []
    @State private var profile = ProfileRepository.store.load()
    @State private var pages: [PageContent] = []
    @State private var loaded = false
    @State private var asking: Task<Void, Never>?
    @State private var dropped = 0
    @State private var error: String?
    @State private var prompt: LocalPrompt?
    @State private var showProfile = false

    struct Row: Identifiable {
        var id: String { proposal.fieldID }
        let proposal: AutofillProposal
        let field: FormField
        var value: String
        var accepted: Bool
    }

    var body: some View {
        NavigationStack {
            List {
                if loaded && entries.isEmpty {
                    ContentUnavailableView("autofill.noFields", systemImage: "text.badge.xmark",
                                           description: Text("autofill.noFields.detail"))
                } else {
                    header
                    if !rows.isEmpty {
                        Section {
                            ForEach($rows) { $row in rowView($row) }
                        } header: {
                            Text("autofill.proposals \(rows.count)")
                        } footer: {
                            Text("autofill.review.footer")
                        }
                    }
                    if dropped > 0 {
                        Label("autofill.dropped \(dropped)", systemImage: "shield.lefthalf.filled")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let error { Text(verbatim: error).foregroundStyle(.red) }
                    if let prompt {
                        DisclosureGroup("ai.showPrompt") {
                            Text(verbatim: prompt.fullText).font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                }
            }
            .navigationTitle(Text("autofill.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("common.cancel") { asking?.cancel(); dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("autofill.apply \(acceptedCount)") { Task { await apply() } }
                        .disabled(!rows.contains(where: \.accepted) || session.isBusy)
                }
            }
            .sheet(isPresented: $showProfile, onDismiss: reload) {
                NavigationStack { ProfileView() }
            }
            .task { await load() }
        }
    }

    private var acceptedCount: Int { rows.filter(\.accepted).count }

    @ViewBuilder private var header: some View {
        Section {
            Text("autofill.subtitle").font(.callout).foregroundStyle(.secondary)
            Button { showProfile = true } label: {
                Label(profile.isEmpty ? "autofill.addDetails" : "autofill.editDetails", systemImage: "person.text.rectangle")
            }
            let choice = ai.choice(for: [.arabic, .english])
            if choice == .apple || choice == .portable {
                Button {
                    askModel(choice)
                } label: {
                    Label("autofill.askModel", systemImage: "sparkles")
                }
                .disabled(asking != nil || !loaded)
                if asking != nil { ProgressView() }
            } else if choice == .needsModel {
                Text("autofill.modelHint").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func rowView(_ row: Binding<Row>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: row.accepted) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: row.wrappedValue.field.label.isEmpty ? row.wrappedValue.field.name : row.wrappedValue.field.label)
                        .font(.subheadline.weight(.semibold))
                    Text("autofill.page \(row.wrappedValue.field.page + 1)").font(.caption2).foregroundStyle(.secondary)
                }
            }
            switch row.wrappedValue.field.kind {
            case .checkbox:
                Text(row.wrappedValue.value == "on" ? "autofill.checked" : "autofill.unchecked").font(.callout)
            case .choice:
                Picker("autofill.value", selection: row.value) {
                    ForEach(row.wrappedValue.field.options, id: \.self) { Text(verbatim: $0).tag($0) }
                }
            default:
                TextField("autofill.value", text: row.value)
                    .textFieldStyle(.roundedBorder)
            }
            sourceBadge(row.wrappedValue.proposal)
        }
        .padding(.vertical, 4)
    }

    private func sourceBadge(_ p: AutofillProposal) -> some View {
        HStack(spacing: 4) {
            switch p.source {
            case .profile(let key):
                Image(systemName: "person.crop.circle")
                Text("autofill.source.profile \(Self.keyName(key))")
            case .document(let page):
                Image(systemName: "doc.text")
                Text("autofill.source.document \(page)")
            }
            if p.fromModel {
                Text(verbatim: "·")
                Image(systemName: "sparkles")
                Text("autofill.source.model")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    static func keyName(_ key: ProfileKey) -> String {
        switch key {
        case .fullNameArabic: String(localized: "profile.nameArabic")
        case .fullNameEnglish: String(localized: "profile.nameEnglish")
        case .firstNameArabic, .firstNameEnglish: String(localized: "profile.firstName")
        case .lastNameArabic, .lastNameEnglish: String(localized: "profile.lastName")
        case .nationalID: String(localized: "profile.nationalID")
        case .nationality: String(localized: "profile.nationality")
        case .phone: String(localized: "profile.phone")
        case .email: String(localized: "profile.email")
        case .address: String(localized: "profile.address")
        case .city: String(localized: "profile.city")
        case .postalCode: String(localized: "profile.postalCode")
        case .dateOfBirthGregorian: String(localized: "profile.dob.gregorian")
        case .dateOfBirthHijri: String(localized: "profile.dob.hijri")
        case .employer: String(localized: "profile.employer")
        case .jobTitle: String(localized: "profile.jobTitle")
        }
    }

    // MARK: - Actions

    private func load() async {
        guard let pdf = session.pdf else { return }
        entries = FormReader.entries(in: pdf)
        pages = await session.pageTexts()
        loaded = true
        reload()
    }

    /// Rule-based proposals from the profile (instant, no model).
    private func reload() {
        profile = ProfileRepository.store.load()
        let fields = entries.map(\.field)
        let rules = AutofillMatcher.proposals(fields: fields, profile: profile)
        let modelRows = rows.filter { $0.proposal.fromModel && !rules.map(\.fieldID).contains($0.id) }
        rows = rules.compactMap { p in
            fields.first { $0.id == p.fieldID }.map { Row(proposal: p, field: $0, value: p.value, accepted: true) }
        } + modelRows
    }

    /// The on-device model proposes values for the fields the rules could not fill.
    private func askModel(_ choice: AIBackendChoice) {
        let taken = Set(rows.map(\.id))
        let open = entries.map(\.field).filter { $0.isFillable && $0.currentValue.isEmpty && !taken.contains($0.id) }
        guard !open.isEmpty else { return }
        let p = AutofillPromptBuilder.build(fields: open, profile: profile, pages: pages, budget: ai.budget(for: choice))
        prompt = p
        error = nil
        let pageCount = session.pageCount
        asking = Task {
            do {
                let raw = try await ai.autofill(p, fields: open, pageCount: pageCount, using: choice)
                let result = AutofillValidator.validate(raw, fields: open, profile: profile, pages: pages)
                dropped = result.rejected.count
                for proposal in result.accepted {
                    guard let f = open.first(where: { $0.id == proposal.fieldID }) else { continue }
                    // Model proposals start unticked: the user opts in to each one.
                    rows.append(Row(proposal: proposal, field: f, value: proposal.value, accepted: false))
                }
            } catch is CancellationError {
            } catch {
                self.error = error.localizedDescription
            }
            asking = nil
        }
    }

    /// Write the ticked values into the form, then save incrementally.
    private func apply() async {
        let byID = Dictionary(uniqueKeysWithValues: entries.map { ($0.field.id, $0) })
        var written = 0
        for row in rows where row.accepted {
            guard let entry = byID[row.id] else { continue }
            let value = row.value.trimmingCharacters(in: .whitespacesAndNewlines)
            if entry.field.kind == .text, AutofillValidator.checkText(value, field: entry.field) != nil { continue }
            FormReader.write(value, kind: entry.field.kind, to: entry.widgets)
            written += 1
        }
        guard written > 0 else { return }
        session.formEdited()
        if await session.save() {
            session.toast = Toast(message: String(localized: "autofill.done \(written)"))
            dismiss()
        }
    }
}
