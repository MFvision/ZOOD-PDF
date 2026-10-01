import SwiftUI

/// Find and redact: words found the way the find bar finds them — Arabic
/// without its diacritics, alef, taa marbuta, yaa and digit forms as one —
/// and ready-made patterns (emails, phones, national ID and Iqama numbers,
/// IBANs, card numbers, dates) or a pattern of the person's own, anywhere on
/// every page. Each match is listed with its page and the words round it;
/// the chosen ones become marks over their own glyphs, to review and apply.
/// A match the reader cannot place is listed, never guessed at: it is marked
/// by hand on the page.
struct FindRedactSheet: View {
    @Bindable var redact: RedactModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Words to find", text: $redact.query)
                        .submitLabel(.search)
                        .onSubmit { Task { await redact.search() } }
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("redact.find.query")
                } footer: {
                    Text("Arabic is found with or without its diacritics, and whatever the form of alef, taa marbuta, yaa or the digits.")
                }
                Section("Patterns") {
                    ForEach(RedactModel.patterns, id: \.self) { pattern in
                        Toggle(isOn: Binding(
                            get: { redact.chosenPatterns.contains(pattern) },
                            set: { on in
                                if on { redact.chosenPatterns.insert(pattern) } else { redact.chosenPatterns.remove(pattern) }
                            }
                        )) {
                            Text(Self.title(of: pattern))
                        }
                        .accessibilityIdentifier("redact.pattern.\(pattern)")
                    }
                }
                Section {
                    TextField("A pattern of your own", text: $redact.custom)
                        .font(.system(.body, design: .monospaced))
                        .environment(\.layoutDirection, .leftToRight)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("redact.find.custom")
                } footer: {
                    Text("A regular expression, read left to right.")
                }
                Section {
                    Button {
                        Task { await redact.search() }
                    } label: {
                        if redact.working {
                            ProgressView()
                        } else {
                            Label("Search", systemImage: "magnifyingglass")
                        }
                    }
                    .disabled(!redact.canSearch || redact.working)
                    .accessibilityIdentifier("redact.find.go")
                }
                if redact.searched {
                    results
                }
            }
            .navigationTitle("Find and redact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                        .accessibilityIdentifier("redact.find.close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        redact.markChosenMatches()
                        dismiss()
                    } label: {
                        Text("Mark \(redact.chosenMatches.count)")
                    }
                    .disabled(redact.chosenMatches.isEmpty)
                    .accessibilityIdentifier("redact.find.mark")
                }
            }
        }
        .presentationDetents([.large])
    }

    @ViewBuilder
    private var results: some View {
        Section {
            if redact.matches.isEmpty {
                Text("Nothing found.")
                    .foregroundStyle(Surface.secondaryLabel)
                    .accessibilityIdentifier("redact.find.none")
            }
            ForEach(redact.matches) { match in
                Button {
                    guard match.isPlaced else { return }
                    if redact.chosenMatches.contains(match.id) {
                        redact.chosenMatches.remove(match.id)
                    } else {
                        redact.chosenMatches.insert(match.id)
                    }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: Space.x3) {
                        Image(systemName: redact.chosenMatches.contains(match.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(match.isPlaced ? Color.accentColor : Surface.tertiaryLabel)
                        VStack(alignment: .leading, spacing: Space.x1) {
                            (Text(verbatim: match.before).foregroundStyle(Surface.secondaryLabel)
                                + Text(verbatim: match.text).bold().foregroundStyle(Color(.systemRed))
                                + Text(verbatim: match.after).foregroundStyle(Surface.secondaryLabel))
                                .font(TextStyle.callout)
                                .lineLimit(2)
                            HStack(spacing: Space.x2) {
                                Text("Page \(match.page + 1)")
                                Text(Self.title(of: match.kind))
                                if match.pageMark {
                                    Text("In a page mark")
                                }
                            }
                            .font(TextStyle.caption)
                            .foregroundStyle(Surface.secondaryLabel)
                            if !match.isPlaced {
                                Text("Its letters cannot be placed on the page: mark it by hand.")
                                    .font(TextStyle.caption)
                                    .foregroundStyle(Color(.systemOrange))
                            }
                        }
                    }
                }
                .accessibilityIdentifier("redact.match.\(match.text)")
            }
        } header: {
            if !redact.matches.isEmpty {
                Text("Found: \(redact.total)")
                    .accessibilityIdentifier("redact.find.count")
            }
        } footer: {
            if redact.total > redact.matches.count {
                Text("The first \(redact.matches.count) of \(redact.total) are listed.")
            }
        }
        if !redact.matches.isEmpty {
            Section {
                Button("Choose all") {
                    redact.chosenMatches = Set(redact.matches.filter(\.isPlaced).map(\.id))
                }
                .accessibilityIdentifier("redact.find.all")
                Button("Choose none") {
                    redact.chosenMatches.removeAll()
                }
                .accessibilityIdentifier("redact.find.noneChosen")
            }
        }
    }

    /// What a pattern, or a match's kind, is called.
    static func title(of kind: String) -> LocalizedStringKey {
        switch kind {
        case "email": "Email addresses"
        case "phone": "Phone numbers"
        case "nationalId": "National ID and Iqama numbers"
        case "iban": "IBANs"
        case "card": "Card numbers"
        case "date": "Dates"
        case "custom": "Your pattern"
        default: "Words"
        }
    }
}

/// Remove hidden information: what the file carries besides its pages —
/// properties and XMP, scripts and actions, attachments, comments, form
/// data, hidden layers, bookmarks, thumbnails, private data, links, hidden
/// text, earlier revisions — reported by the core, chosen, and removed with
/// the file written whole, as the desktop does.
struct HiddenInfoSheet: View {
    @Bindable var redact: RedactModel
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("A file can carry more than its pages show: who made it, scripts, attachments, earlier versions. Check it to see what this one carries.")
                        .font(TextStyle.callout)
                    Button {
                        Task { await redact.inspect() }
                    } label: {
                        if redact.working {
                            ProgressView()
                        } else {
                            Label("Check the file", systemImage: "doc.text.magnifyingglass")
                        }
                    }
                    .disabled(redact.working)
                    .accessibilityIdentifier("hidden.check")
                }
                if let report = redact.report {
                    found(report)
                }
            }
            .navigationTitle("Hidden information")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                        .accessibilityIdentifier("hidden.close")
                }
            }
            .alert("Remove what was chosen?", isPresented: $confirming) {
                Button("Remove", role: .destructive) {
                    Task { await redact.removeHidden() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The file is written again without it, and without its earlier versions. You can undo until you save; once saved, it cannot be brought back.")
            }
        }
        .presentationDetents([.large])
    }

    @ViewBuilder
    private func found(_ report: RedactModel.Report) -> some View {
        let always = report.revisions + report.unreachable > 0
        if report.findings.isEmpty, !always {
            Section {
                Label("Nothing hidden was found.", systemImage: "checkmark.seal")
                    .accessibilityIdentifier("hidden.nothing")
            }
        } else {
            Section {
                ForEach(report.findings) { finding in
                    Toggle(isOn: Binding(
                        get: { redact.chosenFindings.contains(finding.kind) },
                        set: { on in
                            if on { redact.chosenFindings.insert(finding.kind) } else { redact.chosenFindings.remove(finding.kind) }
                        }
                    )) {
                        VStack(alignment: .leading, spacing: Space.x1) {
                            Text("\(Text(Self.title(of: finding.kind))) (\(finding.count))")
                            let details = finding.details.compactMap(Self.detail).joined(separator: " · ")
                            if !details.isEmpty {
                                Text(verbatim: details)
                                    .font(TextStyle.caption)
                                    .foregroundStyle(Surface.secondaryLabel)
                                    .lineLimit(3)
                            }
                        }
                    }
                    .accessibilityIdentifier("hidden.kind.\(finding.kind)")
                }
            } header: {
                Text("Found")
            } footer: {
                if always {
                    Text("Earlier versions of the file and objects nothing uses go whatever is chosen. Earlier versions: \(report.revisions). Unused objects: \(report.unreachable).")
                }
            }
            if report.signed {
                Section {
                    Label("This file is signed. Removing anything changes it after the signature, which will then show as changed.", systemImage: "signature")
                        .foregroundStyle(Color(.systemOrange))
                }
            }
            if report.protected || redact.isProtected {
                Section {
                    Label("A protected file cannot be cleaned: its password would be lost. Remove the password first.", systemImage: "lock")
                        .foregroundStyle(Color(.systemRed))
                }
            }
            Section {
                Button(role: .destructive) {
                    confirming = true
                } label: {
                    Label("Remove", systemImage: "trash")
                }
                .disabled(redact.working || report.protected || redact.isProtected || (redact.chosenFindings.isEmpty && !always))
                .accessibilityIdentifier("hidden.remove")
            }
        }
    }

    static func title(of kind: String) -> LocalizedStringKey {
        switch kind {
        case "metadata": "Properties and metadata"
        case "scripts": "Scripts and actions"
        case "attachments": "Attachments"
        case "comments": "Comments"
        case "forms": "Form fields and their data"
        case "hiddenLayers": "Hidden layers"
        case "bookmarks": "Bookmarks"
        case "thumbnails": "Page thumbnails"
        case "privateData": "Private data of other programs"
        case "links": "Links"
        case "hiddenText": "Hidden text"
        default: LocalizedStringKey(kind)
        }
    }

    /// A finding's detail in the interface's language: a property named and
    /// its value as the file has it, a name from the file as it is, a kind of
    /// annotation or the core's own word for what it counted.
    static func detail(_ d: RedactModel.Finding.Detail) -> String? {
        let count = d.count ?? 0
        if let property = d.property {
            return String(localized: "\(propertyName(property)): \(d.value ?? "")")
        }
        if let name = d.name { return name }
        if let subtype = d.subtype { return "\(annotationName(subtype)) (\(count))" }
        if let word = d.word { return "\(wordName(word)) (\(count))" }
        return nil
    }

    private static func propertyName(_ key: String) -> String {
        switch key {
        case "Title": String(localized: "Title")
        case "Author": String(localized: "Author")
        case "Subject": String(localized: "Subject")
        case "Keywords": String(localized: "Keywords")
        case "Creator": String(localized: "Creator")
        case "Producer": String(localized: "Producer")
        case "CreationDate": String(localized: "Created")
        case "ModDate": String(localized: "Modified")
        default: key
        }
    }

    private static func annotationName(_ subtype: String) -> String {
        switch subtype {
        case "Text": String(localized: "Notes")
        case "FreeText": String(localized: "Text boxes")
        case "Highlight": String(localized: "Highlights")
        case "Underline": String(localized: "Underlines")
        case "StrikeOut": String(localized: "Strike-throughs")
        case "Ink": String(localized: "Drawings")
        case "Square", "Circle", "Line", "Polygon", "PolyLine": String(localized: "Shapes")
        case "Stamp": String(localized: "Stamps")
        case "Popup": String(localized: "Pop-ups")
        case "FileAttachment": String(localized: "Attached files")
        default: subtype
        }
    }

    private static func wordName(_ word: String) -> String {
        switch word {
        case "invisible": String(localized: "Invisible text")
        case "white": String(localized: "White on white")
        case "offPage": String(localized: "Off the page")
        case "JavaScript": String(localized: "Scripts")
        case "OpenAction": String(localized: "Run on opening")
        case "AA": String(localized: "Run on events")
        case "Actions": String(localized: "Actions")
        case "Fields": String(localized: "Fields")
        case "XFA": String(localized: "XFA form")
        case "XMP": String(localized: "XMP metadata")
        default: word
        }
    }
}
