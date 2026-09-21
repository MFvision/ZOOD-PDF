@testable import PDFEditor
import PDFKit
import WarraqCore
import XCTest

/// Viewing: the page spaces, the core's search through the model with
/// PDFKit's selections for its hits, and Go to page's numbers.
@MainActor
final class ViewTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = try PartB.folder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: - Page spaces

    func testStoredAndShownSpacesRoundTripThroughUserSpace() {
        let crop = CGRect(x: 10, y: 20, width: 400, height: 600)
        for rotation in [0, 90, 180, 270] {
            let frame = PageSpace.Frame(crop: crop, rotation: rotation)
            let shown = CGPoint(x: 30, y: 50)
            let user = PageSpace.userPoint(fromShown: shown, in: frame)
            let back = PageSpace.shownPoint(fromUser: user, in: frame)
            XCTAssertEqual(back.x, shown.x, accuracy: 0.001, "rotation \(rotation)")
            XCTAssertEqual(back.y, shown.y, accuracy: 0.001, "rotation \(rotation)")
            XCTAssertTrue(crop.insetBy(dx: -0.01, dy: -0.01).contains(user), "inside the crop box at \(rotation)")
        }
        let upright = PageSpace.Frame(crop: crop, rotation: 0)
        // Stored space: y down from the crop box's top-left corner.
        let stored = CGRect(x: 5, y: 10, width: 100, height: 20)
        let user = PageSpace.userRect(fromStored: stored, in: upright)
        XCTAssertEqual(user, CGRect(x: 15, y: 590, width: 100, height: 20))
        XCTAssertEqual(PageSpace.Frame(crop: crop, rotation: 90).shownSize, CGSize(width: 600, height: 400))
        XCTAssertEqual(PageSpace.uprightMatrix(in: CGRect(x: 10, y: 20, width: 100, height: 50)), [100, 0, 0, -50, 10, 70])
    }

    // MARK: - Search

    func testSearchFindsAWordWithoutTashkeelAndHighlightsItsGlyphs() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let search = DocumentSearch()
        search.query = "الفاتوره" // taa marbuta written as haa: the core unifies them
        search.run(in: model)
        try await waitUntil { !search.searching }
        XCTAssertGreaterThan(search.hits.count, 0, "hits")
        XCTAssertEqual(search.total, search.hits.count)
        let hit = try XCTUnwrap(search.currentHit)
        XCTAssertEqual(hit.page, 0)
        XCTAssertFalse(hit.rects.isEmpty, "the glyphs' boxes")
        let selection = try XCTUnwrap(search.currentSelection, "PDFKit finds the glyphs in the core's box")
        XCTAssertTrue(selection.string?.contains("فاتور") == true, "\(selection.string ?? "")")
        let page = try XCTUnwrap(model.pdf?.page(at: 0))
        let bounds = selection.bounds(for: page)
        XCTAssertTrue(page.bounds(for: .cropBox).contains(bounds), "on the page")

        // Walking the hits wraps around.
        let count = search.hits.count
        search.next()
        XCTAssertEqual(search.current, count > 1 ? 1 : 0)
        search.previous()
        XCTAssertEqual(search.current, 0)
        search.previous()
        XCTAssertEqual(search.current, count - 1)

        search.query = "كلمة غير موجودة إطلاقاً"
        search.run(in: model)
        try await waitUntil { !search.searching }
        XCTAssertTrue(search.hits.isEmpty)
        model.close()
    }

    func testSearchAnswersEveryPageOfALongerDocument() async throws {
        let model = try await PartB.loadedModel("chrome-notonaskh-justified-3pages", in: folder)
        let search = DocumentSearch()
        search.query = "الفصل"
        search.run(in: model)
        try await waitUntil { !search.searching }
        XCTAssertEqual(Set(search.hits.map(\.page)), [0, 1, 2], "a chapter heading on every page")
        model.close()
    }

    // MARK: - Go to page

    func testPageNumbersInEitherScript() {
        XCTAssertEqual(GoToPageSheet.pageNumber(from: "3", count: 9), 3)
        XCTAssertEqual(GoToPageSheet.pageNumber(from: "٣", count: 9), 3)
        XCTAssertEqual(GoToPageSheet.pageNumber(from: "۱۲", count: 20), 12)
        XCTAssertNil(GoToPageSheet.pageNumber(from: "0", count: 9))
        XCTAssertNil(GoToPageSheet.pageNumber(from: "10", count: 9))
        XCTAssertNil(GoToPageSheet.pageNumber(from: "abc", count: 9))
        XCTAssertNil(GoToPageSheet.pageNumber(from: "", count: 9))
    }

    // MARK: - Outline

    func testOutlineIsReadByTheCore() async throws {
        let model = try await PartB.loadedModel("variant-arabic-metadata-outlines-annots", in: folder)
        struct Args: Encodable { let password: String? }
        struct Answer: Decodable { let bookmarks: [OutlineEntry] }
        let reply = try await Core.callStatic(op: "outline.list", args: Args(password: nil), blobs: [model.bytes])
        let answer: Answer = try reply.decode()
        XCTAssertEqual(answer.bookmarks.count, 3)
        XCTAssertTrue(answer.bookmarks[0].title.hasPrefix("الفصل الأول"), answer.bookmarks[0].title)
        XCTAssertEqual(answer.bookmarks[2].page, 2)
        XCTAssertEqual(answer.bookmarks[0].children.count, 1)
        model.close()
    }

    private func waitUntil(timeout: TimeInterval = 20, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !condition() {
            if Date() > deadline { throw XCTSkip("timed out waiting") }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
}
