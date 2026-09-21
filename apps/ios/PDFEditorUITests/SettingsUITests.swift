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
        let mode = app.descendants(matching: .any)["settings.scanMode"].firstMatch
        XCTAssertTrue(mode.waitForExistence(timeout: 10), "the scan mode picker is there")
        mode.tap()
        let grey = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Grey'")).firstMatch
        XCTAssertTrue(grey.waitForExistence(timeout: 10))
        grey.tap()
        // An OCR language switch, if this device can read more than one.
        let english = app.switches["settings.ocr.en"]
        if english.waitForExistence(timeout: 5) {
            let before = english.value as? String
            english.tap()
            XCTAssertNotEqual(english.value as? String, before, "the switch flipped")
        }
        app.buttons["sheet.done"].tap()
        app.terminate()

        app = try launch()
        openSettings(in: app)
        XCTAssertTrue(app.staticTexts["Grey"].firstMatch.waitForExistence(timeout: 10), "the mode chosen is still chosen")
    }

    func testDeleteEverythingEmptiesTheLibrary() throws {
        let app = try launch(importCorpus: true)
        let status = app.staticTexts["library.indexedCount"]
        XCTAssertTrue(status.waitForExistence(timeout: 60))
        expectation(for: NSPredicate(format: "value.integerValue >= 5"), evaluatedWith: status)
        waitForExpectations(timeout: 240)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'document.'")).firstMatch.exists, "documents are listed")

        openSettings(in: app)
        let delete = app.buttons["settings.deleteEverything"]
        XCTAssertTrue(delete.waitForExistence(timeout: 10))
        delete.tap()
        let confirm = app.buttons["settings.deleteConfirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()

        XCTAssertTrue(app.buttons["library.open"].waitForExistence(timeout: 30), "back in the Library")
        expectation(for: NSPredicate(format: "value == %@", "0"), evaluatedWith: app.staticTexts["library.indexedCount"])
        waitForExpectations(timeout: 60)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'document.'")).firstMatch.exists, "no documents left")
        XCTAssertNil(AppGroupProbe.container.flatMap { try? Data(contentsOf: $0.appending(path: "recents.json")) }.flatMap { data in
            (try? JSONSerialization.jsonObject(with: data) as? [Any])?.first
        }, "the recents are gone")
    }

    func testTheAppLockAsksForFaceIDAndUnlocksOnAMatch() throws {
        let app = try launch(extra: ["-appLock", "1"])
        let lock = app.otherElements["lock.screen"]
        XCTAssertTrue(lock.waitForExistence(timeout: 30), "the app starts locked")
        XCTAssertFalse(app.buttons["library.settings"].isHittable, "nothing behind the lock can be used")
        guard ProcessInfo.processInfo.environment["WARRAQ_FACEID_DRIVER"] == "1" else {
            throw XCTSkip("no Face ID driver: run with WARRAQ_FACEID_DRIVER=1 while simctl posts a matching face")
        }
        // The driver posts com.apple.BiometricKit_Sim.pearl.match every second.
        let unlocked = NSPredicate(format: "exists == false")
        expectation(for: unlocked, evaluatedWith: lock)
        waitForExpectations(timeout: 90)
        XCTAssertTrue(app.buttons["library.settings"].waitForExistence(timeout: 10), "the Library is usable again")
    }

    func testTheLockSwitchInSettings() throws {
        let app = try launch()
        openSettings(in: app)
        let lock = app.switches["settings.appLock"]
        XCTAssertTrue(lock.waitForExistence(timeout: 10))
        let before = lock.value as? String
        lock.tap()
        // Either it turned on, or the device cannot lock and said so.
        let alert = app.alerts.firstMatch
        if alert.waitForExistence(timeout: 3) {
            alert.buttons.firstMatch.tap()
            XCTAssertEqual(lock.value as? String, before, "left off when the device cannot lock")
        } else {
            XCTAssertNotEqual(lock.value as? String, before, "turned on")
            lock.tap()
            XCTAssertEqual(lock.value as? String, before, "and off again")
        }
        if let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"], !directory.isEmpty {
            let device = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"] ?? "iPhone"
            try Screenshots.save(app, as: "settings-full-en-light-\(device)", in: directory)
        }
    }
}
