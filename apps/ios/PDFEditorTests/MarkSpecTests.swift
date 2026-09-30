@testable import PDFEditor
import WarraqCore
import XCTest

/// Page marks: what the sheet's controls turn into, and every kind written
/// onto a real Arabic document by the core and read back off it again.
@MainActor
final class MarkSpecTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = try PartB.folder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: - What the controls say

    func testPagesAreReadInEitherScript() {
        XCTAssertEqual(MarkSpec.pages("", count: 9), [], "empty is every page")
        XCTAssertEqual(MarkSpec.pages("1-3, 5", count: 9), [0, 1, 2, 4])
        XCTAssertEqual(MarkSpec.pages("٢", count: 9), [1], "Arabic-Indic digits")
        XCTAssertEqual(MarkSpec.pages("١-٣، ٥", count: 9), [0, 1, 2, 4], "and the Arabic comma")
        XCTAssertEqual(MarkSpec.pages("8-", count: 9), [7, 8], "open at the end")
        XCTAssertNil(MarkSpec.pages("0", count: 9), "there is no page zero")
        XCTAssertNil(MarkSpec.pages("1-99", count: 9), "past the last page")
        XCTAssertNil(MarkSpec.pages("5-2", count: 9), "backwards")
        XCTAssertNil(MarkSpec.pages("last", count: 9))
    }

    func testNumbersAreWrittenInTheDigitsChosen() {
        XCTAssertEqual(MarkSpec.inDigits(1203, .western), "1203")
        XCTAssertEqual(MarkSpec.inDigits(1203, .arabic), "١٢٠٣")
    }

    func testABatesNumberIsPaddedBetweenItsPrefixAndSuffix() {
        var form = MarkSpec.Form()
        form.kind = .bates
        form.batesPrefix = "ZOOD-"
        form.batesSuffix = "-A"
        form.batesStart = 42
        form.batesDigits = 6
        XCTAssertEqual(MarkSpec.batesSample(form), "ZOOD-000042-A")
    }

    func testPagesAreLabelledAsRuns() {
        XCTAssertEqual(MarkSpec.pagesLabel([0, 1, 2, 4]), "1–3, 5")
        XCTAssertEqual(MarkSpec.pagesLabel([3]), "4")
        XCTAssertEqual(MarkSpec.pagesLabel([]), "")
    }

    func testAColourThatIsNotOneIsBlack() {
        XCTAssertEqual(MarkSpec.hex("#C0392B"), "#c0392b")
        XCTAssertEqual(MarkSpec.hex("red"), "#000000")
        XCTAssertEqual(MarkSpec.hex("#12345"), "#000000")
    }

    func testTheSpecIsWhatTheCoreReads() throws {
        var form = MarkSpec.Form()
        form.kind = .watermark
        form.watermarkText = "سري"
        form.opacity = 30
        let spec = MarkSpec.spec(of: form, fileName: "فاتورة", now: Date(timeIntervalSince1970: 0), locale: .init(identifier: "ar"))
        XCTAssertEqual(spec["kind"], .string("watermark"))
        XCTAssertEqual(spec["text"], .string("سري"))
        XCTAssertEqual(spec["opacity"], .number(0.3))
        XCTAssertEqual(spec["front"], .bool(true))

        form.kind = .header
        form.slots = ["{file}", "", "صفحة {page} من {pages}"]
        form.calendar = .hijri
        form.numerals = .arabic
        let band = MarkSpec.spec(of: form, fileName: "فاتورة", now: Date(timeIntervalSince1970: 0), locale: .init(identifier: "ar"))
        XCTAssertEqual(band["kind"], .string("header"))
        XCTAssertEqual(band["slots"], .array([.string("{file}"), .string(""), .string("صفحة {page} من {pages}")]))
        XCTAssertEqual(band["fileName"], .string("فاتورة"))
        if case let .string(date)? = band["date"] {
            XCTAssertFalse(date.isEmpty, "a Hijri date in Arabic-Indic digits")
            XCTAssertTrue(date.contains(where: { ("٠"..."٩").contains(String($0)) }), date)
        } else {
            XCTFail("the date is written by the interface")
        }
    }

    func testAPdfDateIsTheFormatAPdfWants() {
        XCTAssertEqual(MarkSpec.pdfDate(Date(timeIntervalSince1970: 0)), "D:19700101000000Z")
    }

    // MARK: - Through the core, onto a real document

    /// Writes `form` onto the document and hands back the pages' text as the
    /// core reads it afterwards, so a mark can be checked for and the page's
    /// own text checked to be untouched.
    private func add(_ form: MarkSpec.Form, to model: DocumentModel, pages: [Int] = []) async throws {
        struct Args: Encodable {
            let password: String?
            let mark: [String: JSONValue]
            let pages: [Int]
            let replace = false
            let fontBlob = 1
        }
        let font = try XCTUnwrap(form.font.bytes)
        let args = Args(password: model.password,
                        mark: MarkSpec.spec(of: form, fileName: model.name, now: Date(), locale: .init(identifier: "ar")),
                        pages: pages)
        let reply = try await Core.callStatic(op: "marks.add", args: args, blobs: [model.bytes, font])
        let bytes = try XCTUnwrap(reply.blobs.first)
        try await model.replace(bytes: bytes, undoManager: nil)
    }

    private func listed(_ model: DocumentModel) async throws -> [PageMarkInfo] {
        struct Args: Encodable { let password: String? }
        struct Answer: Decodable { let marks: [PageMarkInfo] }
        let reply = try await Core.callStatic(op: "marks.list", args: Args(password: model.password), blobs: [model.bytes])
        return try reply.decode(Answer.self).marks
    }

    func testAnArabicHeaderAndPageNumbersAreWrittenListedAndTakenOffAgain() async throws {
        let model = try await PartB.loadedModel("chrome-notonaskh-justified-3pages", in: folder)
        let original = model.bytes
        let textBefore = try XCTUnwrap(await model.text(ofPage: 0))

        var header = MarkSpec.Form()
        header.kind = .header
        header.slots = ["شركة زود", "", "{file}"]
        header.numerals = .arabic
        try await add(header, to: model)

        var numbers = MarkSpec.Form()
        numbers.kind = .pageNumber
        numbers.numberFormat = .pageOfArabic
        numbers.numerals = .arabic
        numbers.numberPosition = .bottom
        try await add(numbers, to: model)

        XCTAssertTrue(model.bytes.starts(with: original), "marks are an incremental update")

        let marks = try await listed(model)
        XCTAssertEqual(marks.count, 2, "both are listed")
        XCTAssertEqual(Set(marks.map(\.kind)), ["header", "pageNumber"])

        // The core keeps its own marks out of the page's text.
        let textAfter = try XCTUnwrap(await model.text(ofPage: 0))
        XCTAssertEqual(textAfter, textBefore, "a page mark is not part of the page's words")

        // What the marks say is on the page all the same: `marks.text` reads
        // the mark and the page apart.
        struct TextArgs: Encodable { let password: String?; let page: Int }
        let reply = try await Core.callStatic(op: "marks.text", args: TextArgs(password: nil, page: 0), blobs: [model.bytes])
        let drawn = reply.json
        XCTAssertTrue(drawn.contains("شركة زود"), drawn.prefix(400).description)
        XCTAssertTrue(drawn.contains("صفحة"), "the page number reads in Arabic")

        // And off again, leaving the page as it was.
        struct Remove: Encodable { let password: String?; let ids: [Int] }
        let off = try await Core.callStatic(op: "marks.remove", args: Remove(password: nil, ids: marks.map(\.id)), blobs: [model.bytes])
        try await model.replace(bytes: try XCTUnwrap(off.blobs.first), undoManager: nil)
        XCTAssertTrue(try await listed(model).isEmpty, "nothing is left")
    }

    func testAWatermarkAndBatesNumbersAreWrittenOnTheChosenPagesOnly() async throws {
        let model = try await PartB.loadedModel("chrome-notonaskh-justified-3pages", in: folder)

        var watermark = MarkSpec.Form()
        watermark.kind = .watermark
        watermark.watermarkText = "مسودة"
        watermark.watermarkPosition = .center
        watermark.rotation = 30
        try await add(watermark, to: model, pages: [0])

        var bates = MarkSpec.Form()
        bates.kind = .bates
        bates.batesPrefix = "ZOOD-"
        bates.batesStart = 1
        bates.batesDigits = 4
        try await add(bates, to: model)

        let marks = try await listed(model)
        let drawnWatermark = try XCTUnwrap(marks.first { $0.kind == "watermark" })
        XCTAssertEqual(drawnWatermark.pages, [0], "only the page that was asked for")
        XCTAssertEqual(drawnWatermark.text, "مسودة")

        struct TextArgs: Encodable { let password: String?; let page: Int }
        let second = try await Core.callStatic(op: "marks.text", args: TextArgs(password: nil, page: 1), blobs: [model.bytes])
        XCTAssertFalse(second.json.contains("مسودة"), "the second page has no watermark")
        XCTAssertTrue(second.json.contains("ZOOD-0002"), "but it does have its Bates number: \(second.json.prefix(300))")
    }

    func testThePreviewIsTheCoresOwnDrawingOfThePage() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        var form = MarkSpec.Form()
        form.kind = .watermark
        form.watermarkText = "سري"
        struct Args: Encodable {
            let password: String?
            let mark: [String: JSONValue]
            let page: Int
            let scale: Float
            let fontBlob = 1
        }
        let font = try XCTUnwrap(form.font.bytes)
        let args = Args(password: nil,
                        mark: MarkSpec.spec(of: form, fileName: model.name, now: Date(), locale: .init(identifier: "ar")),
                        page: 0, scale: 0.5)
        let reply = try await Core.callStatic(op: "marks.preview", args: args, blobs: [model.bytes, font])
        struct Size: Decodable { let width: Int; let height: Int }
        let size: Size = try reply.decode()
        let rgba = try XCTUnwrap(reply.blobs.first)
        XCTAssertEqual(rgba.count, size.width * size.height * 4)
        XCTAssertNotNil(UIImage.from(rgba: rgba, width: size.width, height: size.height))
        XCTAssertFalse(model.isEdited, "a preview changes nothing")
    }
}
