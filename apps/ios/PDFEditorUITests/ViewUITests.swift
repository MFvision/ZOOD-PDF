import XCTest

/// Viewing, through the interface: search a word typed without its
/// tashkeel and find it, walk the hits, go to a page by number, by
/// thumbnail and by the outline, and switch the layout, night mode and
/// reader mode.
@MainActor
final class ViewUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSearchFindsAnArabicWordTypedWithoutItsMarks() throws {
        let ui = try PartBApp.launch(language: PartBApp.arabic, fixture: PartBApp.invoice)
        ui.waitForPage(containing: "فاتورة")
        ui.app.buttons["document.search"].tap()
        // Taa marbuta typed as haa, no tashkeel: the core still finds it.
        ui.type("الفاتوره", into: "search.field")
        let count = ui.app.buttons["search.count"]
        XCTAssertTrue(count.waitForExistence(timeout: 20), "hits are counted: \(ui.app.staticTexts["search.none"].exists ? "no matches" : "")")
        let label = count.label
        XCTAssertTrue(label.contains("1"), "the first hit is current: \(label)")
        ui.app.buttons["search.next"].tap()
        ui.app.buttons["search.previous"].tap()
        XCTAssertEqual(count.label, label, "back on the first hit")
        // The list of hits, with the words around each.
        count.tap()
        XCTAssertTrue(ui.app.buttons["search.hit.0"].waitForExistence(timeout: 10))
        ui.app.buttons["search.hit.0"].tap()
        ui.app.buttons["search.done"].tap()
        XCTAssertFalse(ui.app.textFields["search.field"].exists)
    }

    func testSearchInEnglishFindsALatinWordToo() throws {
        let ui = try PartBApp.launch(fixture: PartBApp.invoice)
        ui.waitForPage(containing: "فاتورة")
        ui.app.buttons["document.search"].tap()
        ui.type("premium", into: "search.field")
        XCTAssertTrue(ui.app.buttons["search.count"].waitForExistence(timeout: 20), "case ignored")
        ui.app.buttons["search.done"].tap()
    }

    func testGoToPageByNumberThumbnailAndOutline() throws {
        let ui = try PartBApp.launch(fixture: PartBApp.outlines)
        ui.waitForPage(containing: "الفصل")
        ui.waitForStatus(containing: "Page 1 of 3")

        // By number.
        ui.viewControl("document.goto", menuLabel: "Go to page…")
        ui.type("3", into: "goto.field")
        ui.app.buttons["goto.go"].tap()
        ui.waitForStatus(containing: "Page 3 of 3")
        ui.waitForPage(containing: "الفصل الثالث")

        // By thumbnail.
        ui.app.buttons["document.thumbnails.toggle"].tap()
        let first = ui.app.buttons["thumbnail.0"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.tap()
        ui.waitForStatus(containing: "Page 1 of 3")
        ui.app.buttons["document.thumbnails.toggle"].tap()

        // By the outline the core read.
        ui.more("document.outline", label: "Outline")
        let entry = ui.app.buttons["outline.1"]
        XCTAssertTrue(entry.waitForExistence(timeout: 15), "the outline lists the chapters")
        XCTAssertTrue(entry.label.contains("الفصل الثاني"), entry.label)
        entry.tap()
        ui.waitForStatus(containing: "Page 2 of 3")
    }

    func testLayoutNightAndReaderModes() throws {
        let ui = try PartBApp.launch(fixture: PartBApp.threePages)
        ui.waitForPage(containing: "الفصل الأول")

        ui.more("layout.single", label: "Single page")
        XCTAssertTrue(ui.page.waitForExistence(timeout: 10))
        ui.waitForStatus(containing: "Page 1 of 3")
        ui.more("layout.continuous", label: "Continuous")

        ui.viewControl("document.night.toggle", menuLabel: "Night mode")
        XCTAssertTrue(ui.page.waitForExistence(timeout: 10), "the pages stay on screen, inverted")
        ui.viewControl("document.night.toggle", menuLabel: "Night mode")

        ui.viewControl("document.reader.toggle", menuLabel: "Reader mode")
        let reader = ui.app.otherElements["document.reader"]
        XCTAssertTrue(reader.waitForExistence(timeout: 10) || ui.app.scrollViews["document.reader"].waitForExistence(timeout: 5))
        let firstPage = ui.app.otherElements["reader.page.0"]
        XCTAssertTrue(firstPage.waitForExistence(timeout: 20), "the first page's text, reflowed")
        XCTAssertTrue(firstPage.label.contains("الفصل الأول") || ui.app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "الفصل الأول")).firstMatch.waitForExistence(timeout: 10))
        ui.viewControl("document.reader.toggle", menuLabel: "Reader mode")
        XCTAssertTrue(ui.page.waitForExistence(timeout: 10))
    }
}
