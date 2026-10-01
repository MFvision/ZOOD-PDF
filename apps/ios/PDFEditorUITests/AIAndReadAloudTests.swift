import UIKit
import XCTest

/// Through the interface, on the simulator: the AI panel over an Arabic
/// form (a Debug run with the fake engine, since Apple's model is checked
/// separately and may not be on this simulator), a summary answered, the
/// form filled from the profile after review, read-aloud started with its
/// bar and the sentence being read, and the Settings sections for both —
/// photographed in Arabic and English, iPhone and iPad.
@MainActor
final class AIAndReadAloudTests: XCTestCase {
    private static let form = Bundle(for: AIAndReadAloudTests.self).url(forResource: "acroform-pdflib-arabic-fields", withExtension: "pdf")
    private static let invoice = Bundle(for: AIAndReadAloudTests.self).url(forResource: "coretext-sfarabic-mixed-invoice", withExtension: "pdf")

    /// The profile a test seeds (Debug builds read `-warraqProfileJSON`).
    private static let profileJSON = #"{"nameArabic":"محمد الغماس","nameEnglish":"Mohammed Alghammas","nationalID":"1234567890","email":"m@example.com","phone":"0500000000"}"#

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(language: String, appearance: String = "light", open file: URL?, fakeAI: Bool = true, profile: Bool = true) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == "ar" ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", appearance,
            "-warraqReset", "1",
        ]
        if fakeAI { app.launchArguments += ["-warraqFakeAI", "1"] }
        app.launchArguments += ["-warraqProfileJSON", profile ? Self.profileJSON : ""]
        if let file {
            app.launchArguments += ["-warraqOpen", file.path]
        }
        app.launch()
        return app
    }

    private func waitForPage(in app: XCUIApplication, containing word: String) {
        let page = app.otherElements["document.page"]
        XCTAssertTrue(page.waitForExistence(timeout: 30), "the page view appears")
        expectation(for: NSPredicate(format: "value CONTAINS %@", word), evaluatedWith: page)
        waitForExpectations(timeout: 30)
    }

    func testSummarizesThroughTheFakeEngineAndSaysWhatItRead() throws {
        let app = try launch(language: "ar", open: try XCTUnwrap(Self.invoice))
        waitForPage(in: app, containing: "فاتورة")
        XCTAssertTrue(app.buttons["document.ai"].waitForExistence(timeout: 10), "the AI button is there with the (fake) engine")
        app.buttons["document.ai"].tap()
        XCTAssertTrue(app.buttons["ai.run"].waitForExistence(timeout: 10), "the AI sheet is up")
        app.buttons["ai.run"].tap()
        let answer = app.staticTexts["ai.answer"]
        XCTAssertTrue(answer.waitForExistence(timeout: 30), "an answer appears")
        XCTAssertTrue(answer.label.hasPrefix("[fake]"), answer.label)
        XCTAssertTrue(answer.label.contains("فاتورة"), "the document's text went in: \(answer.label)")
        XCTAssertTrue(app.staticTexts["ai.context"].waitForExistence(timeout: 5), "it says what it read")
        app.buttons["sheet.done"].tap()
    }

    func testFillsTheArabicFormFromTheProfileAfterReview() throws {
        let app = try launch(language: "ar", open: try XCTUnwrap(Self.form))
        waitForPage(in: app, containing: "الاسم")
        app.buttons["document.ai"].tap()
        XCTAssertTrue(app.buttons["ai.autofill"].waitForExistence(timeout: 10))
        app.buttons["ai.autofill"].tap()
        XCTAssertTrue(app.buttons["autofill.fill"].waitForExistence(timeout: 30), "proposals are listed with a Fill button")
        let nameValue = app.textFields["autofill.value.الاسم الكامل"]
        XCTAssertTrue(nameValue.waitForExistence(timeout: 5))
        XCTAssertEqual(nameValue.value as? String, "محمد الغماس")
        // One field left out: nothing is written for it.
        let emailToggle = app.switches["autofill.accept.البريد الإلكتروني"]
        if emailToggle.exists {
            emailToggle.tap()
        }
        app.buttons["autofill.fill"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["autofill.done"].waitForExistence(timeout: 30), "the fields are written")
        app.buttons["sheet.done"].tap()
        // The document is now edited (Save appears) and the page's text
        // carries the value, drawn shaped by the core.
        XCTAssertTrue(app.buttons["document.save"].waitForExistence(timeout: 10), "there is something to save")
        waitForPage(in: app, containing: "محمد الغماس")
    }

    func testWithoutAnEngineThereIsNoAIButtonAndSettingsSaysWhy() throws {
        let app = try launch(language: "en", open: try XCTUnwrap(Self.invoice), fakeAI: false)
        waitForPage(in: app, containing: "فاتورة")
        XCTAssertTrue(app.buttons["document.readAloud"].waitForExistence(timeout: 10), "read-aloud does not need the model")
        // Whether the AI button shows depends on Apple's model being on
        // this simulator; Settings states the answer either way.
        let hasAI = app.buttons["document.ai"].waitForExistence(timeout: 3)
        showLibrary(in: app)
        app.buttons["library.settings"].tap()
        XCTAssertTrue(app.buttons["sheet.done"].waitForExistence(timeout: 10))
        let status = app.descendants(matching: .any)["settings.ai.status"]
        let reason = app.descendants(matching: .any)["settings.ai.reason"]
        XCTAssertTrue(status.waitForExistence(timeout: 10) || reason.waitForExistence(timeout: 5))
        let said = (status.exists ? status.label : "") + " | " + (reason.exists ? reason.label : "")
        print("WARRAQ_AI_SETTINGS: hasAIButton=\(hasAI) — \(said)")
        if hasAI {
            XCTAssertTrue(said.contains("Available"), said)
        } else {
            XCTAssertTrue(said.contains("Not available") || said.contains("not available") || said.contains("needs iOS 26"), said)
        }
    }

    func testReadsAloudWithTheBarAndTheSentence() throws {
        let app = try launch(language: "ar", open: try XCTUnwrap(Self.invoice), fakeAI: false)
        waitForPage(in: app, containing: "فاتورة")
        app.buttons["document.readAloud"].tap()
        let bar = app.otherElements["readAloud.bar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 20), "the read-aloud bar appears")
        let sentence = app.staticTexts["readAloud.sentence"]
        XCTAssertTrue(sentence.waitForExistence(timeout: 20))
        expectation(for: NSPredicate(format: "label != %@ AND label != ''", "جارٍ القراءة…"), evaluatedWith: sentence)
        waitForExpectations(timeout: 20)
        let first = sentence.label
        XCTAssertFalse(first.isEmpty)
        app.buttons["readAloud.next"].tap()
        expectation(for: NSPredicate(format: "label != %@", first), evaluatedWith: sentence)
        waitForExpectations(timeout: 10)
        app.buttons["readAloud.playPause"].tap()
        XCTAssertTrue(app.buttons["readAloud.stop"].exists)
        app.buttons["readAloud.stop"].tap()
        XCTAssertTrue(bar.waitForNonExistence(timeout: 10), "the bar goes away on Stop")
    }

    func testScreenshots() throws {
        guard let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"], !directory.isEmpty else {
            throw XCTSkip("WARRAQ_SCREENSHOT_DIR is not set; scripts/ios/build.sh sets it")
        }
        let device = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"]
            ?? (UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")
        for (language, appearance) in [("ar", "light"), ("en", "dark")] {
            let suffix = "\(language)-\(appearance)-\(device)"
            // The AI panel with a summary, then the autofill review.
            var app = try launch(language: language, appearance: appearance, open: try XCTUnwrap(Self.form))
            waitForPage(in: app, containing: "الاسم")
            app.buttons["document.ai"].tap()
            XCTAssertTrue(app.buttons["ai.run"].waitForExistence(timeout: 10))
            app.buttons["ai.run"].tap()
            XCTAssertTrue(app.staticTexts["ai.answer"].waitForExistence(timeout: 30))
            try save(app, as: "ai-\(suffix)", in: directory)
            app.buttons["ai.autofill"].tap()
            XCTAssertTrue(app.buttons["autofill.fill"].waitForExistence(timeout: 30))
            try save(app, as: "autofill-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()

            // Read-aloud over the invoice.
            app = try launch(language: language, appearance: appearance, open: try XCTUnwrap(Self.invoice))
            waitForPage(in: app, containing: "فاتورة")
            app.buttons["document.readAloud"].tap()
            let sentence = app.staticTexts["readAloud.sentence"]
            XCTAssertTrue(sentence.waitForExistence(timeout: 20))
            expectation(for: NSPredicate(format: "label != %@ AND label != ''", "جارٍ القراءة…"), evaluatedWith: sentence)
            waitForExpectations(timeout: 20)
            app.buttons["readAloud.playPause"].tap()
            try save(app, as: "readaloud-\(suffix)", in: directory)
            app.buttons["readAloud.stop"].tap()

            // Settings: the AI and read-aloud sections, then the profile.
            showLibrary(in: app)
            app.buttons["library.settings"].tap()
            XCTAssertTrue(app.buttons["settings.ai.profile"].waitForExistence(timeout: 10))
            app.swipeUp()
            try save(app, as: "settings-ai-\(suffix)", in: directory)
            app.buttons["settings.ai.profile"].tap()
            XCTAssertTrue(app.textFields["profile.nameArabic"].waitForExistence(timeout: 10))
            try save(app, as: "profile-\(suffix)", in: directory)
        }
    }

    /// On iPhone a document covers the Library: go back to it.
    private func showLibrary(in app: XCUIApplication) {
        if !app.buttons["library.settings"].exists {
            let notOurs = NSPredicate(format: "NOT (identifier IN {'document.info', 'document.share', 'document.save', 'document.ai', 'document.readAloud'})")
            let back = app.navigationBars.buttons.matching(notOurs).firstMatch
            if back.waitForExistence(timeout: 5) {
                back.tap()
            }
        }
        XCTAssertTrue(app.buttons["library.settings"].waitForExistence(timeout: 10))
    }

    private func save(_ app: XCUIApplication, as name: String, in directory: String) throws {
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
