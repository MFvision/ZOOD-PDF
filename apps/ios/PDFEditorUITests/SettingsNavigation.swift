import XCTest

extension XCUIApplication {
    /// One of the home's cards, brought to where a tap reaches it. The cards
    /// are a lazy grid, so one below the screen is not made until the home is
    /// scrolled to it; and on iPhone the Library's search field floats over
    /// the foot of the screen, where a tap on a card under it goes to the
    /// field and does nothing. So the home is scrolled until the card exists
    /// and is clear of the field. On iPad the home is the split view's
    /// content column and the scene can come back showing another section,
    /// so Home is chosen in the sidebar first when no card is there.
    @discardableResult
    func homeCard(_ identifier: String, timeout: TimeInterval = 30) -> XCUIElement {
        let card = buttons[identifier]
        if !buttons["home.open"].waitForExistence(timeout: min(timeout, 15)) {
            let home = descendants(matching: .any)["sidebar.home"]
            if home.waitForExistence(timeout: 5) { home.tap() }
        }
        let field = searchFields.firstMatch
        for _ in 0..<8 {
            if card.exists, !field.exists || card.frame.maxY < field.frame.minY - 8 { break }
            // A short drag in the middle of the screen: a full swipe would
            // carry a card past the top as easily as bring it up.
            let from = coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62))
            let to = coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.38))
            from.press(forDuration: 0.05, thenDragTo: to)
        }
        XCTAssertTrue(card.waitForExistence(timeout: timeout), "the home's \(identifier) card")
        return card
    }

    /// The home's Settings card, the one way into Settings since the
    /// Library's chrome was redesigned (its own Settings button went with it).
    @discardableResult
    func homeSettingsCard(timeout: TimeInterval = 30) -> XCUIElement {
        homeCard("home.settings", timeout: timeout)
    }
}
