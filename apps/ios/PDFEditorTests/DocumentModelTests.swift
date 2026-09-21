@testable import PDFEditor
import XCTest

/// The document model: bytes on disk untouched until Save, edits through
/// the core, undo and redo.
@MainActor
final class DocumentModelTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "DocumentModelTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func copyFixture(_ name: String) throws -> URL {
        let source = try XCTUnwrap(Bundle(for: DocumentModelTests.self).url(forResource: name, withExtension: "pdf"))
        let destination = folder.appending(path: "\(name).pdf")
        try FileManager.default.copyItem(at: source, to: destination)
        return destination
    }

    func testOpensAFileAndReadsItsArabic() async throws {
        let url = try copyFixture("coretext-sfarabic-mixed-invoice")
        let model = try DocumentModel(url: url)
        XCTAssertEqual(model.name, "coretext-sfarabic-mixed-invoice")
        await model.load()
        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(model.pageCount, 1)
        XCTAssertTrue(model.isRightToLeft)
        XCTAssertNotNil(model.pdf, "PDFKit draws it")
        let read = await model.text(ofPage: 0)
        let text = try XCTUnwrap(read)
        XCTAssertTrue(text.contains("فاتورة ضريبية مبسطة"), text)
        let hits = try await model.search("الفاتوره")
        XCTAssertEqual(hits, [0])
        model.close()
    }

    func testEditsKeepTheFileUntouchedUntilSave() async throws {
        let url = try copyFixture("coretext-sfarabic-mixed-invoice")
        let before = try Data(contentsOf: url)
        let model = try DocumentModel(url: url)
        await model.load()
        XCTAssertFalse(model.isEdited)

        struct Rotate: Encodable { let pages: [Int]; let quarterTurns: Int }
        let undo = UndoManager()
        try await model.apply("pages.rotate", args: Rotate(pages: [0], quarterTurns: 1), undoManager: undo)
        XCTAssertTrue(model.isEdited)
        XCTAssertTrue(model.bytes.starts(with: before), "an incremental update on the original")
        XCTAssertEqual(try Data(contentsOf: url), before, "nothing written yet")
        let page = try XCTUnwrap(model.pdf?.page(at: 0))
        XCTAssertEqual(page.rotation % 360, 90)

        XCTAssertTrue(undo.canUndo)
        undo.undo()
        XCTAssertFalse(model.isEdited)
        XCTAssertEqual(model.pdf?.page(at: 0)?.rotation ?? -1, 0)
        XCTAssertTrue(undo.canRedo)
        undo.redo()
        XCTAssertTrue(model.isEdited)
        XCTAssertEqual(model.pdf?.page(at: 0)?.rotation ?? -1, 90)

        try await model.save()
        XCTAssertFalse(model.isEdited)
        let after = try Data(contentsOf: url)
        XCTAssertTrue(after.starts(with: before))
        XCTAssertGreaterThan(after.count, before.count)
        model.close()
    }

    func testAProtectedFileAsksForItsPassword() async throws {
        let url = try copyFixture("variant-encrypted-rc4-40")
        let model = try DocumentModel(url: url)
        await model.load()
        XCTAssertEqual(model.state, .needsPassword(wrong: false))
        await model.load(password: "nope")
        XCTAssertEqual(model.state, .needsPassword(wrong: true))
        await model.load(password: "warraq")
        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(model.metadata?.encrypted, true)
        XCTAssertNotNil(model.pdf)
        XCTAssertEqual(model.pdf?.isLocked, false, "PDFKit unlocked with the same password")
        model.close()
    }

    func testWhatIsNotAPDFFails() async throws {
        let model = DocumentModel(bytes: Data("hello".utf8), name: "hello")
        await model.load()
        guard case let .failed(code, _) = model.state else { return XCTFail("\(model.state)") }
        XCTAssertEqual(code, "E_PARSE")
    }
}
