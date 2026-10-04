import SwiftUI

/// Redact and Prepare form as the document screen holds them: their models,
/// which of them is open, and the sheets and questions each puts over the
/// pages — kept here so the screen itself only places their bars and
/// inspectors (`DocumentView`).
@MainActor @Observable
final class DocumentTools {
    let redact: RedactModel
    let form: FormModel
    var redacting = false
    var preparing = false
    var showingFind = false
    var showingHidden = false
    /// The marks or the fields in a sheet, on a phone (an iPad has them
    /// beside the pages).
    var showingMarks = false
    var showingFields = false
    var showingFill = false
    /// Apply asked for: the warning is up.
    var confirmingApply = false
    /// The file is signed, which the warning says.
    var signed = false
    /// Done asked for with marks or drafts still waiting.
    var closingRedact = false
    var closingForm = false

    init(model: DocumentModel) {
        redact = RedactModel(model: model)
        form = FormModel(model: model)
    }

    var undoManager: UndoManager? {
        get { redact.undoManager }
        set {
            redact.undoManager = newValue
            form.undoManager = newValue
        }
    }

    /// Asks before applying: what is under the marks goes for good once
    /// the file is saved.
    func askToApply() {
        guard !redact.marks.isEmpty else { return }
        Task {
            signed = await redact.isSigned()
            confirmingApply = true
        }
    }

    func finishRedact(force: Bool = false) {
        if !force, !redact.marks.isEmpty {
            closingRedact = true
            return
        }
        redact.selected = nil
        redacting = false
    }

    func finishForm(force: Bool = false) {
        if !force, !form.drafts.isEmpty {
            closingForm = true
            return
        }
        form.placing = nil
        form.selected = nil
        preparing = false
    }
}

/// The sheets and questions of Redact and Prepare form.
struct DocumentToolSheets: ViewModifier {
    @Bindable var tools: DocumentTools

    func body(content: Content) -> some View {
        answers(to: questions(on: sheets(on: content)))
    }

    private func sheets(on content: some View) -> some View {
        content
            .sheet(isPresented: $tools.showingFind) {
                FindRedactSheet(redact: tools.redact)
            }
            .sheet(isPresented: $tools.showingHidden) {
                HiddenInfoSheet(redact: tools.redact)
            }
            .sheet(isPresented: $tools.showingMarks) {
                AppSheet(title: "Marks") {
                    RedactMarksList(redact: tools.redact)
                }
            }
            .sheet(isPresented: $tools.showingFields) {
                AppSheet(title: "Fields") {
                    FormInspector(form: tools.form)
                }
            }
            .sheet(isPresented: $tools.showingFill) {
                FillFormSheet(form: tools.form)
            }
    }

    /// What Apply and Done ask before they act.
    private func questions(on content: some View) -> some View {
        content
            .alert(applyTitle, isPresented: $tools.confirmingApply) {
                Button("Apply", role: .destructive) {
                    Task { await tools.redact.apply() }
                }
                .accessibilityIdentifier("redact.confirm")
                Button("Cancel", role: .cancel) {}
            } message: {
                if tools.signed {
                    Text("What is under the marks is taken out of the file, not just covered. You can undo until you save; once saved, it cannot be brought back. This file is signed: the signature will show it was changed.")
                } else {
                    Text("What is under the marks is taken out of the file, not just covered. You can undo until you save; once saved, it cannot be brought back.")
                }
            }
            .alert("The marks are not applied", isPresented: $tools.closingRedact) {
                Button("Apply…") { tools.askToApply() }
                Button("Keep them for later") { tools.finishRedact(force: true) }
                Button("Discard them", role: .destructive) {
                    tools.redact.removeAll()
                    tools.finishRedact(force: true)
                }
            } message: {
                Text("Nothing under them is taken out until they are applied.")
            }
            .alert("The fields are not made yet", isPresented: $tools.closingForm) {
                Button("Create") {
                    Task {
                        await tools.form.create()
                        if tools.form.drafts.isEmpty { tools.finishForm(force: true) }
                    }
                }
                Button("Keep them for later") { tools.finishForm(force: true) }
                Button("Discard them", role: .destructive) {
                    tools.form.removeAllDrafts()
                    tools.finishForm(force: true)
                }
            } message: {
                Text("The drafts become fields in the file only when they are created.")
            }
    }

    /// What the tools answer after they acted, or why they could not.
    private func answers(to content: some View) -> some View {
        content
            .alert("Redacted", isPresented: Binding(get: { tools.redact.applied != nil }, set: { if !$0 { tools.redact.applied = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                summary
            }
            .alert("Could not redact", isPresented: Binding(get: { tools.redact.error != nil }, set: { if !$0 { tools.redact.clearError() } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(tools.redact.error ?? "")
            }
            .alert("Prepare form", isPresented: Binding(get: { tools.form.notice != nil }, set: { if !$0 { tools.form.notice = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(tools.form.notice ?? "")
            }
            .alert("Could not make the fields", isPresented: Binding(get: { tools.form.error != nil && !tools.showingFill }, set: { if !$0 { tools.form.clearError() } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(tools.form.error ?? "")
            }
            .sensoryFeedback(.success, trigger: tools.redact.changes)
            .sensoryFeedback(.success, trigger: tools.form.changes)
    }

    private var applyTitle: Text {
        Text("Apply the redaction marks (\(tools.redact.marks.count))?")
    }

    /// What the core took out, in words.
    private var summary: Text {
        guard let a = tools.redact.applied else { return Text(verbatim: "") }
        var lines: [Text] = [Text("Characters of text taken out: \(a.glyphs).")]
        if a.images > 0 { lines.append(Text("Pictures whose pixels under the marks were taken out: \(a.images).")) }
        if a.imagesRemoved > 0 { lines.append(Text("Pictures that could not be read, taken out whole: \(a.imagesRemoved).")) }
        if a.paths > 0 { lines.append(Text("Drawings taken out: \(a.paths).")) }
        if a.annotations > 0 { lines.append(Text("Comments and form fields removed: \(a.annotations).")) }
        if a.runs > 0 { lines.append(Text("Runs of text in a font whose letters could not be placed, taken out whole: \(a.runs).")) }
        lines.append(Text("Save to keep it; until then you can undo."))
        return lines.dropFirst().reduce(lines[0]) { $0 + Text(verbatim: "\n") + $1 }
    }
}
