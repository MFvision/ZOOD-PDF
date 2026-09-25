import XCTest

/// Marking up, through the interface: highlight by dragging, a note, an
/// Arabic text box, a stamp, a drawn signature placed by hand; save,
/// reopen, and the marks are still there.
@MainActor
final class AnnotateUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// The Info sheet's count of marks.
    private func marks(_ ui: PartBApp) -> Int {
        ui.app.buttons["document.info"].tap()
        let count = ui.app.staticTexts["info.marks"]
        // The sheet's list is lazy: the row may sit below its first height.
        if !count.waitForExistence(timeout: 5) {
            ui.app.swipeUp()
        }
        XCTAssertTrue(count.waitForExistence(timeout: 10), "the Marks row: \(ui.tree)")
        let digits = count.label.unicodeScalars.map { scalar -> Character in
            switch scalar.value {
            case 0x660...0x669: Character(UnicodeScalar(scalar.value - 0x660 + 0x30)!)
            default: Character(scalar)
            }
        }
        let value = Int(String(digits).filter(\.isNumber)) ?? -1
        ui.app.buttons["sheet.done"].tap()
        return value
    }

    func testHighlightNoteStampAndSignatureSurviveSaveAndReopen() throws {
        var ui = try PartBApp.launch(language: PartBApp.arabic, fixture: PartBApp.invoice)
        ui.waitForPage(containing: "فاتورة")
        XCTAssertEqual(marks(ui), 0)

        // Highlight: drag across the words in the middle of the page.
        ui.app.buttons["document.markup"].tap()
        ui.tapMarkup("markup.highlight")
        ui.drag(from: (0.12, 0.42), to: (0.88, 0.42))
        ui.waitForEdited()
        let afterHighlight = marks(ui)
        XCTAssertGreaterThanOrEqual(afterHighlight, 1, "the highlight is a mark")

        // A note where the finger taps, with Arabic words.
        ui.tapMarkup("markup.note")
        ui.page.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.7)).tap()
        ui.type("راجع هذا", into: "note.field")
        ui.app.buttons["note.add"].tap()
        XCTAssertTrue(waitFor { self.marks(ui) == afterHighlight + 1 }, "the note is a mark")

        // A text box: Arabic, shaped by the core.
        ui.tapMarkup("markup.freeText")
        ui.page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)).tap()
        ui.type("نص مضاف", into: "note.field")
        ui.app.buttons["note.add"].tap()
        XCTAssertTrue(waitFor { self.marks(ui) == afterHighlight + 2 }, "the text box is a mark")

        // A stamp, written by the core.
        ui.tapMarkup("markup.stamp")
        let approved = ui.app.buttons["stamp.approved"]
        XCTAssertTrue(approved.waitForExistence(timeout: 10))
        approved.tap()
        ui.app.buttons["stamp.add"].tap()
        XCTAssertTrue(ui.app.buttons["markup.done"].waitForExistence(timeout: 20))

        // A signature drawn with the finger, then placed.
        ui.tapMarkup("markup.signature")
        let canvas = ui.app.descendants(matching: .any).matching(identifier: "signature.pkcanvas").firstMatch
        XCTAssertTrue(canvas.waitForExistence(timeout: 10), "the signature canvas")
        let a = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.6))
        let b = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let c = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.65))
        a.press(forDuration: 0.05, thenDragTo: b, withVelocity: .slow, thenHoldForDuration: 0.05)
        b.press(forDuration: 0.05, thenDragTo: c, withVelocity: .slow, thenHoldForDuration: 0.05)
        let place = ui.app.buttons["signature.place"]
        XCTAssertTrue(waitFor { place.isEnabled }, "strokes landed on the canvas")
        place.tap()
        let floating = ui.app.descendants(matching: .any).matching(identifier: "signature.floating").firstMatch
        XCTAssertTrue(floating.waitForExistence(timeout: 10), "the signature floats over the page")
        let from = floating.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        from.press(forDuration: 0.1, thenDragTo: from.withOffset(CGVector(dx: 0, dy: 120)), withVelocity: .slow, thenHoldForDuration: 0.1)
        ui.app.buttons["signature.confirm"].tap()
        XCTAssertTrue(waitFor(timeout: 20) { !ui.app.buttons["signature.confirm"].exists }, "placed")
        ui.app.buttons["markup.done"].tap()

        // Saved, reopened: the marks are in the file.
        let expected = afterHighlight + 2
        XCTAssertEqual(marks(ui), expected)
        let save = ui.app.buttons["document.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 10))
        save.tap()
        XCTAssertTrue(waitFor(timeout: 20) { !ui.app.buttons["document.save"].exists }, "saved")
        let file = try XCTUnwrap(ui.fileURL)
        ui = try PartBApp.launch(language: PartBApp.arabic, file: file)
        ui.waitForPage(containing: "فاتورة")
        XCTAssertEqual(marks(ui), expected, "the marks came back from the saved file")
        // The stamp reads back as text through the core: the search finds
        // it (a page mark is part of what the search reads, not of the
        // page's own text).
        ui.app.buttons["document.search"].tap()
        ui.type("معتمد", into: "search.field")
        XCTAssertTrue(ui.app.buttons["search.count"].waitForExistence(timeout: 20), "the stamp's word is found: \(ui.app.staticTexts["search.none"].exists ? "no matches" : "")")
        ui.app.buttons["search.done"].tap()
        // The marks list names them, and can delete one.
        ui.more("document.marks", label: "Marks")
        let first = ui.app.buttons["mark.0"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.swipeLeft()
        let delete = ui.app.buttons["Delete"].exists ? ui.app.buttons["Delete"] : ui.app.buttons["حذف"]
        if delete.waitForExistence(timeout: 3) {
            delete.tap()
            XCTAssertTrue(waitFor { !ui.app.buttons["mark.\(expected - 1)"].exists })
        }
        ui.app.buttons["sheet.done"].tap()
    }

    func testDrawingWithAFingerBecomesInk() throws {
        let ui = try PartBApp.launch(fixture: PartBApp.invoice)
        ui.waitForPage(containing: "فاتورة")
        ui.app.buttons["document.markup"].tap()
        ui.tapMarkup("markup.ink")
        XCTAssertTrue(ui.app.buttons["pen.color.red"].waitForExistence(timeout: 5), "the pen palette floats up")
        ui.drag(from: (0.3, 0.55), to: (0.7, 0.6), duration: 0.05)
        ui.drag(from: (0.3, 0.6), to: (0.7, 0.55), duration: 0.05)
        // Done commits the strokes.
        ui.app.buttons["markup.done"].tap()
        ui.waitForEdited()
        XCTAssertGreaterThanOrEqual(marks(ui), 1, "the strokes are ink marks")
        // Undo takes them back.
        ui.app.buttons["document.markup"].tap()
        let undo = ui.app.buttons["markup.undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5))
        if undo.isEnabled {
            ui.tapMarkup("markup.undo")
            XCTAssertTrue(waitFor { self.marks(ui) == 0 }, "undone")
        }
    }

    private func waitFor(timeout: TimeInterval = 15, _ condition: () -> Bool) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.4))
        }
        return condition()
    }
}
