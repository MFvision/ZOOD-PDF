import AVFoundation
@testable import PDFEditor
import WarraqCore
import XCTest

/// Lines of text as the core would report them, for tests that need no
/// file: the wrapper's `TextLine` has no public initializer, so they are
/// decoded from the same JSON the core answers.
enum TestLines {
    static func line(_ text: String, x: Float, y: Float, width: Float, height: Float, rtl: Bool) -> TextLine {
        let json: [String: Any] = ["text": text, "x": x, "y": y, "width": width, "height": height, "direction": rtl ? "rtl" : "ltr"]
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(TextLine.self, from: data)
    }
}

/// Read-aloud without a speaker: the sentences a page is cut into and the
/// lines each lands on, the language each is read in, the voices ranked,
/// and the controller's stepping through a real corpus page.
@MainActor
final class ReadAloudTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: ReadAloudTests.self).url(forResource: name, withExtension: "pdf"))
        return try Data(contentsOf: url)
    }

    func testCutsLinesIntoSentencesAndKeepsTheirBoxes() {
        let lines = [
            TestLines.line("عنوان كبير", x: 300, y: 40, width: 200, height: 24, rtl: true),
            TestLines.line("هذه الجملة الأولى تمتد على", x: 100, y: 80, width: 400, height: 12, rtl: true),
            TestLines.line("سطرين كاملين. وهذه الثانية.", x: 100, y: 96, width: 400, height: 12, rtl: true),
            TestLines.line("", x: 0, y: 0, width: 0, height: 0, rtl: true),
            TestLines.line("A third one in English!", x: 100, y: 130, width: 300, height: 12, rtl: false),
        ]
        let sentences = SentenceMap.sentences(of: lines, hint: "ar")
        XCTAssertEqual(sentences.map(\.text), ["عنوان كبير", "هذه الجملة الأولى تمتد على سطرين كاملين.", "وهذه الثانية.", "A third one in English!"])
        XCTAssertEqual(sentences.map(\.language), ["ar", "ar", "ar", "en"])
        // The heading is its own (a different size); the wrapped sentence
        // spans two lines; the second sentence sits on the second line.
        XCTAssertEqual(sentences[0].rects, [CGRect(x: 300, y: 40, width: 200, height: 24)])
        XCTAssertEqual(sentences[1].rects.map(\.minY), [80, 96])
        XCTAssertEqual(sentences[2].rects.map(\.minY), [96])
        XCTAssertEqual(sentences[3].rects.map(\.minY), [130])
    }

    func testEmptyLinesMakeNoSentences() {
        XCTAssertEqual(SentenceMap.sentences(of: []), [])
        XCTAssertEqual(SentenceMap.sentences(of: [TestLines.line("   ", x: 0, y: 0, width: 1, height: 1, rtl: false)]), [])
    }

    func testDetectsTheLanguageForTheVoice() {
        XCTAssertEqual(SpeechLanguage.detect("فاتورة ضريبية مبسطة"), "ar")
        XCTAssertEqual(SpeechLanguage.detect("Invoice no. 42 — فاتورة"), "ar", "a third Arabic is Arabic")
        XCTAssertEqual(SpeechLanguage.detect("This is a plain English sentence."), "en")
        XCTAssertEqual(SpeechLanguage.detect("12345", hint: "ar"), "ar", "digits alone follow the page")
    }

    func testPrefersPremiumThenEnhancedVoices() {
        let installed = AVSpeechSynthesisVoice.speechVoices()
        let arabic = SpeechVoices.voices(for: "ar", among: installed)
        let english = SpeechVoices.voices(for: "en", among: installed)
        print("WARRAQ_VOICES ar: \(arabic.map { "\($0.name) \($0.language) q\($0.quality.rawValue)" })")
        print("WARRAQ_VOICES en: \(english.count) — best: \(english.first.map { "\($0.name) \($0.language) q\($0.quality.rawValue)" } ?? "none")")
        XCTAssertTrue(arabic.allSatisfy { $0.language.lowercased().hasPrefix("ar") })
        // Best first: no voice ranks above the one before it.
        for pair in zip(english, english.dropFirst()) {
            XCTAssertGreaterThanOrEqual(SpeechVoices.rank(pair.0), SpeechVoices.rank(pair.1))
        }
        // A chosen voice wins when installed; a stale choice falls back to the best.
        if let second = english.dropFirst().first {
            XCTAssertEqual(SpeechVoices.voice(for: "en", chosen: second.identifier, among: installed)?.identifier, second.identifier)
        }
        XCTAssertEqual(SpeechVoices.voice(for: "en", chosen: "gone", among: installed)?.identifier, english.first?.identifier)
        XCTAssertEqual(Array(SpeechVoices.languages(among: installed).prefix(2)), ["ar", "en"])
    }

    func testStepsThroughACorpusPageAndStopsAtTheEnd() async throws {
        let model = DocumentModel(bytes: try fixture("coretext-sfarabic-mixed-invoice"), name: "invoice")
        await model.load()
        let reader = ReadAloudController()
        reader.start(model, from: 0)
        // The page's sentences are read from the core.
        // The sentences arrive from the core off the main thread; poll for them.
        for _ in 0..<200 where reader.state == .loading {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertNotEqual(reader.state, .loading)
        XCTAssertGreaterThan(reader.sentences.count, 3)
        XCTAssertEqual(reader.index, 0)
        XCTAssertEqual(reader.page, 0)
        XCTAssertEqual(reader.sentences.first?.language, "ar")
        XCTAssertTrue(reader.sentences.contains { $0.text.contains("فاتورة") })

        reader.pause()
        XCTAssertEqual(reader.state, .paused)
        reader.next()
        XCTAssertEqual(reader.index, 1)
        reader.previous()
        XCTAssertEqual(reader.index, 0)
        // Past the last sentence of the last page, reading stops.
        for _ in 0..<reader.sentences.count { reader.next() }
        XCTAssertEqual(reader.state, .idle)
        XCTAssertFalse(reader.isActive)
        model.close()
    }
}
