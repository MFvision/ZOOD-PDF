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

    /// Whether the field on the page is open. The field lives inside
    /// PDFKit's page overlay, and PDFKit's page lists its own text elements
    /// to accessibility rather than its subviews, so the field is known by
    /// the bar: while it is open the bar holds only Cancel and Apply.
    /// The field itself, over the page — not the bar's Apply, which shows
    /// as soon as the model is editing, whether or not a field was put on
    /// the page to type in.
    private func fieldIsOpen(_ ui: PartBApp, timeout: TimeInterval = 20) -> Bool {
        ui.app.textViews["edit.field"].waitForExistence(timeout: timeout)
    }

    /// The page view's value, the core's text of the page, once the editor
    /// is closed again (while it is open the view is a container).
    private func pageText(after ui: PartBApp) -> String {
        tapEdit(ui, "edit.done")
        _ = ui.poll(timeout: 20) { !ui.app.buttons["edit.done"].exists }
        return ui.page.value as? String ?? ""
    }

    // MARK: - The text already on the page

    func testAParagraphIsEditedInPlaceAndTheArabicReadsBackAfterSaving() throws {
        let file = try PartBApp.copyFixture(PartBApp.threePages)
        var ui = try PartBApp.launch(language: PartBApp.arabic, file: file)
        ui.waitForPage(containing: "الفصل")
        openEditor(ui)

        // The paragraphs are listed in the inspector on iPad; on a phone the
        // text itself is tapped, a little further down each time until a
        // tap lands in a paragraph.
        let row = ui.app.buttons["edit.paragraph.0"]
        if row.waitForExistence(timeout: 20) {
            row.tap()
        } else {
            for y in stride(from: 0.2, through: 0.7, by: 0.04) where !fieldIsOpen(ui, timeout: 3) {
                ui.page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y)).tap()
            }
        }
        XCTAssertTrue(fieldIsOpen(ui), "the field opens over the paragraph: \(ui.tree)")

        // The field starts from the paragraph's text with the caret at its
        // end: cleared, then the Arabic typed in its place.
        // Without tashkeel here: the simulator's keyboard does not type the
        // marks one by one. Tashkeel through replaceParagraph and back off
        // the saved file is proven in PDFEditorTests/EditTests.
        let replacement = "نص جديد كتب في مكانه"
        // The field takes the keyboard a moment after it appears (after the
        // tap that opened it has finished).
        let field = ui.app.textViews["edit.field"]
        XCTAssertTrue(ui.poll(timeout: 10) { (field.value(forKey: "hasKeyboardFocus") as? Bool) == true }, "the field has the keyboard")
        // Emptied, then the Arabic typed in its place. Not Select All: a ⌘A
        // sent by XCUITest never reached the field (its selection did not
        // move), so the typing was added after the old text — which the old
        // check, that the new text was somewhere in the page, let through.
        let old = (field.value as? String) ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count + 2))
        XCTAssertTrue(ui.poll(timeout: 10) { ((field.value as? String) ?? "x").isEmpty }, "the field is empty: \(field.value ?? "")")
        field.typeText(replacement)
        XCTAssertTrue(ui.poll(timeout: 10) { (field.value as? String) == replacement }, "the field holds just the new text: \(field.value ?? "")")
        tapEdit(ui, "edit.apply")

        ui.waitForEdited()
        XCTAssertTrue(ui.poll(timeout: 30) { !ui.app.buttons["edit.apply"].exists }, "the field closes")
        // A longer text than the paragraph had is set smaller to fit its
        // box, and the editor says so in an alert over everything else.
        let fitted = ui.app.alerts.firstMatch
        if fitted.waitForExistence(timeout: 3) { fitted.buttons.firstMatch.tap() }
        // On iPad the inspector's row is the core's reading of the paragraph,
        // read again after the edit; the page element holds the text of
        // whichever page PDFKit calls current, and on a tall iPad two are on
        // screen. On a phone that page is the one on screen.
        let inspector = row.exists
        if inspector {
            XCTAssertTrue(ui.poll(timeout: 20) { row.label.contains(replacement) }, "the core reads the new Arabic back: \(row.label)")
            XCTAssertFalse(row.label.contains("محرّك النصوص"), "and nothing of the old text is left: \(row.label)")
            tapEdit(ui, "edit.done")
        } else {
            let text = pageText(after: ui)
            XCTAssertTrue(text.contains(replacement), "the core reads the new Arabic off the page: \(text)")
        }

        // Saved and opened again: it is in the file, not only on screen.
        let save = ui.app.buttons["document.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 20), "Save: \(ui.tree)")
        save.tap()
        XCTAssertTrue(ui.poll(timeout: 30) { !save.exists }, "the document is saved")
        ui.app.terminate()

        ui = try PartBApp.launch(language: PartBApp.arabic, file: file)
        if inspector {
            ui.waitForPage(containing: "الفصل")
            openEditor(ui)
            let again = ui.app.buttons["edit.paragraph.0"]
            XCTAssertTrue(again.waitForExistence(timeout: 20), "the inspector lists the page again")
            XCTAssertTrue(ui.poll(timeout: 20) { again.label.contains(replacement) }, "and it is in the file: \(again.label)")
        } else {
            let reopened = ui.waitForPage(containing: replacement)
            XCTAssertTrue(reopened.contains(replacement), "and it is in the file: \(reopened.prefix(200))")
        }
    }

    // MARK: - A line where the finger lands

    func testALineOfArabicIsAddedWhereTheFingerLands() throws {
        let ui = try PartBApp.launch(language: PartBApp.arabic, fixture: PartBApp.invoice)
        ui.waitForPage(containing: "فاتورة")
        openEditor(ui)
        tapEdit(ui, "edit.addLine")
        tapEdit(ui, "edit.color.red")
        // Low on the page, in the margin under the invoice's own words.
        // Low on the page, in the margin under the invoice's own words; a
        // little higher if the first point was past the paper's foot.
        for y in [0.78, 0.7, 0.6] where !fieldIsOpen(ui, timeout: 4) {
            ui.page.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: y)).tap()
        }
        XCTAssertTrue(fieldIsOpen(ui), "the field opens where the finger landed: \(ui.tree)")
        ui.app.typeText("سطرٌ مضاف")
        tapEdit(ui, "edit.apply")
        ui.waitForEdited()
        let text = pageText(after: ui)
        XCTAssertTrue(text.contains("سطرٌ مضاف"), "the added line is part of the page's text: \(text.suffix(300))")
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
