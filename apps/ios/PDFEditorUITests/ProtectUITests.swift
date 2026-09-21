import XCTest

/// Protecting, through the interface: set a password, save, reopen — the
/// prompt appears, a wrong password is refused, the right one opens the
/// pages — then remove it.
@MainActor
final class ProtectUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSetAPasswordSaveReopenAndRemoveIt() throws {
        var ui = try PartBApp.launch(fixture: PartBApp.invoice)
        ui.waitForPage(containing: "فاتورة")
        ui.more("document.protect", label: "Protect…")
        ui.type("1234", into: "protect.password")
        ui.type("1234", into: "protect.confirm")
        ui.app.buttons["protect.set"].tap()
        ui.waitForEdited()
        let save = ui.app.buttons["document.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 10))
        save.tap()
        let deadline = Date(timeIntervalSinceNow: 20)
        while ui.app.buttons["document.save"].exists, Date() < deadline {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.3))
        }

        let file = try XCTUnwrap(ui.fileURL)
        ui = try PartBApp.launch(file: file)
        let field = ui.app.secureTextFields["document.password"]
        XCTAssertTrue(field.waitForExistence(timeout: 30), "the saved file asks for its password")
        field.tap()
        field.typeText("wrong")
        ui.app.buttons["document.password.open"].tap()
        let wrong = ui.app.staticTexts["That password is not right. Try again."]
        XCTAssertTrue(wrong.waitForExistence(timeout: 20), "a wrong password is refused")
        let again = ui.app.secureTextFields["document.password"]
        again.tap()
        again.typeText("1234")
        ui.app.buttons["document.password.open"].tap()
        ui.waitForPage(containing: "فاتورة")

        // Off again.
        ui.more("document.protect", label: "Protect…")
        XCTAssertTrue(ui.app.buttons["protect.remove"].waitForExistence(timeout: 10))
        ui.app.buttons["protect.remove"].tap()
        ui.waitForEdited()
        ui.more("document.protect", label: "Protect…")
        XCTAssertTrue(ui.app.buttons["protect.set"].waitForExistence(timeout: 10), "no longer protected")
        ui.app.buttons["sheet.done"].tap()
    }
}
