import PDFKit
import SwiftUI

/// The AI sheet over a document: a task, a question for "Ask", the answer,
/// and a line saying what the model read. Shown only when the on-device
/// model is available (or a Debug run fakes it): elsewhere the toolbar has
/// no AI button and Settings says why.
struct AIPanel: View {
    @Bindable var assistant: AIAssistant
    var onAutofill: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        AppSheet(title: "AI on this device") {
            List {
                Section {
                    Picker("Task", selection: $assistant.task) {
                        ForEach(AITask.allCases) { task in
                            Label(task.title, systemImage: task.symbol).tag(task)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("ai.task")
                    if assistant.task.takesQuestion {
                        TextField("Your question", text: $assistant.question, axis: .vertical)
                            .lineLimit(1...4)
                            .submitLabel(.go)
                            .onSubmit(run)
                            .accessibilityIdentifier("ai.question")
                    }
                    Button(action: run) {
                        HStack {
                            Label(assistant.task.title, systemImage: "sparkles")
                            Spacer()
                            if assistant.isWorking {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(assistant.isWorking)
                    .accessibilityIdentifier("ai.run")
                } header: {
                    Text("Ask the document")
                } footer: {
                    Text("The model runs on this device. Nothing leaves it.")
                }

                answerSection

                if hasTextFields {
                    Section {
                        Button("Fill the form from my profile", systemImage: "rectangle.and.pencil.and.ellipsis") {
                            onAutofill()
                        }
                        .accessibilityIdentifier("ai.autofill")
                    } footer: {
                        Text("Proposes a value for the form's text fields from your profile or the document's own text. You review every value before anything is written.")
                    }
                }
            }
            .accessibilityIdentifier("ai.list")
        }
        .sensoryFeedback(.success, trigger: isAnswered)
    }

    /// Autofill is offered only for a document with text fields to fill.
    private var hasTextFields: Bool {
        guard let pdf = assistant.model.pdf else { return false }
        return (0..<pdf.pageCount).contains { index in
            pdf.page(at: index)?.annotations.contains { $0.type == "Widget" && $0.widgetFieldType == .text && !$0.isReadOnly } ?? false
        }
    }

    private var isAnswered: Bool {
        if case .answered = assistant.state { return true }
        return false
    }

    @ViewBuilder
    private var answerSection: some View {
        switch assistant.state {
        case .idle:
            EmptyView()
        case .working:
            Section {
                HStack(spacing: Space.x3) {
                    ProgressView()
                    Text("Reading…")
                        .foregroundStyle(Surface.secondaryLabel)
                }
            }
        case let .answered(answer):
            Section {
                Text(answer)
                    .font(TextStyle.body)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("ai.answer")
                if let context = assistant.context {
                    contextNote(context)
                }
            } header: {
                Text("Answer")
            }
            Section {
                ShareLink(item: answer) {
                    Label("Share the answer", systemImage: "square.and.arrow.up")
                }
                Button("Copy", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = answer
                }
            }
        case let .failed(message):
            Section {
                Label {
                    Text(message)
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                .accessibilityIdentifier("ai.error")
            }
        }
    }

    private func contextNote(_ context: AIContext) -> some View {
        let pages = context.pages.map { String($0 + 1) }.joined(separator: ", ")
        return Group {
            if context.retrieved {
                Text("Read the passages that match the question, on pages \(pages).")
            } else if context.truncated {
                Text("Read the beginning of the document only (pages \(pages)): the on-device model reads a few pages at a time.")
            } else {
                Text("Read the whole document.")
            }
        }
        .font(TextStyle.caption)
        .foregroundStyle(Surface.secondaryLabel)
        .accessibilityIdentifier("ai.context")
    }

    private func run() {
        guard !assistant.isWorking else { return }
        Task { await assistant.run() }
    }
}

/// The review of what autofill proposes: every field with its value and
/// where it came from; each can be changed or left out. Nothing is written
/// until the Fill button.
struct AutofillReviewSheet: View {
    @Bindable var autofill: FormAutofillModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        AppSheet(title: "Fill the form") {
            List {
                switch autofill.state {
                case .idle, .reading:
                    Section {
                        HStack(spacing: Space.x3) {
                            ProgressView()
                            Text("Reading the form…")
                                .foregroundStyle(Surface.secondaryLabel)
                        }
                    }
                case .noProfile:
                    Section {
                        Label("Your profile is empty. Add your details in Settings first.", systemImage: "person.crop.circle.badge.questionmark")
                            .accessibilityIdentifier("autofill.noProfile")
                    }
                case .noFields:
                    Section {
                        Label("This document has no text fields to fill.", systemImage: "rectangle.dashed")
                            .accessibilityIdentifier("autofill.noFields")
                    }
                case .nothingFound:
                    Section {
                        Label("Nothing in your profile or the document answers these fields.", systemImage: "questionmark.circle")
                            .accessibilityIdentifier("autofill.nothing")
                    }
                case .proposed:
                    Section {
                        ForEach($autofill.proposals) { $proposal in
                            ProposalRow(proposal: $proposal)
                        }
                    } header: {
                        Text("Proposed values")
                    } footer: {
                        Text("Review every value. A field that already holds something stays as it is unless you turn it on. Nothing is written until you press Fill.")
                    }
                    Section {
                        Button {
                            Task { await autofill.write(undoManager: undoManager) }
                        } label: {
                            HStack {
                                Label("Fill \(autofill.acceptedCount) fields", systemImage: "checkmark.circle")
                                Spacer()
                                if autofill.isWriting { ProgressView() }
                            }
                        }
                        .disabled(autofill.acceptedCount == 0 || autofill.isWriting)
                        .accessibilityIdentifier("autofill.fill")
                    }
                case let .written(count):
                    Section {
                        Label("Filled \(count) fields. Check them on the page, then save.", systemImage: "checkmark.seal")
                            .accessibilityIdentifier("autofill.done")
                        Button("Done") { dismiss() }
                    }
                case let .failed(message):
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .accessibilityIdentifier("autofill.error")
                    }
                }
            }
            .accessibilityIdentifier("autofill.list")
        }
        .task { await autofill.start() }
        .sensoryFeedback(.success, trigger: autofill.writtenCount)
    }
}

/// One proposed value: the field's label, its value (editable) and a
/// switch for whether it is written.
private struct ProposalRow: View {
    @Binding var proposal: FillProposal

    var body: some View {
        VStack(alignment: .leading, spacing: Space.x2) {
            Toggle(isOn: $proposal.accepted) {
                VStack(alignment: .leading, spacing: Space.x1) {
                    Text(proposal.field.label.isEmpty ? proposal.field.name : proposal.field.label)
                        .font(TextStyle.headline)
                        .lineLimit(2)
                    source
                        .font(TextStyle.caption)
                        .foregroundStyle(Surface.secondaryLabel)
                    if !proposal.field.current.isEmpty {
                        Text("Now: \(proposal.field.current)")
                            .font(TextStyle.caption)
                            .foregroundStyle(Surface.secondaryLabel)
                            .lineLimit(1)
                            .accessibilityIdentifier("autofill.current.\(proposal.field.name)")
                    }
                }
            }
            .accessibilityIdentifier("autofill.accept.\(proposal.field.name)")
            TextField("Value", text: $proposal.value)
                .textFieldStyle(.roundedBorder)
                .disabled(!proposal.accepted)
                .accessibilityIdentifier("autofill.value.\(proposal.field.name)")
        }
        .padding(.vertical, Space.x1)
    }

    private var source: Text {
        switch proposal.source {
        case .profile: Text("From your profile")
        case .document: Text("From the document's text")
        }
    }
}

/// The autofill flow for one document: read the fields, propose, review,
/// write.
@MainActor @Observable
final class FormAutofillModel: Identifiable {
    enum State: Equatable {
        case idle
        case reading
        case noProfile
        case noFields
        case nothingFound
        case proposed
        case written(Int)
        case failed(String)
    }

    /// How many fields were written, once they were (for the haptic).
    var writtenCount: Int? {
        if case let .written(count) = state { return count }
        return nil
    }

    let id = UUID()
    let model: DocumentModel
    let engine: any AIEngine
    let profile: Profile
    private(set) var state: State = .idle
    var proposals: [FillProposal] = []
    private(set) var isWriting = false

    init(model: DocumentModel, engine: any AIEngine, profile: Profile) {
        self.model = model
        self.engine = engine
        self.profile = profile
    }

    var acceptedCount: Int {
        proposals.count { $0.accepted && !$0.value.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    func start() async {
        guard state == .idle else { return }
        state = .reading
        let fields = await FormAutofill.fields(in: model)
        if fields.isEmpty {
            state = .noFields
            return
        }
        // The document's text: what a quote must be copied from.
        var text = ""
        for page in 0..<model.pageCount {
            if let pageText = await model.text(ofPage: page) {
                text += pageText + "\n"
            }
            if text.count > AIContextBuilder.budget { break }
        }
        if profile.isEmpty, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            state = .noProfile
            return
        }
        do {
            proposals = try await FormAutofill.propose(fields: fields, profile: profile, documentText: String(text.prefix(AIContextBuilder.budget)), engine: engine)
            state = proposals.isEmpty ? (profile.isEmpty ? .noProfile : .nothingFound) : .proposed
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func write(undoManager: UndoManager?) async {
        guard !isWriting else { return }
        isWriting = true
        defer { isWriting = false }
        do {
            let count = try await FormAutofill.write(proposals, into: model, undoManager: undoManager)
            state = .written(count)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
