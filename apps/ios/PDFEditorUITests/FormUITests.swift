import WarraqCore
import XCTest

/// Prepare form and Fill form through the interface: a flat Arabic invoice
/// given its fields by the core's detection, a field drawn and named by
/// hand, the fields made, then filled in Arabic — saved, and the saved
/// file's form read by the core in the test runner, exactly.
@MainActor
final class FormUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    static let invoice = "ar-invoice"

    private func openPrepare(_ ui: PartBApp) {
        ui.more("document.prepareForm")
        XCTAssertTrue(ui.app.descendants(matching: .any).matching(identifier: "form.bar").firstMatch.waitForExistence(timeout: 20),
                      "the form bar: \(ui.tree)")
    }

    private func tapBar(_ ui: PartBApp, _ identifier: String) {
        let button = ui.app.buttons[identifier]
        let bar = ui.app.descendants(matching: .any).matching(identifier: "form.bar").firstMatch
        XCTAssertTrue(ui.poll(timeout: 20) { button.exists }, "form button \(identifier): \(ui.tree)")
        // The bar's tools scroll inside it (Apply and Done stay beside
        // it): the button is brought inside the bar's own frame, not just
        // the window's.
        var tries = 0
        while bar.exists, !bar.frame.insetBy(dx: 2, dy: 0).contains(button.frame), tries < 8 {
            if button.frame.minX < bar.frame.minX + 2 { bar.swipeRight() } else { bar.swipeLeft() }
            tries += 1
        }
        XCTAssertTrue(ui.poll(timeout: 10) { button.exists && button.isHittable }, "form button \(identifier): \(ui.tree)")
        button.tap()
    }

    /// The notice Prepare form puts up after detecting or creating.
    private func dismissNotice(_ ui: PartBApp) {
        let alert = ui.app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 40), "the notice: \(ui.tree)")
        alert.buttons.firstMatch.tap()
        _ = ui.poll(timeout: 10) { !alert.exists }
    }

    private func save(_ ui: PartBApp) throws -> Data {
        let save = ui.app.buttons["document.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 20), "Save: \(ui.tree)")
        save.tap()
        XCTAssertTrue(ui.poll(timeout: 30) { !save.exists }, "the document is saved")
        return try Data(contentsOf: try XCTUnwrap(ui.fileURL))
    }

    private struct Field: Decodable {
        let name: String
        let type: String
        let value: String
        let widgets: [Widget]

        struct Widget: Decodable {
            let page: Int
            let rect: [Float]
        }
    }

    private func fields(_ bytes: Data) async throws -> [Field] {
        struct Answer: Decodable { let fields: [Field] }
        let reply = try await Core.callStatic(op: "forms.inspect", args: "{}", blobs: [bytes])
        return try reply.decode(Answer.self).fields
    }

    /// The names a person gave the invoice's fields (tests/fixtures/forms/truth.json).
    private static let truth: Set<String> = [
        "اسم العميل", "الصنف 1", "الكمية 1", "سعر الوحدة 1", "الإجمالي 1",
        "الصنف 2", "الكمية 2", "سعر الوحدة 2", "الإجمالي 2",
        "الصنف 3", "الكمية 3", "سعر الوحدة 3", "الإجمالي 3", "المجموع",
    ]

    func testDetectedFieldsAreMadeThenFilledInArabicAndReadBackFromTheFile() async throws {
        let ui = try PartBApp.launch(language: PartBApp.arabic, fixture: Self.invoice)
        ui.waitForPage(containing: "فاتورة")
        openPrepare(ui)
        tapBar(ui, "form.detect")
        dismissNotice(ui)
        tapBar(ui, "form.create")
        dismissNotice(ui)
        tapBar(ui, "form.done")
        ui.more("document.fillForm")
        let field = ui.app.textFields["fill.اسم العميل"]
        XCTAssertTrue(field.waitForExistence(timeout: 20), "the customer's name to fill: \(ui.tree)")
        field.tap()
        field.typeText("سارة الحربي")
        XCTAssertEqual(field.value as? String, "سارة الحربي")
        ui.app.buttons["fill.apply"].tap()
        XCTAssertTrue(ui.poll(timeout: 30) { !ui.app.buttons["fill.apply"].exists }, "the sheet closes once filled")
        ui.waitForEdited()
        let saved = try save(ui)
        let read = try await fields(saved)
        XCTAssertEqual(Set(read.map(\.name)), Self.truth)
        XCTAssertEqual(read.first { $0.name == "اسم العميل" }?.value, "سارة الحربي")
        XCTAssertTrue(read.filter { $0.name != "اسم العميل" }.allSatisfy { $0.value.isEmpty })
    }

    func testAFieldDrawnAndNamedByHandIsMadeWhereItWasDrawn() async throws {
        let ui = try PartBApp.launch(fixture: Self.invoice)
        ui.waitForPage(containing: "فاتورة")
        openPrepare(ui)
        tapBar(ui, "form.kind.text")
        let page = ui.app.descendants(matching: .any).matching(identifier: "form.layer.0").firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 20), "the page's form layer: \(ui.tree)")
        // A box from (100, 600) to (300, 624) on the 595 × 842 page.
        let frame = page.frame
        let (w, h) = (frame.width / 595, frame.height / 842)
        let origin = page.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: 100 * w, dy: 600 * h))
        let end = origin.withOffset(CGVector(dx: 300 * w, dy: 624 * h))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
        // Named in the inspector (beside the pages on iPad, a sheet on a phone).
        if !ui.isPad { tapBar(ui, "form.fields") }
        let name = ui.app.textFields["form.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 20), "the drawn field is picked: \(ui.tree)")
        name.tap()
        for _ in 0..<3 {
            let left = (name.value as? String) ?? ""
            if left.isEmpty { break }
            name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: left.unicodeScalars.count + 2))
        }
        name.typeText("Reference")
        XCTAssertEqual(name.value as? String, "Reference")
        if !ui.isPad {
            ui.app.buttons["sheet.done"].tap()
            _ = ui.poll(timeout: 10) { !ui.app.buttons["sheet.done"].exists }
        }
        tapBar(ui, "form.create")
        dismissNotice(ui)
        tapBar(ui, "form.done")
        let saved = try save(ui)
        let made = try await fields(saved)
        XCTAssertEqual(made.map(\.name), ["Reference"])
        XCTAssertEqual(made.first?.type, "text")
        let rect = try XCTUnwrap(made.first?.widgets.first?.rect)
        // Where it was drawn, within a point or two of the finger.
        XCTAssertEqual(Double(rect[0]), 100, accuracy: 3)
        XCTAssertEqual(Double(rect[1]), 600, accuracy: 3)
        XCTAssertEqual(Double(rect[2]), 300, accuracy: 3)
        XCTAssertEqual(Double(rect[3]), 624, accuracy: 3)
    }
}
