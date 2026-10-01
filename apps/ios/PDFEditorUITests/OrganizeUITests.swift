import XCTest

/// Organizing, through the interface: drag the last page first, save,
/// reopen, and the core reads the moved page as the first; rotate and
/// delete from the bar.
@MainActor
final class OrganizeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testReorderByDragThenSaveAndReopen() throws {
        var ui = try PartBApp.launch(fixture: PartBApp.threePages)
        ui.waitForPage(containing: "الفصل الأول")
        ui.app.buttons["document.pages"].tap()
        let third = ui.app.buttons["pages.cell.2"]
        let first = ui.app.buttons["pages.cell.0"]
        XCTAssertTrue(third.waitForExistence(timeout: 15))
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        // Lift the third page and drop it on the first's place. The lift
        // is a press just long enough to start the drag before the context
        // menu opens; when a press did not take (a slower simulator), the
        // next one is longer.
        var moved = false
        for duration in [0.45, 0.6, 0.8] where !moved {
            XCTAssertTrue(third.waitForExistence(timeout: 15))
            third.press(forDuration: duration, thenDragTo: first, withVelocity: .slow, thenHoldForDuration: 0.5)
            if ui.app.buttons["Add Page"].waitForExistence(timeout: 2) {
                // The context menu opened instead of the lift: close it.
                ui.app.tap()
            }
            let done = ui.app.buttons["pages.done"]
            XCTAssertTrue(done.waitForExistence(timeout: 10))
            done.tap()
            // The moved page is the first the core reads.
            moved = ui.poll(timeout: 8) {
                let page = ui.page
                return page.exists && ((page.value as? String)?.contains("الفصل الثالث") == true)
            }
            if !moved { ui.app.buttons["document.pages"].tap() }
        }
        ui.waitForEdited()
        let text = ui.waitForPage(containing: "الفصل الثالث")
        XCTAssertTrue(text.contains("الفصل الثالث"), "the core reads the moved page first")

        let save = ui.app.buttons["document.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 10))
        save.tap()
        let deadline = Date(timeIntervalSinceNow: 20)
        while ui.app.buttons["document.save"].exists, Date() < deadline {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.3))
        }
        let file = try XCTUnwrap(ui.fileURL)
        ui = try PartBApp.launch(file: file)
        let reopened = ui.waitForPage(containing: "الفصل")
        XCTAssertTrue(reopened.contains("الفصل الثالث"), "saved in the new order: \(reopened.prefix(60))")
        ui.waitForStatus(containing: "Page 1 of 3")
    }

    func testRotateAndDeleteFromTheBar() throws {
        let ui = try PartBApp.launch(fixture: PartBApp.threePages)
        ui.waitForPage(containing: "الفصل الأول")
        ui.app.buttons["document.pages"].tap()
        let second = ui.app.buttons["pages.cell.1"]
        XCTAssertTrue(second.waitForExistence(timeout: 15))
        second.tap()
        ui.app.buttons["pages.rotate"].firstMatch.tap()
        // Delete the selected page: three become two.
        ui.app.buttons["pages.delete"].firstMatch.tap()
        XCTAssertTrue(ui.poll(timeout: 20) { ui.app.buttons["pages.cell.2"].exists == false && ui.app.buttons["pages.cell.1"].exists }, "two cells left: \(ui.tree)")
        ui.app.buttons["pages.done"].tap()
        ui.waitForStatus(containing: "of 2")
    }
}
