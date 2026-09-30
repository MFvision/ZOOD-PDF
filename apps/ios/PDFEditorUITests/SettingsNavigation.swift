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
        return card
    }
}
