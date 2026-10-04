import FoundationModels
@testable import PDFEditor
import WarraqCore
import XCTest

/// The on-device AI: what the Foundation Models framework says about this
/// simulator (recorded in the log and in docs/STATUS.md), the context the
/// model is handed, the Library-index retrieval over a real file, and the
/// assistant through the fake engine.
@MainActor
final class AITests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: AITests.self).url(forResource: name, withExtension: "pdf"))
        return try Data(contentsOf: url)
    }

    /// Not an assertion on availability — that is the device's — but what
    /// the framework says is printed so it can be recorded, and when it says
    /// the model is there, the real engine is asked for an answer and for a
    /// guided (`@Generable`) form assignment. Either it answers, or its
    /// failure reaches the app as one of the app's own errors.
    func testRecordsFoundationModelsAvailabilityOnThisSimulator() async throws {
        let availability = AIEngines.availability()
        var detail = "\(availability)"
        if #available(iOS 26, *) {
            detail += " — framework says \(SystemLanguageModel.default.availability)"
            detail += "; supportsLocale(ar): \(SystemLanguageModel.default.supportsLocale(Locale(identifier: "ar")))"
            detail += "; supportsLocale(en): \(SystemLanguageModel.default.supportsLocale(Locale(identifier: "en")))"
        }
        print("WARRAQ_AI_AVAILABILITY: \(detail)")
        XCTAssertFalse(AIEngines.fakeRequested, "the unit tests run without the fake flag")
        guard availability.isAvailable, #available(iOS 26, *) else { return }
        let engine = FoundationModelsEngine()
        let started = Date()
        do {
            let answer = try await engine.reply(instructions: "Answer in one word.", prompt: "What colour is the sky on a clear day?")
            print("WARRAQ_AI_ANSWER (\(Date().timeIntervalSince(started))s): \(answer)")
            XCTAssertFalse(answer.isEmpty)
        } catch let error as AIEngineError {
            print("WARRAQ_AI_ANSWER failed after \(Date().timeIntervalSince(started))s: \(error) — \(error.localizedDescription)")
        }
        // The permissive guardrails Apple offers for transforming a
        // person's own text: whether they get past the simulator's check.
        do {
            let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
            let session = LanguageModelSession(model: model, instructions: "Answer in one word.")
            let answer = try await session.respond(to: "What colour is the sky on a clear day?")
            print("WARRAQ_AI_PERMISSIVE: \(answer.content)")
        } catch {
            print("WARRAQ_AI_PERMISSIVE failed: \(FoundationModelsEngine.translate(error))")
        }
        do {
            let fields = [FieldDescription(name: "email", label: "Email:", current: "", page: 1),
                          FieldDescription(name: "city", label: "City:", current: "", page: 1)]
            let assigned = try await engine.assign(fields: fields, profileKeys: [.email, .phone], documentText: "Email: ____ City: ____")
            print("WARRAQ_AI_ASSIGN: \(assigned)")
            for item in assigned {
                XCTAssertTrue(["email", "city"].contains(item.field))
            }
        } catch let error as AIEngineError {
            print("WARRAQ_AI_ASSIGN failed: \(error) — \(error.localizedDescription)")
        }
    }

    /// The framework's own errors become the app's, in words a person can
    /// act on; the simulator's safety-check failure among them.
    func testTheFrameworksErrorsBecomeTheApps() throws {
        guard #available(iOS 26, *) else { throw XCTSkip("no Foundation Models before iOS 26") }
        let simulator = NSError(domain: "com.apple.SensitiveContentAnalysisML", code: 15)
        XCTAssertEqual(FoundationModelsEngine.translate(simulator), .safetyCheckUnavailable)
        XCTAssertEqual(AIEngineError.safetyCheckUnavailable.errorDescription,
                       "The on-device model did not answer: its safety check cannot run on this device.")
        let other = NSError(domain: "elsewhere", code: 1, userInfo: [NSLocalizedDescriptionKey: "Something else."])
        XCTAssertEqual(FoundationModelsEngine.translate(other), .failed("Something else."))
    }

    func testLeadingContextStopsAtTheBudget() {
        let short = AIContextBuilder.leading(pageTexts: [(0, " مرحبا\n"), (1, ""), (2, "hello")])
        XCTAssertEqual(short.text, "[page 1]\nمرحبا\n\n[page 3]\nhello", "each page marked, an empty page skipped")
        XCTAssertEqual(short.pages, [0, 2])
        XCTAssertFalse(short.truncated)
        XCTAssertFalse(short.retrieved)

        // A page longer than the budget: its first 6,000 characters, cut
        // there, and the rest of the document left out.
        let long = String(repeating: "كلمة ", count: 2000)
        let cut = AIContextBuilder.leading(pageTexts: [(0, long), (1, long)])
        let expected = String(("[page 1]\n" + long.trimmingCharacters(in: .whitespaces)).prefix(AIContextBuilder.budget))
        XCTAssertEqual(cut.text, expected.trimmingCharacters(in: .whitespacesAndNewlines))
        XCTAssertTrue(cut.truncated)
        XCTAssertEqual(cut.pages, [0])
    }

    func testRetrievesPassagesThroughTheLibraryIndex() async throws {
        let bytes = try fixture("coretext-sfarabic-mixed-invoice")
        let context = try await AIContextBuilder.retrieved(query: "زود", bytes: bytes, name: "invoice")
        // Exactly the page's lines that hold the word, marked with their page.
        let model = DocumentModel(bytes: bytes, name: "invoice")
        await model.load()
        let core = try XCTUnwrap(model.engine)
        let lines = try await core.textLines(page: 0).map { $0.text.trimmingCharacters(in: .whitespaces) }.filter { $0.contains("زود") }
        XCTAssertFalse(lines.isEmpty)
        XCTAssertEqual(context.text, lines.map { "[page 1] \($0)" }.joined(separator: "\n"))
        XCTAssertTrue(context.retrieved)
        XCTAssertEqual(context.pages, [0])
        XCTAssertFalse(context.truncated)
        model.close()
    }

    func testTheAssistantAnswersThroughTheFakeEngine() async throws {
        let model = DocumentModel(bytes: try fixture("coretext-sfarabic-mixed-invoice"), name: "invoice")
        await model.load()
        XCTAssertEqual(model.state, .ready)
        let engine = RecordingEngine()
        let assistant = AIAssistant(model: model, engine: engine)
        XCTAssertEqual(assistant.availability, .available)
        assistant.task = .summarize
        await assistant.run()
        // The model was handed the core's text of the page, whole, in
        // logical order, then the task's request — exactly.
        let rawText = await model.text(ofPage: 0)
        let pageText = try XCTUnwrap(rawText).trimmingCharacters(in: .whitespacesAndNewlines)
        let prompts = await engine.prompts
        XCTAssertEqual(prompts, ["<document>\n[page 1]\n\(pageText)\n</document>\n\n\(AITask.summarize.request(question: ""))"])
        XCTAssertEqual(assistant.state, .answered("answer 1"))
        XCTAssertEqual(assistant.context?.pages, [0])
        XCTAssertEqual(assistant.context?.truncated, false)
        XCTAssertEqual(assistant.context?.retrieved, false)

        // The fake engine of Debug runs answers from the same prompt.
        let fake = AIAssistant(model: model, engine: FakeEngine())
        await fake.run()
        let firstLine = try XCTUnwrap(pageText.split(separator: "\n").first)
        XCTAssertEqual(fake.state, .answered(String("[fake] <document> [page 1] \(firstLine)".prefix(247))))

        assistant.task = .ask
        assistant.question = ""
        await assistant.run()
        XCTAssertEqual(assistant.state, .failed(String(localized: "Type a question first.")))
        let asked = await engine.prompts.count
        XCTAssertEqual(asked, 1, "nothing was sent to the model without a question")
        model.close()
    }

    func testWithoutAnEngineTheAssistantSaysSo() async throws {
        let model = DocumentModel(bytes: try fixture("coretext-sfarabic-mixed-invoice"), name: "invoice")
        await model.load()
        let assistant = AIAssistant(model: model, engine: nil, availability: nil)
        if !assistant.availability.isAvailable {
            XCTAssertNil(assistant.engine)
            await assistant.run()
            XCTAssertEqual(assistant.state, .failed(String(localized: "On-device AI is not available.")))
        }
        model.close()
    }
}

/// An engine that keeps every prompt it is handed and answers "answer N".
actor RecordingEngine: AIEngine {
    nonisolated var name: String { "Recording" }
    private(set) var prompts: [String] = []
    private(set) var assignments: [[FieldDescription]] = []
    var answer: [FieldAssignment] = []

    func reply(instructions: String, prompt: String) async throws -> String {
        prompts.append(prompt)
        return "answer \(prompts.count)"
    }

    func assign(fields: [FieldDescription], profileKeys: [ProfileKey], documentText: String) async throws -> [FieldAssignment] {
        assignments.append(fields)
        return answer
    }

    func set(answer: [FieldAssignment]) {
        self.answer = answer
    }
}
