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

    /// Not an assertion on availability — that is the device's — but the
    /// answer is printed so it can be recorded, and when the model is
    /// there it is asked one thing to prove the real engine answers.
    func testRecordsFoundationModelsAvailabilityOnThisSimulator() async throws {
        let availability = AIEngines.availability()
        var detail = "\(availability)"
        if #available(iOS 26, *) {
            detail += " — framework says \(SystemLanguageModel.default.availability)"
            detail += "; supportsLocale(ar): \(SystemLanguageModel.default.supportsLocale(Locale(identifier: "ar")))"
        }
        print("WARRAQ_AI_AVAILABILITY: \(detail)")
        // A place the report can read it from, beside the test log.
        let note = URL(filePath: NSTemporaryDirectory()).appending(path: "warraq-ai-availability.txt")
        try? detail.write(to: note, atomically: true, encoding: .utf8)
        XCTAssertFalse(AIEngines.fakeRequested, "the unit tests run without the fake flag")
        if availability.isAvailable, #available(iOS 26, *) {
            let engine = FoundationModelsEngine()
            let answer = try await engine.reply(instructions: "Answer in one word.", prompt: "What colour is the sky on a clear day?")
            print("WARRAQ_AI_ANSWER: \(answer)")
            XCTAssertFalse(answer.isEmpty)
        }
    }

    func testLeadingContextStopsAtTheBudget() {
        let short = AIContextBuilder.leading(pageTexts: [(0, "مرحبا"), (1, ""), (2, "hello")])
        XCTAssertEqual(short.pages, [0, 2], "an empty page is skipped")
        XCTAssertFalse(short.truncated)
        XCTAssertTrue(short.text.hasPrefix("[page 1]\nمرحبا"))
        XCTAssertTrue(short.text.contains("[page 3]\nhello"))

        let long = String(repeating: "كلمة ", count: 2000)
        let cut = AIContextBuilder.leading(pageTexts: [(0, long), (1, long)])
        XCTAssertTrue(cut.truncated)
        XCTAssertEqual(cut.pages, [0])
        XCTAssertLessThanOrEqual(cut.text.count, AIContextBuilder.budget)
    }

    func testRetrievesPassagesThroughTheLibraryIndex() async throws {
        let bytes = try fixture("coretext-sfarabic-mixed-invoice")
        let context = try await AIContextBuilder.retrieved(query: "زود", bytes: bytes, name: "invoice")
        XCTAssertTrue(context.retrieved)
        XCTAssertEqual(context.pages, [0])
        XCTAssertTrue(context.text.contains("زود"), context.text)
        XCTAssertTrue(context.text.hasPrefix("[page 1]"))
    }

    func testTheAssistantAnswersThroughTheFakeEngine() async throws {
        let model = DocumentModel(bytes: try fixture("coretext-sfarabic-mixed-invoice"), name: "invoice")
        await model.load()
        XCTAssertEqual(model.state, .ready)
        let assistant = AIAssistant(model: model, engine: FakeEngine())
        XCTAssertEqual(assistant.availability, .available)
        assistant.task = .summarize
        await assistant.run()
        guard case let .answered(answer) = assistant.state else { return XCTFail("\(assistant.state)") }
        XCTAssertTrue(answer.hasPrefix("[fake]"), answer)
        XCTAssertTrue(answer.contains("فاتورة"), "the document's Arabic went in: \(answer)")
        XCTAssertEqual(assistant.context?.pages, [0])
        XCTAssertEqual(assistant.context?.truncated, false)

        assistant.task = .ask
        assistant.question = ""
        await assistant.run()
        guard case .failed = assistant.state else { return XCTFail("a question is needed") }
        model.close()
    }

    func testWithoutAnEngineTheAssistantSaysSo() async throws {
        let model = DocumentModel(bytes: try fixture("coretext-sfarabic-mixed-invoice"), name: "invoice")
        await model.load()
        let assistant = AIAssistant(model: model, engine: nil, availability: nil)
        if !assistant.availability.isAvailable {
            XCTAssertNil(assistant.engine)
            await assistant.run()
            guard case .failed = assistant.state else { return XCTFail("\(assistant.state)") }
        }
        model.close()
    }
}
