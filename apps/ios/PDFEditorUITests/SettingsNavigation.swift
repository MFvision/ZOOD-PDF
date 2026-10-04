import XCTest

extension XCUIApplication {
    /// The home's Settings card, the one way into Settings since the
    /// Library's chrome was redesigned (its own Settings button went with
    /// it). On iPad the home is the split view's content column and the
    /// scene can come back showing another section, so Home is chosen in the
    /// sidebar first when the card is not already there.
    @discardableResult
    func homeSettingsCard(timeout: TimeInterval = 30) -> XCUIElement {
        let card = buttons["home.settings"]
        if !card.waitForExistence(timeout: min(timeout, 15)) {
            let home = descendants(matching: .any)["sidebar.home"]
            if home.waitForExistence(timeout: 5) { home.tap() }
        }
        XCTAssertTrue(card.waitForExistence(timeout: timeout), "the home's Settings card")
        // On iPhone the Library's search field floats at the bottom of the
        // home, over the last row of cards. XCUITest taps an element's centre,
        // and the Settings card's centre sits 14 pt above the field, where a
        // touch goes to the floating bar and does nothing (the same touch by
        // hand on the simulator does nothing too; higher on the card it opens
        // Settings). So the home is scrolled until the card is clear of it.
        let field = searchFields.firstMatch
        let home = descendants(matching: .any)["library.home"]
        for _ in 0..<4 where field.exists && home.exists
            && field.frame.minY > card.frame.minY && card.frame.maxY > field.frame.minY - 24 {
            home.swipeUp(velocity: .slow)
        }
        return card
    }
}
