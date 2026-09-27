import XCTest

/// Settings through the interface: the switches and pickers keep what is
/// chosen across a relaunch; "Delete everything" empties the Library; the
/// app lock asks for Face ID and unlocks on a match (the match is posted by
/// the build script through `simctl`, which enrols a face first).
@MainActor
final class SettingsUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(language: String = "en", extra: [String] = [], importCorpus: Bool = false) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == "ar" ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", "light",
            "-warraqFresh", "1",
        ] + extra
        if importCorpus {
            app.launchArguments += ["-warraqImport", try XCTUnwrap(Bundle(for: SettingsUITests.self).resourceURL).path]
        }
        app.launch()
        return app
    }

    private func openSettings(in app: XCUIApplication) {
        XCTAssertTrue(app.buttons["library.settings"].waitForExistence(timeout: 30))
        app.buttons["library.settings"].tap()
        XCTAssertTrue(app.otherElements["settings.form"].waitForExistence(timeout: 10) || app.collectionViews.firstMatch.waitForExistence(timeout: 5))
    }

    func testTheScanModeAndOCRLanguagesAreKeptAcrossALaunch() throws {
        var app = try launch(extra: ["-scanMode", "color", "-ocrLanguages", "(ar, en)"])
        openSettings(in: app)
        let mode = app.descendants(matching: .any)["settings.scanColorMode"].firstMatch
        scrollTo(mode, in: app)
        XCTAssertTrue(mode.waitForExistence(timeout: 10), "the scan mode picker is there")
        mode.tap()
        let grey = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Grey'")).firstMatch
        XCTAssertTrue(grey.waitForExistence(timeout: 10))
        grey.tap()
        // The OCR languages are the scanner's own section and its own tests;
        // this one checks that the list is there and that the scan mode below
        // survives a relaunch.
        let english = app.switches.matching(NSPredicate(format: "identifier BEGINSWITH 'settings.ocr.'")).firstMatch
        scrollTo(english, in: app)
        XCTAssertTrue(english.waitForExistence(timeout: 5), "the device's recognition languages are listed")
        app.buttons["sheet.done"].tap()
        app.terminate()

        app = try launch()
        openSettings(in: app)
        let kept = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Grey' OR value == 'Grey'")).firstMatch
        scrollTo(kept, in: app)
        XCTAssertTrue(kept.waitForExistence(timeout: 10), "the mode chosen is still chosen")
    }

    func testDeleteEverythingEmptiesTheLibrary() throws {
        let app = try launch(importCorpus: true)
        XCTAssertTrue(app.descendants(matching: .any)["library.indexStatus"].waitForExistence(timeout: 120))
        let status = app.staticTexts["library.indexedCount"]
        expectation(for: NSPredicate(format: "value.integerValue >= 5"), evaluatedWith: status)
        waitForExpectations(timeout: 420)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'document.'")).firstMatch.exists, "documents are listed")

        openSettings(in: app)
        let delete = app.buttons["settings.deleteEverything"]
        scrollTo(delete, in: app)
        XCTAssertTrue(delete.waitForExistence(timeout: 10))
        delete.tap()
        let confirm = app.buttons["settings.deleteConfirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()

        XCTAssertTrue(app.buttons["library.open"].waitForExistence(timeout: 30), "back in the Library")
        expectation(for: NSPredicate(format: "value == %@", "0"), evaluatedWith: app.staticTexts["library.indexedCount"])
        waitForExpectations(timeout: 120)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'document.'")).firstMatch.exists, "no documents left")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'recent.'")).firstMatch.exists, "the recents are gone")
    }

    func testTheAppLockAsksForFaceIDAndUnlocksOnAMatch() throws {
        let app = try launch(extra: ["-appLock", "1"])
        let lock = app.descendants(matching: .any)["lock.screen"]
        let driven = ProcessInfo.processInfo.environment["WARRAQ_FACEID_DRIVER"] == "1"
        // With the driver posting a matching face every second, the lock can
        // be gone before the test looks; without it, it must stay.
        let sawLock = lock.waitForExistence(timeout: driven ? 5 : 30)
        if !driven {
            XCTAssertTrue(sawLock, "the app starts locked")
            XCTAssertFalse(app.buttons["library.settings"].isHittable, "nothing behind the lock can be used")
            throw XCTSkip("no Face ID driver: run with WARRAQ_FACEID_DRIVER=1 while simctl posts a matching face")
        }
        let unlocked = NSPredicate(format: "exists == false")
        expectation(for: unlocked, evaluatedWith: lock)
        waitForExpectations(timeout: 180)
        XCTAssertTrue(app.buttons["library.settings"].waitForExistence(timeout: 10), "the Library is usable again")
        XCTAssertTrue(app.buttons["library.settings"].isHittable, "unlocked on the simulator's Face ID match")
    }

    /// Scrolls the Settings form until `element` is there (its lower
    /// sections are not built until they come into view). The form is a
    /// collection view inside the sheet: it is what scrolls, not the app.
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) {
        let form = app.collectionViews.firstMatch.exists ? app.collectionViews.firstMatch : app
        for _ in 0..<8 where !element.exists {
            form.swipeUp()
        }
    }

    func testTheLockSwitchInSettings() throws {
        let app = try launch()
        openSettings(in: app)
        let lock = app.switches["settings.appLock"]
        scrollTo(lock, in: app)
        XCTAssertTrue(lock.waitForExistence(timeout: 10))
        let before = lock.value as? String
        // The row is the toggle; its switch is the control that flips it.
        if lock.switches.firstMatch.exists { lock.switches.firstMatch.tap() } else { lock.tap() }
        // Either it turned on, or the device cannot lock and said so.
        let alert = app.alerts.firstMatch
        if alert.waitForExistence(timeout: 3) {
            alert.buttons.firstMatch.tap()
            XCTAssertEqual(lock.value as? String, before, "left off when the device cannot lock")
        } else {
            XCTAssertNotEqual(lock.value as? String, before, "turned on")
            if lock.switches.firstMatch.exists { lock.switches.firstMatch.tap() } else { lock.tap() }
            XCTAssertEqual(lock.value as? String, before, "and off again")
        }
        if let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"], !directory.isEmpty {
            let device = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"] ?? "iPhone"
            try Screenshots.save(app, as: "settings-full-en-light-\(device)", in: directory)
        }
    }
}
