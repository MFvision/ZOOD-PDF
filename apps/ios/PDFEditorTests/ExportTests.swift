@testable import PDFEditor
import WarraqCore
import XCTest

/// Exporting: the zip and Word writers, the text and pictures, and the
/// core's compressed and PDF/A copies.
@MainActor
final class ExportTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = try PartB.folder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testZipRoundTrip() {
        var zip = ZipWriter()
        zip.add("a/b.txt", text: "مرحبا")
        zip.add("c.xml", text: "<x/>")
        let archive = zip.data()
        XCTAssertTrue(archive.starts(with: [0x50, 0x4B, 0x03, 0x04]))
        XCTAssertEqual(ZipReader.entry(named: "a/b.txt", in: archive), Data("مرحبا".utf8))
        XCTAssertEqual(ZipReader.entry(named: "c.xml", in: archive), Data("<x/>".utf8))
        XCTAssertNil(ZipReader.entry(named: "missing", in: archive))
        XCTAssertEqual(ZipWriter.crc32(Data("hello".utf8)), 0x3610_A686)
    }

    func testWordExportCarriesTheArabicInReadingOrder() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let url = try await Exporter.word(model)
        XCTAssertEqual(url.pathExtension, "docx")
        let docx = try Data(contentsOf: url)
        let xml = try XCTUnwrap(ZipReader.entry(named: "word/document.xml", in: docx)).flatMap { String(data: $0, encoding: .utf8) }
        let document = try XCTUnwrap(xml)
        XCTAssertTrue(document.contains("فاتورة ضريبية مبسطة"), "the core's reading of the page, whole words in logical order")
        XCTAssertTrue(document.contains("<w:bidi/>"), "right-to-left paragraphs")
        XCTAssertTrue(document.contains("<w:rtl/>"))
        XCTAssertNotNil(ZipReader.entry(named: "[Content_Types].xml", in: docx))
        XCTAssertNotNil(ZipReader.entry(named: "word/styles.xml", in: docx))
        // The same words the core reads from the PDF.
        let text = try await XCTUnwrap(model.engine).extractText(page: 0)
        for word in ["شركة", "فاتورة"] {
            XCTAssertTrue(text.contains(word) && document.contains(word), word)
        }
        model.close()
    }

    func testParagraphXMLKeepsTheSchemaOrder() {
        let p = DocxWriter.Paragraph(text: "نص\tمع تبويب & <", rightToLeft: true, alignment: "end", fontSize: 13.4, pageBreakBefore: true)
        let xml = DocxWriter.paragraphXML(p)
        XCTAssertEqual(xml, "<w:p><w:pPr><w:pageBreakBefore/><w:bidi/><w:jc w:val=\"right\"/></w:pPr><w:r><w:rPr><w:sz w:val=\"27\"/><w:szCs w:val=\"27\"/><w:rtl/></w:rPr><w:t xml:space=\"preserve\">نص</w:t><w:tab/><w:t xml:space=\"preserve\">مع تبويب &amp; &lt;</w:t></w:r></w:p>")
        XCTAssertEqual(DocxWriter.clean("a\u{0}b\u{1F}c\td"), "abc\td")
    }

    func testTextAndPictures() async throws {
        let model = try await PartB.loadedModel("chrome-notonaskh-justified-3pages", in: folder)
        let text = try String(contentsOf: try await Exporter.text(model), encoding: .utf8)
        XCTAssertTrue(text.contains("الفصل الثالث"))
        XCTAssertTrue(text.contains("Page") || text.contains("الصفحة"), "a page heading in the interface's language: \(text.prefix(80))")
        let pictures = try Exporter.images(model)
        XCTAssertEqual(pictures.count, 3)
        XCTAssertTrue(pictures[0].lastPathComponent.hasSuffix(" 01.png"))
        let png = try Data(contentsOf: pictures[0])
        XCTAssertTrue(png.starts(with: [0x89, 0x50, 0x4E, 0x47]))
        model.close()
    }

    func testCompressedAndPDFACopiesComeFromTheCore() async throws {
        let model = try await PartB.loadedModel("chrome-notonaskh-justified-3pages", in: folder)
        let (compressed, report) = try await Exporter.compressed(model, imageDPI: 100, jpegQuality: 70)
        XCTAssertEqual(report.before, model.bytes.count)
        XCTAssertLessThanOrEqual(report.after, report.before)
        let opened = try await Core.open(bytes: Data(contentsOf: compressed))
        let count = await opened.pageCount
        XCTAssertEqual(count, 3)

        let (pdfa, pdfaReport) = try await Exporter.pdfA(model)
        XCTAssertEqual(pdfaReport.level, "2b")
        XCTAssertNil(pdfaReport.refused)
        let bytes = try Data(contentsOf: pdfa)
        XCTAssertNotNil(bytes.range(of: Data("pdfaid:part".utf8)), "PDF/A identification in the XMP")
        struct Args: Encodable { let password: String?; let level: String }
        let validated = try await Core.callStatic(op: "standards.pdfa_validate", args: Args(password: nil, level: "2b"), blobs: [bytes])
        let findings = try XCTUnwrap(validated.object["findings"] as? [String: Any])
        XCTAssertEqual(findings["passed"] as? Bool, true, "\(findings)")
        XCTAssertEqual(pdfaReport.findings?.passed, true)
        model.close()
    }
}
