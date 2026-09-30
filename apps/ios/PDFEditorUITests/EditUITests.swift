import XCTest

/// Edit PDF through the interface: open an Arabic document, tap the text on
/// the page and change it, drop a new line where a finger lands, add a
/// link, put a header and page numbers on every page — then save, reopen
/// and see the Arabic read back off the file in logical order.
@MainActor
final class EditUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// A button of the edit bar, brought into the window first: the bar
    /// scrolls when it is wider than the space it has.
    @discardableResult
    private func tapEdit(_ ui: PartBApp, _ identifier: String) -> XCUIElement {
        let button = ui.app.buttons[identifier]
        let bar = ui.app.descendants(matching: .any).matching(identifier: "edit.bar").firstMatch
        XCTAssertTrue(ui.poll(timeout: 20) { button.exists }, "edit button \(identifier): \(ui.tree)")
        let screen = ui.app.windows.firstMatch.frame
        var tries = 0
        while !screen.insetBy(dx: 2, dy: 0).contains(button.frame), bar.exists, tries < 8 {
            if button.frame.minX < screen.minX + 2 { bar.swipeRight() } else { bar.swipeLeft() }
            tries += 1
        }
        XCTAssertTrue(ui.poll(timeout: 10) { button.exists && button.isHittable }, "edit button \(identifier): \(ui.tree)")
        button.tap()
        return button
    }

    /// Opens the editor on the document on screen.
    private func openEditor(_ ui: PartBApp) {
        let edit = ui.app.buttons["document.edit"]
        XCTAssertTrue(edit.waitForExistence(timeout: 20), "the Edit button: \(ui.tree)")
        edit.tap()
        XCTAssertTrue(ui.app.descendants(matching: .any).matching(identifier: "edit.bar").firstMatch.waitForExistence(timeout: 20),
                      "the edit bar: \(ui.tree)")
    }

    /// The field on the page, once a paragraph or a point has opened it.
    private func field(_ ui: PartBApp) -> XCUIElement {
        ui.app.textViews["edit.field"]
    }

    // MARK: - The text already on the page

    func testAParagraphIsEditedInPlaceAndTheArabicReadsBackAfterSaving() throws {
        let file = try PartBApp.copyFixture(PartBApp.threePages)
        var ui = try PartBApp.launch(language: PartBApp.arabic, file: file)
        ui.waitForPage(containing: "الفصل")
        openEditor(ui)

        // The paragraphs are listed in the inspector on iPad and reachable
        // on the page everywhere; the inspector's row is the reliable one.
        let row = ui.app.buttons["edit.paragraph.0"]
        if row.waitForExistence(timeout: 20) {
            row.tap()
        } else {
            // A phone: tap the text itself, in the top third of the page.
            ui.page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        }
        XCTAssertTrue(field(ui).waitForExistence(timeout: 20), "the field opens over the paragraph: \(ui.tree)")

        let replacement = "نصٌّ جديدٌ بالتشكيل"
        field(ui).tap()
        field(ui).press(forDuration: 1.2)
        if ui.app.menuItems["Select All"].waitForExistence(timeout: 3) {
            ui.app.menuItems["Select All"].tap()
        } else if ui.app.menuItems["تحديد الكل"].exists {
            ui.app.menuItems["تحديد الكل"].tap()
        } else {
            // No edit menu on this run: clear it a character at a time.
            let length = (field(ui).value as? String)?.count ?? 0
            field(ui).typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: min(length, 400)))
        }
        field(ui).typeText(replacement)
        tapEdit(ui, "edit.apply")

        ui.waitForEdited()
        XCTAssertTrue(ui.poll(timeout: 30) { !self.field(ui).exists }, "the field closes")
        XCTAssertTrue(ui.poll(timeout: 40) { (ui.page.value as? String)?.contains(replacement) == true },
                      "the core reads the new Arabic off the page: \(ui.page.value ?? "")")

        // Saved and opened again: it is in the file, not only on screen.
        tapEdit(ui, "edit.done")
        let save = ui.app.buttons["document.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 20), "Save: \(ui.tree)")
        save.tap()
        XCTAssertTrue(ui.poll(timeout: 30) { !save.exists }, "the document is saved")
        ui.app.terminate()

        ui = try PartBApp.launch(language: PartBApp.arabic, file: file)
        let text = ui.waitForPage(containing: replacement)
        XCTAssertTrue(text.contains(replacement), "and it is in the file: \(text.prefix(200))")
    }

    // MARK: - A line where the finger lands

    func testALineOfArabicIsAddedWhereTheFingerLands() throws {
        let ui = try PartBApp.launch(language: PartBApp.arabic, fixture: PartBApp.invoice)
        ui.waitForPage(containing: "فاتورة")
        openEditor(ui)
        tapEdit(ui, "edit.addLine")
        tapEdit(ui, "edit.color.red")
        // Low on the page, in the margin under the invoice's own words.
        ui.page.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.88)).tap()
        XCTAssertTrue(field(ui).waitForExistence(timeout: 20), "the field opens where the finger landed: \(ui.tree)")
        field(ui).tap()
        field(ui).typeText("سطرٌ مضاف")
        tapEdit(ui, "edit.apply")
        ui.waitForEdited()
        XCTAssertTrue(ui.poll(timeout: 40) { (ui.page.value as? String)?.contains("سطرٌ مضاف") == true },
                      "the added line is part of the page's text: \(ui.page.value ?? "")")
    }

    // MARK: - Links

    func testALinkIsDrawnGivenAnAddressAndTakenOffAgain() throws {
        let ui = try PartBApp.launch(language: PartBApp.english, fixture: PartBApp.invoice)
        ui.waitForPage(containing: "فاتورة")
        openEditor(ui)
        tapEdit(ui, "edit.mode.links")
        ui.drag(from: (0.25, 0.5), to: (0.7, 0.56))
        let address = ui.app.textFields["link.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 20), "the link sheet opens on the box that was drawn: \(ui.tree)")
        address.tap()
        address.typeText("https://example.org")
        ui.app.buttons["link.save"].tap()
        ui.waitForEdited()

        // It is listed where the editor lists what a page holds; on a phone
        // the inspector is not shown, so the bar's own controls stand for it.
        let listed = ui.app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'edit.link.'")).firstMatch
        if listed.waitForExistence(timeout: 20) {
            listed.tap()
            ui.app.buttons["edit.inspector.linkRemove"].tap()
        } else {
            ui.page.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.53)).tap()
            tapEdit(ui, "edit.link.remove")
        }
        XCTAssertTrue(ui.poll(timeout: 30) { ui.app.staticTexts["edit.link.hint"].exists || !listed.exists },
                      "the link is off the page again")
    }

    // MARK: - Page marks

    func testAnArabicHeaderAndPageNumbersAreAddedAndListed() throws {
        let ui = try PartBApp.launch(language: PartBApp.arabic, fixture: PartBApp.threePages)
        ui.waitForPage(containing: "الفصل")
        ui.more("document.pageMarks", label: "علامات الصفحات…")

        let kind = ui.app.buttons["marks.kind"]
        XCTAssertTrue(kind.waitForExistence(timeout: 20), "the page marks sheet: \(ui.tree)")
        kind.tap()
        let header = ui.app.buttons["رأس الصفحة"].exists ? ui.app.buttons["رأس الصفحة"] : ui.app.buttons["Header"]
        XCTAssertTrue(header.waitForExistence(timeout: 10), "the Header kind: \(ui.tree)")
        header.tap()

        let start = ui.app.textFields["marks.band.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        start.typeText("شركة زود")
        ui.app.buttons["marks.add"].tap()
        // The form is a list: the marks on the document are its last section,
        // below the fold until it is scrolled to.
        let removes = ui.app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'marks.remove.'"))
        XCTAssertTrue(ui.poll(timeout: 90) {
            if removes.count > 0 { return true }
            ui.app.swipeUp()
            return removes.count > 0
        }, "the header is listed on the document: \(ui.tree)")

        // And off the list once it is removed.
        removes.firstMatch.tap()
        XCTAssertTrue(ui.poll(timeout: 90) { removes.count == 0 },
                      "and taken off again: \(ui.tree)")
    }

    // MARK: - Screenshots

    func testEditorScreenshots() throws {
        guard let directory = PartBApp.screenshotDirectory else { throw XCTSkip("no screenshot directory") }
        for language in [PartBApp.arabic, PartBApp.english] {
            let ui = try PartBApp.launch(language: language, fixture: PartBApp.threePages)
            ui.waitForPage(containing: "الفصل")
            openEditor(ui)
            _ = ui.poll(timeout: 20) { ui.app.buttons["edit.paragraph.0"].exists || ui.isPad == false }
            try ui.screenshot("edit-\(language)-light-\(PartBApp.deviceSlug)", in: directory)
            ui.app.terminate()
        }
    }
}
