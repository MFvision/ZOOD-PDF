import SwiftUI
import ZoodCore

/// Streams a reply from the Anthropic Messages API with the user's own key. Called only from
/// the Send button; the request body is exactly `AIPrompt.fullText` shown on screen.
enum AIClient {
    static let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!

    static func stream(prompt: AIPrompt, apiKey: String, model: String) -> AsyncThrowingStream<String, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: endpoint)
                    request.httpMethod = "POST"
                    request.timeoutInterval = 600
                    request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
                    request.setValue(AIRequestBody.apiVersion, forHTTPHeaderField: "anthropic-version")
                    request.setValue(AIRequestBody.fallbackBeta, forHTTPHeaderField: "anthropic-beta")
                    request.setValue("application/json", forHTTPHeaderField: "content-type")
                    request.httpBody = try JSONEncoder().encode(AIRequestBody(prompt: prompt, model: model))
                    let config = URLSessionConfiguration.ephemeral
                    config.urlCache = nil
                    let session = URLSession(configuration: config)
                    let (bytes, response) = try await session.bytes(for: request)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    if status != 200 {
                        var body = Data()
                        for try await b in bytes { body.append(b); if body.count > 64_000 { break } }
                        throw AIError.http(status, AISSEParser.errorMessage(fromBody: body))
                    }
                    var parser = AISSEParser()
                    for try await line in bytes.lines {
                        // `lines` drops empty lines; SSE messages here are one data line each.
                        _ = parser.feed(line: line)
                        guard let event = parser.feed(line: "") else { continue }
                        switch event {
                        case .text(let t): continuation.yield(t)
                        case .stop(let reason):
                            if reason == "refusal" { throw AIError.refused }
                        case .error(let message): throw AIError.api(message)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    enum AIError: LocalizedError {
        case http(Int, String?)
        case api(String)
        case refused

        var errorDescription: String? {
            switch self {
            case .http(let code, let message): String(localized: "ai.error.http \(code) \(message ?? "")")
            case .api(let message): message
            case .refused: String(localized: "ai.error.refused")
            }
        }
    }
}

struct AIAssistantSheet: View {
    let session: DocumentSession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var apiKey = KeychainStore.read("anthropic") ?? ""
    @AppStorage("ai.model") private var model = AIRequestBody.defaultModel
    @State private var question = ""
    @State private var documentText: String?
    @State private var prompt: AIPrompt?
    @State private var answer = ""
    @State private var running: Task<Void, Never>?
    @State private var error: String?
    @State private var showKey = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("ai.subtitle").font(.callout).foregroundStyle(.secondary)
                    if apiKey.isEmpty || showKey { keyCard }
                    chips
                    HStack {
                        TextField("ai.placeholder", text: $question, axis: .vertical)
                            .lineLimit(1...4)
                            .textFieldStyle(.roundedBorder)
                        Button("ai.preview") { preparePrompt(question) }
                            .disabled(question.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    if let prompt { preview(prompt) }
                    if !answer.isEmpty {
                        Text(
                            (try? AttributedString(
                                markdown: answer,
                                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
                                ?? AttributedString(answer))
                            .textSelection(.enabled)
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glass()
                    }
                    if let error { Text(verbatim: error).foregroundStyle(.red) }
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
                    Button { showKey.toggle() } label: { Label("ai.settings", systemImage: "key") }
                }
            }
            .task {
                if let data = await session.currentBytes() {
                    documentText = await ThumbnailService.plainText(data, password: session.password, limit: .max) ?? ""
                }
            }
        }
    }

    private var keyCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ai.key.title").font(.headline)
            SecureField("ai.key.placeholder", text: $apiKey)
                .textContentType(.password)
                .textFieldStyle(.roundedBorder)
                .onSubmit(saveKey)
            TextField("ai.model", text: $model)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            HStack {
                Button("ai.key.save", action: saveKey).buttonStyle(.borderedProminent)
                Button("ai.key.forget", role: .destructive) {
                    apiKey = ""
                    KeychainStore.write(nil, account: "anthropic")
                }
            }
            Text("ai.key.footer").font(.caption).foregroundStyle(.secondary)
        }
        .padding(14)
        .glass()
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AISuggestion.allCases, id: \.self) { s in
                    Button {
                        preparePrompt(s.instruction(answerLanguage: answerLanguage))
                    } label: {
                        Text(chipTitle(s)).padding(.horizontal, 12).padding(.vertical, 7)
                    }
                    .buttonStyle(PressableStyle())
                    .glass(18)
                }
            }
        }
    }

    /// The exact text that will be sent, shown before Send.
    private func preview(_ prompt: AIPrompt) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ai.preview.title").font(.headline)
            if prompt.truncated { Text("ai.preview.truncated").font(.caption).foregroundStyle(.orange) }
            ScrollView {
                Text(verbatim: prompt.fullText)
                    .font(.caption.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 180)
            HStack {
                Button {
                    send(prompt)
                } label: {
                    Label("ai.send", systemImage: "paperplane.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(apiKey.isEmpty || running != nil)
                if running != nil {
                    ProgressView()
                    Button("common.stop") { running?.cancel(); running = nil }
                }
            }
            Text("ai.preview.footer").font(.caption).foregroundStyle(.secondary)
        }
        .padding(14)
        .glass()
    }

    private var answerLanguage: String {
        locale.language.languageCode?.identifier == "ar" ? "Arabic" : "English"
    }

    private func chipTitle(_ s: AISuggestion) -> LocalizedStringKey {
        switch s {
        case .summarize: "ai.chip.summarize"
        case .explain: "ai.chip.explain"
        case .translate: "ai.chip.translate"
        case .keyPoints: "ai.chip.keyPoints"
        case .quiz: "ai.chip.quiz"
        case .email: "ai.chip.email"
        }
    }

    private func preparePrompt(_ q: String) {
        guard let documentText else { return }
        if documentText.isEmpty {
            error = String(localized: "ai.error.noText")
            return
        }
        error = nil
        prompt = AIPrompt(documentName: session.name, documentText: documentText, question: q)
    }

    private func saveKey() {
        KeychainStore.write(apiKey.trimmingCharacters(in: .whitespacesAndNewlines), account: "anthropic")
        showKey = false
    }

    private func send(_ prompt: AIPrompt) {
        answer = ""
        error = nil
        let key = apiKey
        let model = model
        running = Task {
            do {
                for try await chunk in AIClient.stream(prompt: prompt, apiKey: key, model: model) {
                    answer += chunk
                }
            } catch is CancellationError {
            } catch {
                self.error = error.localizedDescription
            }
            running = nil
        }
    }
}
