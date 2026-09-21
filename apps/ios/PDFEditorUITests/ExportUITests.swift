import XCTest

/// Exporting, through the interface: Word, text, a compressed copy and
/// PDF/A — each file read back where the app copied it, the Arabic
/// checked in the Word file's XML.
@MainActor
final class ExportUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// The share row of the file just made, by its identifier or its name.
    private func ready(_ ext: String, in ui: PartBApp) -> XCUIElement {
        ui.app.buttons.matching(NSPredicate(format: "identifier == %@ OR label ENDSWITH %@", "export.share.\(ext)", ".\(ext)")).firstMatch
    }

    func testWordTextCompressedAndPDFA() throws {
        let outDir = FileManager.default.temporaryDirectory.appending(path: "export-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        let ui = try PartBApp.launch(fixture: PartBApp.invoice, arguments: ["-warraqExportDir", outDir.path])
        ui.waitForPage(containing: "فاتورة")
        ui.more("document.export", label: "Export…")

        ui.app.buttons["export.word"].tap()
        XCTAssertTrue(ready("docx", in: ui).waitForExistence(timeout: 30), "the Word file is ready: \(ui.tree)")
        let docx = try Data(contentsOf: outDir.appending(path: "\(PartBApp.invoice).docx"))
        XCTAssertTrue(docx.starts(with: [0x50, 0x4B, 0x03, 0x04]), "a zip")
        // Stored entries: the XML is readable as it is, and holds the Arabic.
        XCTAssertNotNil(docx.range(of: Data("فاتورة ضريبية مبسطة".utf8)), "the Arabic round-trips into Word")
        XCTAssertNotNil(docx.range(of: Data("<w:bidi/>".utf8)))

        ui.app.buttons["export.text"].tap()
        XCTAssertTrue(ready("txt", in: ui).waitForExistence(timeout: 30))
        let text = try String(contentsOf: outDir.appending(path: "\(PartBApp.invoice).txt"), encoding: .utf8)
        XCTAssertTrue(text.contains("فاتورة ضريبية مبسطة"))

        ui.app.buttons["export.compressed"].tap()
        let choice = ui.app.buttons["Pictures at 150 dpi"]
        XCTAssertTrue(choice.waitForExistence(timeout: 10))
        choice.tap()
        XCTAssertTrue(ready("pdf", in: ui).waitForExistence(timeout: 60), "the compressed copy is ready")
        XCTAssertTrue(ui.app.staticTexts["export.note"].waitForExistence(timeout: 5))

        ui.app.buttons["export.pdfa"].tap()
        let note = ui.app.staticTexts["export.note"]
        let predicate = NSPredicate(format: "label CONTAINS %@", "PDF/A")
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: note)], timeout: 90), .completed, note.label)
        let pdfa = try Data(contentsOf: outDir.appending(path: "\(PartBApp.invoice) – PDFA.pdf"))
        XCTAssertNotNil(pdfa.range(of: Data("pdfaid:part".utf8)))

        ui.app.buttons["export.images"].tap()
        XCTAssertTrue(ready("png", in: ui).waitForExistence(timeout: 30))
        ui.app.buttons["sheet.done"].tap()
        try? FileManager.default.removeItem(at: outDir)
    }
}
