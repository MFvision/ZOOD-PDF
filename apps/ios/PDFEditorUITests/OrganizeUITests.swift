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
        // Lift the third page and drop it on the first's place.
        third.press(forDuration: 0.9, thenDragTo: first, withVelocity: .slow, thenHoldForDuration: 0.4)
        let done = ui.app.buttons["pages.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.tap()
        ui.waitForEdited()
        let moved = ui.waitForPage(containing: "الفصل الثالث")
        XCTAssertTrue(moved.contains("الفصل الثالث"), "the core reads the moved page first")

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
        let status = ui.app.staticTexts["document.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        // Delete the selected page: three become two.
        ui.app.buttons["pages.delete"].firstMatch.tap()
        let predicate = NSPredicate(format: "label CONTAINS %@", "2")
        let twoPages = XCTNSPredicateExpectation(predicate: predicate, object: status)
        XCTAssertEqual(XCTWaiter().wait(for: [twoPages], timeout: 20), .completed, status.label)
        ui.app.buttons["pages.done"].tap()
        ui.waitForStatus(containing: "of 2")
    }
}
