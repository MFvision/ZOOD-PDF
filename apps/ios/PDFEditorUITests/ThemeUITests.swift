import XCTest

/// The themes through the interface: the picker in Settings offers all three,
/// choosing one applies it at once and it is still chosen after a relaunch.
/// The screenshots of each theme — home, Settings and a document, in Arabic
/// and English, light and dark — are taken here, into docs/design/ios/.
@MainActor
final class ThemeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(theme: String? = nil, language: String = "en", appearance: String = "light", fresh: Bool = true) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == "ar" ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", appearance,
        ]
        if fresh { app.launchArguments += ["-warraqFresh", "1"] }
        if let theme { app.launchArguments += ["-theme", theme] }
        app.launch()
        return app
    }

    private func openSettings(in app: XCUIApplication) {
        // The home screen's Settings card. It is the last of the six, so on a
        // phone it starts below the fold: the screen is brought to it before
        // it is asked to take a tap.
        let card = app.buttons["home.settings"]
        XCTAssertTrue(card.waitForExistence(timeout: 30), "the Settings card is on the home screen")
        // The search field sits over the foot of the screen: the card has to
        // be clear of it, not merely on screen, or the tap lands on the field.
        let window = app.windows.firstMatch
        var tries = 0
        while card.frame.maxY > window.frame.maxY - 90, tries < 10 {
            app.swipeUp()
            tries += 1
        }
        XCTAssertTrue(card.isHittable, "the Settings card can be tapped")
        card.tap()
        // Every sheet in the app has Done; it is the one thing that says a
        // sheet is open whatever the sheet is made of.
        XCTAssertTrue(app.buttons["sheet.done"].waitForExistence(timeout: 20), "Settings opened")
    }

    /// The Settings form builds its lower sections as they come into view.
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) {
        let form = app.collectionViews.firstMatch.exists ? app.collectionViews.firstMatch : app
        for _ in 0..<8 where !element.exists { form.swipeUp() }
    }

    // MARK: - Choosing a theme

    func testTheThemePickerOffersTheThreeAndTheChoiceSurvivesARelaunch() throws {
        var app = launch()
        openSettings(in: app)
        let picker = app.descendants(matching: .any)["settings.theme"].firstMatch
        scrollTo(picker, in: app)
        XCTAssertTrue(picker.waitForExistence(timeout: 10), "the theme picker is in Settings")
        picker.tap()
        for name in ["System", "Liquid Glass", "Zood"] {
            XCTAssertTrue(
                app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch.waitForExistence(timeout: 10),
                "the picker offers \(name)"
            )
        }
        app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Zood'")).firstMatch.tap()
        let chosen = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Zood' OR value == 'Zood'")).firstMatch
        XCTAssertTrue(chosen.waitForExistence(timeout: 10), "Zood is the chosen theme")
        app.buttons["sheet.done"].tap()
        app.terminate()

        // Launched again with nothing on the command line, it is still Zood.
        app = launch(fresh: false)
        openSettings(in: app)
        let kept = app.descendants(matching: .any)["settings.theme"].firstMatch
        scrollTo(kept, in: app)
        XCTAssertTrue(kept.waitForExistence(timeout: 10))
        let stillZood = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Zood' OR value == 'Zood'")).firstMatch
        XCTAssertTrue(stillZood.waitForExistence(timeout: 10), "the theme chosen is still chosen after a relaunch")
    }

    func testAThemeChosenInSettingsAppliesToTheHomeScreenAtOnce() throws {
        // No `-theme` on the command line: a launch argument lands in
        // UserDefaults' argument domain, which wins over what the app writes,
        // so a theme pinned there could never be changed from Settings.
        let app = launch()
        openSettings(in: app)
        let picker = app.descendants(matching: .any)["settings.theme"].firstMatch
        scrollTo(picker, in: app)
        XCTAssertTrue(picker.waitForExistence(timeout: 10))
        picker.tap()
        let item = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Liquid Glass'")).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 15), "the picker's menu opened")
        item.tap()
        let chosen = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Liquid Glass' OR value == 'Liquid Glass'")).firstMatch
        XCTAssertTrue(chosen.waitForExistence(timeout: 15), "the picker now reads Liquid Glass")
        // The footer under it says what that theme is doing on this system.
        let footer = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Glass chrome'")).firstMatch
        XCTAssertTrue(footer.waitForExistence(timeout: 15), "Settings says what the chosen theme does")
        app.buttons["sheet.done"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["library.home"].firstMatch.waitForExistence(timeout: 15), "back on the home screen, drawn in the new theme")
    }

    // MARK: - The screenshots

    func testScreenshotsOfEachTheme() throws {
        guard let directory = PartBApp.screenshotDirectory else {
            throw XCTSkip("WARRAQ_SCREENSHOT_DIR is not set; scripts/ios/build.sh sets it")
        }
        let device = PartBApp.deviceSlug
        let combos: [(theme: String, language: String, appearance: String)] = [
            ("glass", "en", "light"), ("glass", "ar", "dark"),
            ("zood", "ar", "light"), ("zood", "en", "dark"),
        ]
        for combo in combos {
            let suffix = "\(combo.theme)-\(combo.language)-\(combo.appearance)-\(device)"

            // The home screen: the ground, the cards and the mark.
            let app = launch(theme: combo.theme, language: combo.language, appearance: combo.appearance)
            XCTAssertTrue(app.descendants(matching: .any)["library.home"].firstMatch.waitForExistence(timeout: 40), "the home screen")
            try Screenshots.save(app, as: "theme-home-\(suffix)", in: directory)

            // Settings, where the theme is chosen, on the same ground.
            openSettings(in: app)
            let picker = app.descendants(matching: .any)["settings.theme"].firstMatch
            scrollTo(picker, in: app)
            XCTAssertTrue(picker.waitForExistence(timeout: 15))
            try Screenshots.save(app, as: "theme-settings-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()
            app.terminate()

            // A document open, with the markup bar out: the chrome in the theme.
            let file = try PartBApp.copyFixture(PartBApp.outlines)
            let reader = try PartBApp.launch(
                language: combo.language, appearance: combo.appearance, file: file,
                arguments: ["-theme", combo.theme]
            )
            reader.waitForPage(containing: "الفصل")
            reader.app.buttons["document.markup"].tap()
            reader.tapMarkup("markup.ink")
            _ = reader.app.buttons["pen.color.red"].waitForExistence(timeout: 15)
            try reader.screenshot("theme-document-\(suffix)", in: directory)
            reader.app.terminate()
        }
    }
}
