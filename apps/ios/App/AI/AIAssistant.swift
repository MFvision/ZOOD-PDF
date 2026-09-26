import SwiftUI
import ZoodCore

/// On-device assistant: ask about the PDF (answers cite pages; tap a citation to jump there),
/// summarize, explain simply, translate Arabic ↔ English, key points. Runs on Apple's on-device
/// model or on the downloaded Qwen3 model; nothing is sent anywhere, and the exact prompt can be
/// inspected ("Show prompt").
struct AIAssistantSheet: View {
    let session: DocumentSession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var ai = LocalAI.shared
    @State private var pages: [PageContent]?
    @State private var scope: ScopeChoice = .document
    @State private var question = ""
    @State private var prompt: LocalPrompt?
    @State private var usedBackend: AIBackendChoice?
    @State private var answer = ""
    @State private var running: Task<Void, Never>?
    @State private var error: String?
    @State private var detent: PresentationDetent = .large
    @State private var showSettings = false

    enum ScopeChoice: Hashable { case page, document }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    backendBadge
                    switch choice {
                    case .needsModel:
                        ModelSetupCard()
                    case .unavailable:
                        Text("ai.unavailable").font(.callout).foregroundStyle(.secondary)
                            .padding(14).frame(maxWidth: .infinity, alignment: .leading).glass()
                    case .apple, .portable:
                        controls
                    }
                    if !answer.isEmpty || running != nil { answerCard }
                    if let error { Text(verbatim: error).foregroundStyle(.red).font(.callout) }
                    if let prompt { promptDisclosure(prompt) }
                }
                .padding(16)
            }
            .background(AppBackdrop())
            .navigationTitle(Text(ToolKind.ai.title))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("common.done") {
                        running?.cancel()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { showSettings = true } label: { Label("ai.settings", systemImage: "gearshape") }
                }
            }
            .sheet(isPresented: $showSettings) { AISettingsView() }
            .task { pages = await session.pageTexts() }
            .environment(\.openURL, OpenURLAction { url in
                if let page = CitationLink.page(from: url) {
                    session.goTo(page: page - 1)
                    detent = .medium
                    return .handled
                }
                return .systemAction
            })
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
    }

    // MARK: - Pieces

    private var uiLanguage: ContentLanguage {
        ContentLanguage(identifier: locale.identifier) ?? .english
    }

    private var documentLanguage: ContentLanguage {
        guard let pages else { return uiLanguage }
        return TextScript.dominantLanguage(String(pages.map(\.text).joined(separator: " ").prefix(4_000))) ?? uiLanguage
    }

    /// The model for the current document and app language (the badge and the controls).
    private var choice: AIBackendChoice {
        ai.choice(for: [uiLanguage, documentLanguage])
    }

    /// Translation also needs the target language.
    private func backendChoice(for task: AITask) -> AIBackendChoice {
        task == .translate ? ai.choice(for: [uiLanguage, documentLanguage, documentLanguage.other]) : choice
    }

    private var backendBadge: some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.shield").foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 2) {
                Text("ai.onDevice").font(.subheadline.weight(.semibold))
                if choice == .apple || choice == .portable {
                    Text(verbatim: ai.backendName(choice)).font(.caption).foregroundStyle(.secondary)
                } else if let reason = ai.appleUnavailableReason {
                    Text(verbatim: reason).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker(selection: $scope) {
                Text("ai.scope.page \(session.pageIndex + 1)").tag(ScopeChoice.page)
                Text("ai.scope.document").tag(ScopeChoice.document)
            } label: {
                Text("ai.scope")
            }
            .pickerStyle(.segmented)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    chip(.summarize, "ai.chip.summarize", "text.alignleft")
                    chip(.explain, "ai.chip.explain", "lightbulb")
                    chip(.translate, "ai.chip.translate", "character.bubble")
                    chip(.keyPoints, "ai.chip.keyPoints", "list.bullet")
                }
            }
            HStack {
                TextField("ai.placeholder", text: $question, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(ask)
                Button(action: ask) {
                    Label("ai.ask", systemImage: "arrow.up.circle.fill").labelStyle(.iconOnly).font(.title2)
                }
                .disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || running != nil || pages == nil)
            }
        }
    }

    private func chip(_ task: AITask, _ title: LocalizedStringKey, _ symbol: String) -> some View {
        Button {
            run(task)
        } label: {
            Label(title, systemImage: symbol).padding(.horizontal, 12).padding(.vertical, 7)
        }
        .buttonStyle(PressableStyle())
        .glass(18)
        .disabled(running != nil || pages == nil)
    }

    private var answerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let prompt, prompt.partial {
                Label("ai.partial", systemImage: "info.circle").font(.caption).foregroundStyle(.orange)
            }
            Text(CitationLink.attributed(answer, pageCount: session.pageCount, locale: locale))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .environment(\.layoutDirection, prompt?.answerLanguage == .arabic ? .rightToLeft : .leftToRight)
            HStack {
                if running != nil {
                    ProgressView()
                    Button("common.stop") { running?.cancel() }
                } else if let used = usedBackend {
                    Text(verbatim: ai.backendName(used)).font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        UIPasteboard.general.string = answer
                    } label: {
                        Label("ai.copy", systemImage: "doc.on.doc")
                    }
                    .font(.caption)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass()
    }

    private func promptDisclosure(_ prompt: LocalPrompt) -> some View {
        DisclosureGroup {
            ScrollView {
                Text(verbatim: prompt.fullText)
                    .font(.caption.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 220)
        } label: {
            Text("ai.showPrompt").font(.subheadline)
        }
        .padding(14)
        .glass()
    }

    // MARK: - Running

    private func ask() {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        run(.ask, question: q)
    }

    private func run(_ task: AITask, question: String = "") {
        guard let pages else { return }
        guard pages.contains(where: { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            error = String(localized: "ai.error.noText")
            return
        }
        let backend = backendChoice(for: task)
        guard backend == .apple || backend == .portable else {
            let reason: LocalAIError = backend == .needsModel ? .noModel : (ai.appleAvailable ? .unsupportedLanguage : .runtimeMissing)
            error = reason.localizedDescription
            return
        }
        let aiScope: AIScope = scope == .page ? .page(session.pageIndex) : .document
        let ui = uiLanguage
        answer = ""
        error = nil
        usedBackend = backend
        running = Task {
            var budget = ai.budget(for: backend)
            // One retry with half the text if the model's context window overflows.
            for attempt in 0..<2 {
                let p = LocalPromptBuilder.build(task: task, scope: aiScope, pages: pages, question: question, uiLanguage: ui, budget: budget)
                prompt = p
                answer = ""
                do {
                    for try await piece in ai.stream(p, using: backend) {
                        answer += piece
                    }
                    break
                } catch LocalAIError.contextOverflow where attempt == 0 {
                    budget = budget.halved
                } catch is CancellationError {
                    break
                } catch {
                    self.error = error.localizedDescription
                    break
                }
            }
            running = nil
        }
    }
}

/// Page citations as in-text links (`zoodpdf-cite:3`), handled by the sheet's openURL action.
enum CitationLink {
    static let scheme = "zoodpdf-cite"

    static func page(from url: URL) -> Int? {
        guard url.scheme == scheme else { return nil }
        return Int(url.absoluteString.dropFirst(scheme.count + 1))
    }

    static func attributed(_ answer: String, pageCount: Int, locale: Locale) -> AttributedString {
        var out = AttributedString()
        for segment in CitationParser.parse(answer, pageCount: pageCount) {
            switch segment {
            case .text(let t):
                let md = try? AttributedString(
                    markdown: t, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
                out += md ?? AttributedString(t)
            case .citation(let pages):
                for (i, page) in pages.enumerated() {
                    var link = AttributedString(String(localized: "ai.cite \(page)", locale: locale))
                    link.link = URL(string: "\(scheme):\(page)")
                    link.font = .caption.weight(.semibold)
                    if i > 0 { out += AttributedString(" ") }
                    out += AttributedString("[") + link + AttributedString("]")
                }
            }
        }
        return out
    }
}
