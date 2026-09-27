import XCTest

/// Every screen of part B photographed in Arabic and English, light and
/// dark, into docs/design/ios/ (when WARRAQ_SCREENSHOT_DIR says where):
/// search, thumbnails, night, reader, the markup bar, stamps, the
/// signature, pages, crop, export, protect, the outline, go to page, the
/// marks list.
@MainActor
final class PartBScreenshotTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testScreenshots() throws {
        guard let directory = PartBApp.screenshotDirectory else {
            throw XCTSkip("WARRAQ_SCREENSHOT_DIR is not set; scripts/ios/build.sh sets it")
        }
        let device = PartBApp.deviceSlug
        let combos: [(language: String, appearance: String)] = [
            (PartBApp.arabic, "light"), (PartBApp.arabic, "dark"), (PartBApp.english, "light"), (PartBApp.english, "dark"),
        ]
        for combo in combos {
            let suffix = "\(combo.language)-\(combo.appearance)-\(device)"
            let ui = try PartBApp.launch(language: combo.language, appearance: combo.appearance, fixture: PartBApp.outlines)
            ui.waitForPage(containing: "الفصل")
            let app = ui.app

            // Search, with hits.
            app.buttons["document.search"].tap()
            ui.type(combo.language == PartBApp.arabic ? "الفصل" : "PDF", into: "search.field")
            _ = app.buttons["search.count"].waitForExistence(timeout: 20)
            try ui.screenshot("search-\(suffix)", in: directory)
            app.buttons["search.done"].tap()

            // Thumbnails beside or under the pages.
            app.buttons["document.thumbnails.toggle"].tap()
            _ = app.buttons["thumbnail.0"].waitForExistence(timeout: 10)
            try ui.screenshot("thumbnails-\(suffix)", in: directory)
            app.buttons["document.thumbnails.toggle"].tap()

            // Night mode and reader mode.
            ui.viewControl("document.night.toggle", menuLabel: combo.language == PartBApp.arabic ? "الوضع الليلي" : "Night mode")
            try ui.screenshot("night-\(suffix)", in: directory)
            ui.viewControl("document.night.toggle", menuLabel: combo.language == PartBApp.arabic ? "الوضع الليلي" : "Night mode")
            ui.viewControl("document.reader.toggle", menuLabel: combo.language == PartBApp.arabic ? "وضع القراءة" : "Reader mode")
            _ = app.staticTexts.matching(identifier: "reader.text.0").firstMatch.waitForExistence(timeout: 30)
            try ui.screenshot("reader-\(suffix)", in: directory)
            ui.viewControl("document.reader.toggle", menuLabel: combo.language == PartBApp.arabic ? "وضع القراءة" : "Reader mode")

            // The outline and Go to page.
            ui.more("document.outline", label: combo.language == PartBApp.arabic ? "الفهرس" : "Outline")
            _ = app.buttons["outline.0"].waitForExistence(timeout: 15)
            try ui.screenshot("outline-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()
            ui.viewControl("document.goto", menuLabel: combo.language == PartBApp.arabic ? "الانتقال إلى صفحة…" : "Go to page…")
            _ = app.textFields["goto.field"].waitForExistence(timeout: 10)
            try ui.screenshot("goto-\(suffix)", in: directory)
            app.buttons[combo.language == PartBApp.arabic ? "إلغاء" : "Cancel"].firstMatch.tap()

            // Markup: the bar with the highlighter in hand, then the stamps
            // and the signature sheets.
            app.buttons["document.markup"].tap()
            ui.tapMarkup("markup.highlight")
            try ui.screenshot("markup-\(suffix)", in: directory)
            // The pen, with its floating palette.
            ui.tapMarkup("markup.ink")
            _ = app.buttons["pen.color.red"].waitForExistence(timeout: 10)
            try ui.screenshot("pen-\(suffix)", in: directory)
            ui.tapMarkup("markup.stamp")
            _ = app.buttons["stamp.approved"].waitForExistence(timeout: 10)
            try ui.screenshot("stamps-\(suffix)", in: directory)
            let stampsCancel = app.buttons[combo.language == PartBApp.arabic ? "إلغاء" : "Cancel"].firstMatch
            if stampsCancel.exists { stampsCancel.tap() }
            ui.tapMarkup("markup.signature")
            var canvas = ui.signatureCanvas
            if !canvas.waitForExistence(timeout: 8) {
                ui.tapMarkup("markup.signature")
                canvas = ui.signatureCanvas
            }
            if canvas.waitForExistence(timeout: 10) {
                let a = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.6))
                let b = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.4))
                a.press(forDuration: 0.05, thenDragTo: b, withVelocity: .slow, thenHoldForDuration: 0.05)
            }
            try ui.screenshot("signature-\(suffix)", in: directory)
            let cancel = app.buttons[combo.language == PartBApp.arabic ? "إلغاء" : "Cancel"].firstMatch
            if cancel.exists { cancel.tap() }
            app.buttons["markup.done"].tap()

            // The marks list (the corpus file carries a note and a highlight).
            ui.more("document.marks", label: combo.language == PartBApp.arabic ? "العلامات" : "Marks")
            _ = app.buttons["mark.0"].waitForExistence(timeout: 10)
            try ui.screenshot("marks-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()

            // Pages, and crop.
            app.buttons["document.pages"].tap()
            _ = app.buttons["pages.cell.2"].waitForExistence(timeout: 15)
            app.buttons["pages.cell.1"].tap()
            try ui.screenshot("pages-\(suffix)", in: directory)
            app.buttons["pages.more"].firstMatch.tap()
            let crop = app.buttons["pages.crop"]
            if crop.waitForExistence(timeout: 5) {
                crop.tap()
                _ = app.buttons["crop.apply"].waitForExistence(timeout: 10)
                try ui.screenshot("crop-\(suffix)", in: directory)
                app.buttons[combo.language == PartBApp.arabic ? "إلغاء" : "Cancel"].firstMatch.tap()
            }
            app.buttons["pages.done"].tap()

            // Export and protect.
            ui.more("document.export", label: combo.language == PartBApp.arabic ? "تصدير…" : "Export…")
            _ = app.buttons["export.word"].waitForExistence(timeout: 10)
            try ui.screenshot("export-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()
            ui.more("document.protect", label: combo.language == PartBApp.arabic ? "حماية…" : "Protect…")
            _ = app.secureTextFields["protect.password"].waitForExistence(timeout: 10)
            try ui.screenshot("protect-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()
        }
    }
}
