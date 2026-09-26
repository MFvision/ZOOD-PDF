import AppIntents
import Foundation
import UniformTypeIdentifiers
import ZoodCore
import ZoodEngine

// Siri / Shortcuts actions for the on-device assistant and read-aloud. Both run on the device.

struct SummarizePDFIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.summarize.title"
    static let description = IntentDescription("intent.summarize.description")

    @Parameter(title: "intent.summarize.file", supportedContentTypes: [.pdf])
    var file: IntentFile

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let data = file.data
        if (try? WarraqEngine.isEncrypted(data))?.needsPassword == true {
            throw ZoodIntentError.protected(file.filename)
        }
        let engine: WarraqEngine
        do {
            engine = try WarraqEngine(data: data)
        } catch {
            throw ZoodIntentError.engine(error.message)
        }
        guard let pages = await engine.pageTexts(),
              pages.contains(where: { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw ZoodIntentError.noText
        }
        let ui = ContentLanguage(identifier: Locale.current.identifier) ?? .english
        let docLanguage = TextScript.dominantLanguage(String(pages.map(\.text).joined(separator: " ").prefix(4_000))) ?? ui
        let ai = LocalAI.shared
        let choice = ai.choice(for: [ui, docLanguage])
        guard choice == .apple || choice == .portable else { throw ZoodIntentError.noModel }
        let prompt = LocalPromptBuilder.build(
            task: .summarize, scope: .document, pages: pages, uiLanguage: ui, budget: ai.budget(for: choice))
        var answer = ""
        for try await piece in ai.stream(prompt, using: choice) { answer += piece }
        let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        return .result(value: text, dialog: "\(text)")
    }
}

struct ReadAloudIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.readAloud.title"
    static let description = IntentDescription("intent.readAloud.description")
    static let openAppWhenRun = true

    @Parameter(title: "entity.recent.type")
    var document: RecentDocumentEntity

    init() {}

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(DeepLink.readAloud(id: document.id).url))
    }
}
