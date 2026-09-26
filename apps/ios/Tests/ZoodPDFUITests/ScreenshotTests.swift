import XCTest

/// Clicks through the real interface on the Simulator and attaches screenshots
/// (exported into docs/design/ios/ by scripts/ios/build.sh). `-ZoodDemo` seeds one generated
/// Arabic sample PDF so Recents and the document view show real content.
final class ScreenshotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testArabicTour() throws {
        try tour(language: "ar", locale: "ar_SA", tag: "ar")
    }

    @MainActor
    func testEnglishTour() throws {
        try tour(language: "en", locale: "en_US", tag: "en")
    }

    @MainActor
    private func tour(language: String, locale: String, tag: String) throws {
        let app = XCUIApplication()
        app.launchArguments += ["-ZoodDemo", "-AppleLanguages", "(\(language))", "-AppleLocale", locale]
        app.launch()

        // Home: hero, six cards, recents.
        XCTAssertTrue(app.buttons["card.open"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["card.scan"].exists)
        snap(app, "01-home-\(tag)")

        // Document view.
        let recent = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'recent.'")).firstMatch
        XCTAssertTrue(recent.waitForExistence(timeout: 20))
        recent.tap()
        XCTAssertTrue(app.descendants(matching: .any)["doc.title"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["doc.annotate"].waitForExistence(timeout: 20))
        snap(app, "02-document-\(tag)")

        // Annotate: floating Pencil palette; draw one stroke; Save.
        app.buttons["doc.annotate"].tap()
        XCTAssertTrue(app.buttons["annotate.pen"].waitForExistence(timeout: 5))
        let canvas = app.otherElements["doc.canvas"].exists ? app.otherElements["doc.canvas"] : app.windows.firstMatch
        let start = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.4))
        start.press(forDuration: 0.05, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.45)))
        snap(app, "03-annotate-\(tag)")
        app.buttons["annotate.done"].tap()
        let save = app.buttons["doc.save"]
        if save.waitForExistence(timeout: 5), save.isEnabled {
            save.tap()
        }

        // Organize sheet.
        app.buttons["doc.tools"].tap()
        let organize = app.buttons["doc.tool.organize"]
        XCTAssertTrue(organize.waitForExistence(timeout: 5))
        organize.tap()
        _ = app.textFields["organize.range"].waitForExistence(timeout: 10)
        snap(app, "04-organize-\(tag)")
        app.terminate()

        // Scan to PDF (dark camera screen with the mode strip) via the deep link.
        app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", locale]
        app.launch()
        XCTAssertTrue(app.buttons["card.scan"].waitForExistence(timeout: 20))
        app.buttons["card.scan"].tap()
        XCTAssertTrue(app.buttons["scan.mode.book"].waitForExistence(timeout: 10))
        app.buttons["scan.mode.book"].tap()
        snap(app, "05-scan-\(tag)")
    }

    @MainActor
    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "\(name).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
