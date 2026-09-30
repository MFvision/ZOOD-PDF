import UIKit
import XCTest

/// The welcome tour through the interface: shown on the first run, skippable,
/// walked through, remembered so it does not come back, and opened again from
/// Settings. In Debug builds the tour stays out of the way unless a test asks
/// for it (`-warraqOnboarding show` starts it over, `keep` lets the kept answer
/// decide), so every other UI test still launches into the Library.
@MainActor
final class OnboardingUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(_ onboarding: String, language: String = "en", appearance: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == "ar" ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", appearance,
            "-warraqOnboarding", onboarding,
        ]
        app.launch()
        return app
    }


    func testTheTourIsShownAndCanBeSkipped() throws {
        let app = launch("show")
        XCTAssertTrue(app.descendants(matching: .any)["onboarding"].waitForExistence(timeout: 30),
                      "the tour is the first thing on the first run")
        XCTAssertTrue(app.descendants(matching: .any)["onboarding.page.0"].exists)
        app.buttons["onboarding.skip"].tap()
        XCTAssertTrue(app.buttons["library.scan"].waitForExistence(timeout: 20), "skipping lands in the Library")

        // Skipping counts as seen: it does not come back.
        let again = launch("keep")
        XCTAssertTrue(again.buttons["library.scan"].waitForExistence(timeout: 30))
        XCTAssertFalse(again.descendants(matching: .any)["onboarding"].exists, "the tour is shown once")
    }

    func testTheTourIsWalkedThroughRememberedAndFoundAgainInSettings() throws {
        let app = launch("show")
        XCTAssertTrue(app.descendants(matching: .any)["onboarding"].waitForExistence(timeout: 30))
        // Four screens: Next three times, then Start.
        for page in 0..<3 {
            XCTAssertTrue(app.descendants(matching: .any)["onboarding.page.\(page)"].waitForExistence(timeout: 10),
                          "screen \(page + 1)")
            XCTAssertTrue(app.buttons["onboarding.next"].exists, "screen \(page + 1) has Next")
            app.buttons["onboarding.next"].tap()
        }
        XCTAssertTrue(app.descendants(matching: .any)["onboarding.page.3"].waitForExistence(timeout: 10))
        let done = app.buttons["onboarding.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10), "the last screen finishes rather than going on")
        done.tap()
        XCTAssertTrue(app.buttons["library.scan"].waitForExistence(timeout: 20))

        let again = launch("keep")
        XCTAssertTrue(again.buttons["library.scan"].waitForExistence(timeout: 30), "the Library came up")
        XCTAssertFalse(again.descendants(matching: .any)["onboarding"].exists, "finished means finished")

        // And Settings brings it back for anyone who wants it again: the
        // home's Settings card. On iPad the home is the split view's content
        // column, and the scene can come back showing another section, so Home
        // is chosen in the sidebar first when the card is not already there.
        let settings = again.buttons["home.settings"]
        if !settings.waitForExistence(timeout: 15) {
            let home = again.descendants(matching: .any)["sidebar.home"]
            if home.waitForExistence(timeout: 5) { home.tap() }
        }
        XCTAssertTrue(settings.waitForExistence(timeout: 20), "the home's Settings card")
        settings.tap()
        XCTAssertTrue(again.descendants(matching: .any)["settings.form"].waitForExistence(timeout: 20), "Settings opened")
        let entry = again.buttons["settings.onboarding"]
        if !entry.waitForExistence(timeout: 10) {
            // A row below the fold on a phone: a list makes its rows as they
            // scroll in, as the scanner's own tests note.
            again.swipeUp()
        }
        XCTAssertTrue(entry.waitForExistence(timeout: 20), "Settings offers the tour")
        entry.tap()
        XCTAssertTrue(again.descendants(matching: .any)["onboarding"].waitForExistence(timeout: 20))
        again.buttons["onboarding.skip"].tap()
        XCTAssertTrue(again.descendants(matching: .any)["settings.form"].waitForExistence(timeout: 20), "back in Settings")
    }

    /// Arabic: the tour reads in Arabic and lays out right to left.
    func testTheTourIsArabicAndRightToLeft() throws {
        let app = launch("show", language: "ar")
        XCTAssertTrue(app.descendants(matching: .any)["onboarding"].waitForExistence(timeout: 30))
        let skip = app.buttons["onboarding.skip"]
        XCTAssertTrue(skip.exists)
        XCTAssertEqual(skip.label, "تخطّي", "the tour's own words are Arabic")
        // Right to left: Skip sits at the leading edge, which in Arabic is the
        // right-hand side of the screen.
        let window = app.windows.firstMatch.frame
        XCTAssertGreaterThan(skip.frame.midX, window.midX, "Skip is on the right in Arabic")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'أهلًا بك'")).firstMatch.exists,
                      "the first screen greets in Arabic")
        app.buttons["onboarding.skip"].tap()
        XCTAssertTrue(app.buttons["library.scan"].waitForExistence(timeout: 20))
    }

    /// The tour's screens, photographed for the design record.
    func testOnboardingScreenshots() throws {
        guard let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"], !directory.isEmpty else {
            throw XCTSkip("WARRAQ_SCREENSHOT_DIR is not set; scripts/ios/build.sh sets it")
        }
        let device = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"]
            ?? (UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")
        for (language, appearance) in [("ar", "light"), ("en", "dark")] {
            let app = launch("show", language: language, appearance: appearance)
            XCTAssertTrue(app.descendants(matching: .any)["onboarding"].waitForExistence(timeout: 30))
            for page in 0..<4 {
                XCTAssertTrue(app.descendants(matching: .any)["onboarding.page.\(page)"].waitForExistence(timeout: 10))
                try save(as: "onboarding-\(page + 1)-\(language)-\(appearance)-\(device)", in: directory)
                if page < 3 { app.buttons["onboarding.next"].tap() }
            }
            app.buttons["onboarding.done"].tap()
        }
    }

    /// The screen at half size as a JPEG, as the other screenshot tests do.
    private func save(as name: String, in directory: String) throws {
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
