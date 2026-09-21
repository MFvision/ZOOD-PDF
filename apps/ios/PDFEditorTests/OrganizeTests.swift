@testable import PDFEditor
import PDFKit
import WarraqCore
import XCTest

/// Organizing: the reorder arithmetic, and every operation through the
/// core on a three-page Arabic document — the order checked by reading
/// the pages back through the core.
@MainActor
final class OrganizeTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = try PartB.folder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testReorderArithmetic() {
        XCTAssertEqual(PagesModel.order(moving: [2], before: 0, count: 3), [2, 0, 1])
        XCTAssertEqual(PagesModel.order(moving: [0], before: 3, count: 3), [1, 2, 0])
        XCTAssertEqual(PagesModel.order(moving: [0], before: 2, count: 3), [1, 0, 2])
        XCTAssertEqual(PagesModel.order(moving: [0, 1], before: 3, count: 4), [2, 3, 0, 1])
        XCTAssertEqual(PagesModel.order(moving: [1], before: 1, count: 3), [0, 1, 2], "dropped where it was")
        XCTAssertEqual(PagesModel.order(moving: [5], before: 0, count: 3), [0, 1, 2], "an index past the end is ignored")
    }

    private func heading(of model: DocumentModel, page: Int) async -> String {
        (await model.text(ofPage: page))?.split(separator: "\n").first.map(String.init) ?? ""
    }

    private func settle(_ pages: PagesModel) async throws {
        let deadline = Date(timeIntervalSinceNow: 30)
        while pages.working {
            if Date() > deadline { throw XCTSkip("timed out") }
            try await Task.sleep(for: .milliseconds(30))
        }
        XCTAssertNil(pages.error, pages.error ?? "")
    }

    func testMoveRotateDeleteInsertCropThroughTheCore() async throws {
        let model = try await PartB.loadedModel("chrome-notonaskh-justified-3pages", in: folder)
        let original = model.bytes
        let undo = UndoManager()
        let pages = PagesModel(model: model)
        pages.undoManager = undo
        XCTAssertEqual(pages.pageCount, 3)
        let third = await heading(of: model, page: 2)
        XCTAssertTrue(third.contains("الفصل الثالث"), third)

        // Move the last page first.
        pages.move([2], before: 0)
        try await settle(pages)
        let first = await heading(of: model, page: 0)
        XCTAssertTrue(first.contains("الفصل الثالث"), "the core reads the moved page first: \(first)")
        XCTAssertTrue(model.bytes.starts(with: original), "an incremental update")

        // Saved and reopened, the order holds.
        try await model.save()
        let reopened = try DocumentModel(url: try XCTUnwrap(model.url))
        await reopened.load()
        let reopenedFirst = await heading(of: reopened, page: 0)
        XCTAssertTrue(reopenedFirst.contains("الفصل الثالث"), reopenedFirst)
        reopened.close()

        // Rotate the first page.
        pages.rotate([0], quarterTurns: 1)
        try await settle(pages)
        XCTAssertEqual(model.pdf?.page(at: 0)?.rotation, 90)
        undo.undo()
        XCTAssertEqual(model.pdf?.page(at: 0)?.rotation, 0)

        // A blank page after the first, the size of the first.
        pages.insertBlank(after: 0)
        try await settle(pages)
        XCTAssertEqual(pages.pageCount, 4)
        let blank = await model.text(ofPage: 1) ?? ""
        XCTAssertTrue(blank.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

        // Delete it again.
        pages.selection = [1]
        pages.delete(pages.selected)
        try await settle(pages)
        XCTAssertEqual(pages.pageCount, 3)
        XCTAssertTrue(pages.selection.isEmpty)

        // Crop the first page by 50 points each side.
        let before = try await XCTUnwrap(model.engine).pageSize(0)
        pages.crop([0], margins: PagesModel.Margins(top: 50, right: 50, bottom: 50, left: 50))
        try await settle(pages)
        let after = try await XCTUnwrap(model.engine).pageSize(0)
        XCTAssertEqual(after.width, before.width - 100, accuracy: 0.5)
        XCTAssertEqual(after.height, before.height - 100, accuracy: 0.5)

        // Never every page.
        pages.delete([0, 1, 2])
        XCTAssertNotNil(pages.error)
        pages.error = nil
        XCTAssertEqual(pages.pageCount, 3)
        model.close()
    }

    func testInsertFromAnotherPDFAndFromPictures() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let pages = PagesModel(model: model)
        pages.insert(pdf: try PartB.fixture("chrome-notonaskh-justified-3pages"), at: 1)
        try await settle(pages)
        XCTAssertEqual(pages.pageCount, 4)
        let second = await model.text(ofPage: 1) ?? ""
        XCTAssertTrue(second.contains("الفصل الأول"), second)

        let png = try XCTUnwrap(PartB.picture(width: 300, height: 400, color: .blue).pngData())
        pages.insert(pictures: [png, png], at: 0)
        try await settle(pages)
        XCTAssertEqual(pages.pageCount, 6)
        struct Args: Encodable { let page: Int }
        let listed = try await XCTUnwrap(model.engine).call(op: "images.list", args: Args(page: 0))
        XCTAssertEqual((listed.object["images"] as? [[String: Any]])?.count, 1, "the picture is the new page")
        model.close()
    }

    func testExtractAndSplitMakeNewFiles() async throws {
        let model = try await PartB.loadedModel("chrome-notonaskh-justified-3pages", in: folder)
        let pages = PagesModel(model: model)
        pages.extract([2, 0])
        try await settle(pages)
        XCTAssertEqual(pages.produced.count, 1)
        let extracted = try await Core.open(bytes: Data(contentsOf: pages.produced[0]))
        let count = await extracted.pageCount
        XCTAssertEqual(count, 2)
        let firstText = try await extracted.extractText(page: 0)
        XCTAssertTrue(firstText.contains("الفصل الثالث"), "in the order asked: \(firstText.prefix(40))")
        XCTAssertFalse(model.isEdited, "extracting leaves the document as it was")

        pages.split(every: 2)
        try await settle(pages)
        XCTAssertEqual(pages.produced.count, 2)
        XCTAssertTrue(pages.produced[0].lastPathComponent.hasSuffix(" 1.pdf"))
        let part2 = try await Core.open(bytes: Data(contentsOf: pages.produced[1]))
        let part2Count = await part2.pageCount
        XCTAssertEqual(part2Count, 1)
        model.close()
    }
}
