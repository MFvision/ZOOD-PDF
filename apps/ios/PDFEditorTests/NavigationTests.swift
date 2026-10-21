@testable import PDFEditor
import XCTest

/// The iPhone's menu choices: the tab bar's order, what Open with offers,
/// and the app icons Settings names.
@MainActor
final class NavigationTests: XCTestCase {
    func testTheTabsRunHomeToMeWithCreateInTheMiddle() {
        XCTAssertEqual(AppTab.allCases, [.home, .files, .create, .tools, .me])
        XCTAssertLessThanOrEqual(AppTab.allCases.count, 5, "five tabs at most")
    }

    func testOpenWithKeepsWhatTheAppAlwaysDidByDefault() {
        XCTAssertEqual(StartScreen(rawValue: "lastPlace"), .lastPlace)
        XCTAssertEqual(StartScreen.allCases.first, .lastPlace)
        XCTAssertEqual(MenuStyle(rawValue: "tabs"), .tabs)
        XCTAssertEqual(MenuStyle(rawValue: "classic"), .classic)
    }

    func testEveryAlternateIconIsInTheCatalogue() {
        XCTAssertNil(AppIconChoice.navy.iconName, "navy is the app's own icon")
        XCTAssertEqual(AppIconChoice(iconName: nil), .navy)
        for choice in AppIconChoice.allCases {
            XCTAssertNotNil(UIImage(named: choice.preview), "\(choice) has a picture for the picker")
            if let name = choice.iconName {
                XCTAssertEqual(AppIconChoice(iconName: name), choice)
            }
        }
    }
}
