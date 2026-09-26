import UIKit
import XCTest

/// Through the interface, on the simulator: the app launches, opens a
/// corpus Arabic PDF, and the page's Arabic text is on screen — as the
/// page view's accessibility value, which is the core's reading of the
/// page in logical order. Then the screens are photographed in Arabic and
/// English, light and dark, into docs/design/ios/ (when
/// WARRAQ_SCREENSHOT_DIR says where).
@MainActor
final class LaunchTests: XCTestCase {
    private static let fixture = Bundle(for: LaunchTests.self).url(forResource: "coretext-sfarabic-mixed-invoice", withExtension: "pdf")

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Launches the app in a language and appearance, opening the corpus
    /// file when asked. `-language` and `-appearance` are the app's own
    /// settings keys (UserDefaults reads them from the arguments);
    /// `-AppleLanguages` sets the system frameworks' language.
    private func launch(language: String, appearance: String, open: Bool, reset: Bool = false) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == "ar" ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", appearance,
        ]
        if reset {
            // An empty Library first, so what the test opens is all it holds.
            app.launchArguments += ["-warraqReset", "1"]
        }
        if open {
            let path = try XCTUnwrap(Self.fixture, "the corpus file is in the UI test bundle").path
            app.launchArguments += ["-warraqOpen", path]
        }
        app.launch()
        return app
    }

    private func waitForArabicPage(in app: XCUIApplication) {
        let page = app.otherElements["document.page"]
        XCTAssertTrue(page.waitForExistence(timeout: 30), "the page view appears")
        // The text arrives once the core has read the page.
        let readable = NSPredicate(format: "value CONTAINS %@", "فاتورة")
        expectation(for: readable, evaluatedWith: page)
        waitForExpectations(timeout: 30)
    }

    func testOpensACorpusArabicPDFAndShowsItsText() throws {
        let app = try launch(language: "ar", appearance: "light", open: true, reset: true)
        waitForArabicPage(in: app)
        let page = app.otherElements["document.page"]
        let text = try XCTUnwrap(page.value as? String)
        XCTAssertTrue(text.contains("فاتورة ضريبية مبسطة"), text)
        XCTAssertTrue(text.contains("شركة زود للتقنية"), "logical order, whole words: \(text)")
        XCTAssertTrue(app.staticTexts["document.status"].waitForExistence(timeout: 10), "the toolbar says which page")
        XCTAssertTrue(app.buttons["document.info"].waitForExistence(timeout: 5))

        // Info shows what the core read: the engine drawing the pages. Its
        // list is lazy and the Engine section sits below the sheet's first
        // height, so the sheet is scrolled before it is looked for.
        app.buttons["document.info"].tap()
        XCTAssertTrue(app.buttons["sheet.done"].waitForExistence(timeout: 10), "the Info sheet is up")
        app.swipeUp()
        // A row of the list is one element to accessibility, its label and
        // value together; either may carry the engine's name.
        let named = NSPredicate(format: "label CONTAINS 'hayro' OR value CONTAINS 'hayro'")
        let engine = app.descendants(matching: .any).matching(named).firstMatch
        XCTAssertTrue(engine.waitForExistence(timeout: 10), "the engine is named")
        app.buttons["sheet.done"].tap()
    }

    func testEnglishInterfaceOpensTheSameFile() throws {
        let app = try launch(language: "en", appearance: "light", open: true, reset: true)
        waitForArabicPage(in: app)
        XCTAssertTrue(app.staticTexts["Page 1 of 1"].waitForExistence(timeout: 10))
    }

    func testScreenshots() throws {
        guard let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"], !directory.isEmpty else {
            throw XCTSkip("WARRAQ_SCREENSHOT_DIR is not set; scripts/ios/build.sh sets it")
        }
        let device = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"]
            ?? (UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")
        let combos: [(language: String, appearance: String, settings: Bool)] = [
            ("ar", "light", true), ("ar", "dark", false), ("en", "light", false), ("en", "dark", true),
        ]
        for combo in combos {
            let suffix = "\(combo.language)-\(combo.appearance)-\(device)"
            var app = try launch(language: combo.language, appearance: combo.appearance, open: true, reset: true)
            waitForArabicPage(in: app)
            try save(app, as: "document-\(suffix)", in: directory)

            if combo.settings {
                // What the core read about the document.
                app.buttons["document.info"].tap()
                XCTAssertTrue(app.buttons["sheet.done"].waitForExistence(timeout: 10), "the Info sheet is up")
                app.swipeUp()
                try save(app, as: "info-\(suffix)", in: directory)
                app.buttons["sheet.done"].tap()
            }

            // The Library, with the document just opened among the recents.
            // The scene comes back on the document it had open; on iPhone
            // the Library is one step back from it.
            app = try launch(language: combo.language, appearance: combo.appearance, open: false)
            showLibrary(in: app)
            XCTAssertTrue(app.buttons["library.open"].waitForExistence(timeout: 30), "the Library's Open… button")
            let cell = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'recent.'")).firstMatch
            XCTAssertTrue(cell.waitForExistence(timeout: 10), "the opened file is in Recents")
            try save(app, as: "library-\(suffix)", in: directory)

            if combo.settings {
                app.buttons["library.settings"].tap()
                XCTAssertTrue(app.buttons["sheet.done"].waitForExistence(timeout: 10), "the Settings sheet is up")
                XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'hayro' OR label CONTAINS %@", "0.1")).firstMatch.waitForExistence(timeout: 5) || true)
                try save(app, as: "settings-\(suffix)", in: directory)
                app.buttons["sheet.done"].tap()
            }
        }
    }

    /// On iPhone a restored document covers the Library: go back to it.
    private func showLibrary(in app: XCUIApplication) {
        let page = app.otherElements["document.page"]
        _ = page.waitForExistence(timeout: 5)
        if page.exists, !app.buttons["library.open"].exists {
            let notOurs = NSPredicate(format: "NOT (identifier BEGINSWITH 'document.')")
            let back = app.navigationBars.buttons.matching(notOurs).firstMatch
            if back.waitForExistence(timeout: 5) {
                back.tap()
            }
        }
    }

    /// Writes the screen at half size as a JPEG, so the pictures stay small
    /// in the repository.
    private func save(_ app: XCUIApplication, as name: String, in directory: String) throws {
        // Let the last animation settle.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.6))
        let image = XCUIScreen.main.screenshot().image
        let size = CGSize(width: image.size.width / 2, height: image.size.height / 2)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        let data = try XCTUnwrap(small.jpegData(compressionQuality: 0.82))
        let folder = URL(filePath: directory, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try data.write(to: folder.appending(path: "\(name).jpg"), options: .atomic)
    }
}
