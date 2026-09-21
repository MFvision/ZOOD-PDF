import XCTest

/// The widgets as the simulator's Home Screen shows them: SpringBoard's
/// widget gallery, searched for the app, photographed into
/// docs/design/ios/. The gallery's own controls change between iOS
/// releases, so every step that cannot be found skips with a message
/// rather than pretending; a picture is only claimed when it was taken.
@MainActor
final class WidgetGalleryUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testWidgetGalleryScreenshots() throws {
        guard let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"], !directory.isEmpty else {
            throw XCTSkip("WARRAQ_SCREENSHOT_DIR is not set; scripts/ios/build.sh sets it")
        }
        let device = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"]
            ?? (UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")

        // The app first, so the recents list has a document with a thumbnail.
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-language", "en", "-appearance", "light",
                               "-warraqImport", try XCTUnwrap(Bundle(for: WidgetGalleryUITests.self).resourceURL).path]
        app.launch()
        let status = app.staticTexts["library.indexedCount"]
        XCTAssertTrue(status.waitForExistence(timeout: 60))
        expectation(for: NSPredicate(format: "value.integerValue >= 5"), evaluatedWith: status)
        waitForExpectations(timeout: 240)
        let cell = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'document.'")).firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 10))
        cell.tap()
        XCTAssertTrue(app.otherElements["document.page"].waitForExistence(timeout: 30))
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 1.5))

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCUIDevice.shared.press(.home)
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 1.0))
        springboard.activate()

        // Jiggle mode, then the gallery: the Edit menu (iOS 18+) or the "+" (older).
        let home = springboard.otherElements["Home screen icons"].firstMatch
        let target = home.exists ? home : springboard
        target.press(forDuration: 1.6)
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 1.0))
        if springboard.buttons["Edit Home Screen"].waitForExistence(timeout: 3) {
            springboard.buttons["Edit Home Screen"].tap()
        }
        var opened = false
        for title in ["Add Widget", "Add widget", "Add Widgets"] {
            let button = springboard.buttons[title]
            if button.waitForExistence(timeout: 3) {
                button.tap()
                opened = true
                break
            }
        }
        if !opened {
            let edit = springboard.buttons["Edit"].firstMatch
            if edit.waitForExistence(timeout: 3) {
                edit.tap()
                for title in ["Add Widget", "Add widget"] {
                    let button = springboard.buttons[title]
                    if button.waitForExistence(timeout: 3) {
                        button.tap()
                        opened = true
                        break
                    }
                }
            }
        }
        guard opened else {
            try Screenshots.save(springboard, as: "widgets-home-\(device)", in: directory)
            leaveJiggle(springboard)
            throw XCTSkip("SpringBoard's widget gallery could not be opened on this simulator; the Home Screen was photographed instead")
        }

        let search = springboard.searchFields.firstMatch
        guard search.waitForExistence(timeout: 10) else {
            try Screenshots.save(springboard, as: "widgets-gallery-\(device)", in: directory)
            leaveJiggle(springboard)
            throw XCTSkip("the widget gallery has no search field here; it was photographed as it opened")
        }
        search.tap()
        search.typeText("PDF")
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 1.0))
        let entry = springboard.staticTexts["محرر PDF"].firstMatch
        if entry.waitForExistence(timeout: 5) {
            entry.tap()
        } else {
            let anyCell = springboard.cells.firstMatch
            if anyCell.waitForExistence(timeout: 5) { anyCell.tap() }
        }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 2.0))
        try Screenshots.save(springboard, as: "widgets-gallery-1-\(device)", in: directory)
        // The families, one swipe each.
        for i in 2...4 {
            springboard.swipeLeft()
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 1.2))
            try Screenshots.save(springboard, as: "widgets-gallery-\(i)-\(device)", in: directory)
        }
        // Close the gallery and leave jiggle mode.
        for title in ["Cancel", "Done", "Close"] {
            let button = springboard.buttons[title].firstMatch
            if button.exists { button.tap(); break }
        }
        leaveJiggle(springboard)
    }

    private func leaveJiggle(_ springboard: XCUIApplication) {
        let done = springboard.buttons["Done"].firstMatch
        if done.waitForExistence(timeout: 3) { done.tap() }
        XCUIDevice.shared.press(.home)
    }
}
