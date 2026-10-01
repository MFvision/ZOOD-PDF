import AVFoundation
import PDFKit
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
        XCTAssertEqual(SpeechLanguage.detect("دعم فني (Premium Support) | 1,800.00"), "ar", "a sentence that opens in Arabic")
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

    /// Waits for the reader to have its page's sentences.
    private func settle(_ reader: ReadAloudController) async throws {
        for _ in 0..<300 where reader.state == .loading {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertNotEqual(reader.state, .loading)
    }

    func testStepsThroughACorpusPageHighlightingEachSentenceAndStopsAtTheEnd() async throws {
        let model = DocumentModel(bytes: try fixture("coretext-sfarabic-mixed-invoice"), name: "invoice")
        await model.load()
        let pdf = try XCTUnwrap(model.pdf)
        let view = PDFView(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        view.document = pdf
        let reader = ReadAloudController()
        reader.attach(view)
        reader.start(model, from: 0)
        try await settle(reader)
        reader.pause()
        XCTAssertEqual(reader.state, .paused)
        XCTAssertEqual(reader.page, 0)
        XCTAssertEqual(reader.index, 0)

        // The sentences are the core's lines cut as SentenceMap cuts them:
        // the same lines, read again here, give exactly the same sentences.
        let core = try XCTUnwrap(model.engine)
        let lines = try await core.textLines(page: 0)
        let expected = SentenceMap.sentences(of: lines, hint: "ar")
        XCTAssertEqual(reader.sentences, expected)
        XCTAssertEqual(reader.sentences.first?.text, ReadAloudExpectations.invoiceFirstSentence)
        XCTAssertEqual(reader.sentences.dropFirst().first?.text, ReadAloudExpectations.invoiceSecondSentence)
        // Each line of the invoice is read on its own (headings, rows and
        // totals do not wrap), and "ر.س" stays whole.
        XCTAssertEqual(reader.sentences.map(\.text), ReadAloudExpectations.invoice)
        XCTAssertEqual(reader.sentences.map(\.language), ["ar", "ar", "ar", "ar", "ar", "ar", "ar", "ar", "ar", "ar", "ar"])

        // The sentence read is highlighted over its own lines, in PDFKit's
        // space, and nothing else is.
        func highlighted() -> [CGRect] {
            (pdf.page(at: 0)?.annotations ?? []).filter { $0.type == "Highlight" }.map(\.bounds)
        }
        let frame = PageSpace.Frame(page: try XCTUnwrap(pdf.page(at: 0)))
        func boxes(of sentence: SpokenSentence) -> [CGRect] {
            sentence.rects.map { PageSpace.userRect(fromStored: $0.insetBy(dx: -1, dy: -1), in: frame) }
        }
        XCTAssertEqual(highlighted(), boxes(of: reader.sentences[0]))
        reader.next()
        XCTAssertEqual(reader.index, 1)
        XCTAssertEqual(highlighted(), boxes(of: reader.sentences[1]))
        reader.previous()
        XCTAssertEqual(reader.index, 0)
        XCTAssertEqual(highlighted(), boxes(of: reader.sentences[0]))

        // Past the last sentence of the last page, reading stops and the
        // highlight is gone.
        for _ in 0..<reader.sentences.count { reader.next() }
        XCTAssertEqual(reader.state, .idle)
        XCTAssertFalse(reader.isActive)
        XCTAssertEqual(highlighted(), [])
        model.close()
    }

    func testGoesOnToTheNextPageAndBack() async throws {
        let model = DocumentModel(bytes: try fixture("chrome-notonaskh-justified-3pages"), name: "three")
        await model.load()
        XCTAssertEqual(model.pageCount, 3)
        let reader = ReadAloudController()
        reader.start(model, from: 0)
        try await settle(reader)
        reader.pause()
        let core = try XCTUnwrap(model.engine)
        let pageOne = SentenceMap.sentences(of: try await core.textLines(page: 0), hint: "ar")
        let pageTwo = SentenceMap.sentences(of: try await core.textLines(page: 1), hint: "ar")
        XCTAssertEqual(reader.sentences, pageOne)
        let count = reader.sentences.count
        for _ in 0..<count { reader.next() }
        for _ in 0..<100 where reader.sentences != pageTwo { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertEqual(reader.page, 1, "on to page 2")
        XCTAssertEqual(reader.index, 0)
        XCTAssertEqual(reader.sentences, pageTwo)
        XCTAssertEqual(reader.state, .paused, "a paused reading stays paused on the new page")
        reader.previous()
        for _ in 0..<100 where reader.sentences != pageOne { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertEqual(reader.page, 0, "back to page 1")
        XCTAssertEqual(reader.index, count - 1, "at its last sentence")
        reader.stop()
        model.close()
    }

    func testKeepsReadingWithTheScreenLocked() async throws {
        // The app declares background audio, and reading sets a playback
        // session for spoken audio: what iOS needs to keep the voice going
        // with the screen locked.
        let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String]
        XCTAssertEqual(modes, ["audio"])
        let model = DocumentModel(bytes: try fixture("coretext-sfarabic-mixed-invoice"), name: "invoice")
        await model.load()
        let reader = ReadAloudController()
        reader.start(model, from: 0)
        try await settle(reader)
        let session = AVAudioSession.sharedInstance()
        XCTAssertEqual(session.category, .playback)
        XCTAssertEqual(session.mode, .spokenAudio)
        reader.stop()
        model.close()
    }

    func testTheSpeedIsKept() {
        let before = SpeechVoices.rate
        defer { SpeechVoices.rate = before }
        let reader = ReadAloudController()
        reader.rate = ReadAloudBar.speeds[3].rate
        XCTAssertEqual(SpeechVoices.rate, ReadAloudBar.speeds[3].rate)
        XCTAssertEqual(ReadAloudController().rate, ReadAloudBar.speeds[3].rate)
        XCTAssertEqual(ReadAloudBar.speeds.map(\.title), ["0.75×", "1×", "1.25×", "1.5×", "2×"])
    }
}

/// The invoice's sentences as read aloud (the UI tests hold the same list).
enum ReadAloudExpectations {
    static let invoice = [
        "فاتورة ضريبية مبسطة",
        "رقم الفاتورة: INV-2026-0042",
        "التاريخ: ١٦ سبتمبر ٢٠٢٦",
        "العميل: شركة زود للتقنية",
        "الوصف | الكمية | السعر | الإجمالي",
        "اشتراك سنوي في خدمة Warraq Pro | 1 | 1,200.00 | 1,200.00",
        "دعم فني (Premium Support) | 1,800.00 | 150.00 | 12",
        "الإجمالي قبل الضريبة: 3,000.00 ر.س",
        "ضريبة القيمة المضافة (%15): 450.00 ر.س",
        "الإجمالي المستحق: 3,450.00 ر.س",
        "شكراً لتعاملكم معنا — Thank you for your business",
    ]
    static let invoiceFirstSentence = invoice[0]
    static let invoiceSecondSentence = invoice[1]
}
