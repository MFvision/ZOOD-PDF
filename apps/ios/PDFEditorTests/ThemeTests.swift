import SwiftUI
import XCTest
@testable import PDFEditor

/// The themes as rules rather than as pictures: what each one lets through,
/// what the accessibility settings take away from it, whether its accent can
/// be read on its own ground, and that the ZOOD letter is the same drawing in
/// the app as in the icon.
@MainActor
final class ThemeTests: XCTestCase {
    // MARK: - What a theme is

    func testTheThreeThemesAreOfferedAndKeptByTheirRawValue() {
        XCTAssertEqual(AppTheme.allCases.map(\.rawValue), ["system", "glass", "zood"])
        // What is written into UserDefaults comes back as the same theme:
        // this is what `@AppStorage(SettingsKey.theme)` does on a relaunch.
        for theme in AppTheme.allCases {
            XCTAssertEqual(AppTheme(rawValue: theme.rawValue), theme)
        }
        XCTAssertNil(AppTheme(rawValue: "liquid"), "an unknown value is not a theme")
    }

    func testOnlyTheGlassThemeAsksForTheSystemsGlass() {
        for scheme in [ColorScheme.light, .dark] {
            XCTAssertFalse(style(.system, scheme).wantsLiquidGlass)
            XCTAssertTrue(style(.glass, scheme).wantsLiquidGlass)
            XCTAssertFalse(style(.zood, scheme).wantsLiquidGlass, "ZOOD's whole point is that nothing is see-through")
        }
    }

    func testZoodIsNeverTranslucentAndTheOthersAreUntilReduceTransparency() {
        XCTAssertTrue(style(.system, .light).translucent)
        XCTAssertTrue(style(.glass, .dark).translucent)
        XCTAssertFalse(style(.zood, .light).translucent)
    }

    func testReduceTransparencyTakesTheGlassOffEveryTheme() {
        for theme in AppTheme.allCases {
            for scheme in [ColorScheme.light, .dark] {
                let solid = style(theme, scheme, reduceTransparency: true)
                XCTAssertFalse(solid.translucent, "\(theme) is solid under Reduce Transparency")
                XCTAssertFalse(solid.wantsLiquidGlass, "\(theme) asks for no glass under Reduce Transparency")
            }
        }
    }

    func testTheGlassThemeSaysHonestlyWhetherThisSystemHasTheEffect() {
        // The build runs on whatever the simulator is; the point is that the
        // answer is the system's, not a guess, and that Settings can show it.
        if #available(iOS 26.0, *) {
            XCTAssertTrue(ThemeAvailability.hasLiquidGlass)
        } else {
            XCTAssertFalse(ThemeAvailability.hasLiquidGlass)
        }
    }

    // MARK: - Colour

    func testZoodsAccentCanCarryTextOnZoodsOwnGround() {
        // WCAG AA for body text is 4.5:1. The bronze is used on the warm
        // paper and the gold on the ink; neither may fall under it.
        XCTAssertGreaterThanOrEqual(contrast(ZoodPalette.accentOnPaper, ZoodPalette.paper), 4.5)
        XCTAssertGreaterThanOrEqual(contrast(.white, ZoodPalette.accentOnPaper), 4.5, "white text on a filled bronze button")
        XCTAssertGreaterThanOrEqual(contrast(ZoodPalette.accentOnInk, ZoodPalette.ink), 4.5)
        XCTAssertGreaterThanOrEqual(contrast(ZoodPalette.accentOnInk, ZoodPalette.inkDeep), 4.5)
    }

    func testZoodDrawsSurfacesOfItsOwn() {
        // A theme that drew what the system already draws would be a choice
        // that does nothing.
        for scheme in [ColorScheme.light, .dark] {
            XCTAssertNotEqual(
                "\(components(of: style(.zood, scheme).solidCard))",
                "\(components(of: style(.system, scheme).solidCard))",
                "ZOOD's card is not the system's in \(scheme)"
            )
            XCTAssertNotEqual(
                "\(components(of: style(.zood, scheme).edge))",
                "\(components(of: style(.system, scheme).edge))",
                "nor is its edge"
            )
        }
        XCTAssertNotEqual(
            "\(components(of: style(.zood, .light).tint))",
            "\(components(of: style(.zood, .dark).tint))",
            "its accent turns over between light and dark"
        )
    }

    func testZoodSetsItsHeadingsAWeightHeavier() {
        XCTAssertEqual(style(.zood, .light).headingWeight, .heavy)
        XCTAssertEqual(style(.glass, .light).headingWeight, .bold)
        XCTAssertEqual(style(.system, .dark).headingWeight, .bold)
    }

    // MARK: - The mark

    func testTheLetterIsTheSameDrawingAsTheIcons() {
        // scripts/icon/make_zood_icon.py draws the Z on a 1024 grid at
        // 292…732 across and 308…716 down. The app's own paths must land on
        // the same fractions, or the mark beside a title and the icon on the
        // Home Screen would be two different letters.
        let rect = CGRect(x: 0, y: 0, width: 1024, height: 1024)
        let head = ZoodLetter.head(in: rect).boundingRect
        let foot = ZoodLetter.foot(in: rect).boundingRect
        XCTAssertEqual(head.minX, 292, accuracy: 0.5)
        XCTAssertEqual(head.maxX, 732, accuracy: 0.5)
        XCTAssertEqual(head.minY, 308, accuracy: 0.5)
        XCTAssertEqual(head.height, 92, accuracy: 0.5)
        XCTAssertEqual(foot.maxY, 716, accuracy: 0.5)
        XCTAssertEqual(foot.height, 92, accuracy: 0.5)
        XCTAssertEqual(head.width, foot.width, accuracy: 0.5, "the two bars are the same length")

        // The whole letter is square-ish and centred on the grid.
        let whole = ZoodLetterShape().path(in: rect).boundingRect
        XCTAssertEqual(whole.midX, 512, accuracy: 1)
        XCTAssertEqual(whole.midY, 512, accuracy: 1)

        // The diagonal runs from the head's trailing end down to the foot's
        // leading one — a Z, not an S.
        let fold = ZoodLetter.fold(in: rect)
        XCTAssertTrue(fold.contains(CGPoint(x: 700, y: 420)), "the fold starts under the head's far end")
        XCTAssertTrue(fold.contains(CGPoint(x: 330, y: 600)), "and lands over the foot's near end")
        XCTAssertFalse(fold.contains(CGPoint(x: 330, y: 420)), "nothing of it under the head's near end")
    }

    func testTheLetterScalesWithTheRectItIsDrawnIn() {
        let small = ZoodLetterShape().path(in: CGRect(x: 0, y: 0, width: 32, height: 32)).boundingRect
        let large = ZoodLetterShape().path(in: CGRect(x: 0, y: 0, width: 320, height: 320)).boundingRect
        XCTAssertEqual(large.width / small.width, 10, accuracy: 0.01)
        XCTAssertEqual(small.minX / 32, 292.0 / 1024, accuracy: 0.001)
    }

    // MARK: - Helpers

    private func style(_ theme: AppTheme, _ scheme: ColorScheme, reduceTransparency: Bool = false) -> ThemeStyle {
        ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
    }

    private func components(of colour: Color) -> [CGFloat] {
        let resolved = UIColor(colour).cgColor.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)
        return resolved?.components ?? []
    }

    /// WCAG's contrast ratio, from the two colours' relative luminance.
    private func contrast(_ one: Color, _ other: Color) -> CGFloat {
        let first = luminance(one)
        let second = luminance(other)
        return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }

    private func luminance(_ colour: Color) -> CGFloat {
        let parts = components(of: colour)
        guard parts.count >= 3 else { return 0 }
        func channel(_ value: CGFloat) -> CGFloat {
            value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(parts[0]) + 0.7152 * channel(parts[1]) + 0.0722 * channel(parts[2])
    }
}
