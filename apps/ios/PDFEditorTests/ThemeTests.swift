import CoreText
import SwiftUI
import XCTest
@testable import PDFEditor

/// The themes as rules rather than as pictures: what each one lets through,
/// what the accessibility settings take away from it, whether every pair of
/// ZOOD's text and ground passes WCAG AA, that ZOOD's colours reach the plain
/// `Surface` tokens through the theme, that its faces are in the app and
/// shape Arabic, and that the mark in the app is the icon's own drawing.
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

    func testGlassIsOnlyEverTheBarsNeverTheContent() {
        for scheme in [ColorScheme.light, .dark] {
            let glass = style(.glass, scheme)
            XCTAssertTrue(glass.wantsLiquidGlass(.bar), "the glass theme's bars are glass")
            XCTAssertFalse(glass.wantsLiquidGlass(.card), "a card is content: never glass")
            XCTAssertEqual("\(glass.cardFill)", "\(AnyShapeStyle(glass.solidCard))", "the glass theme's cards are solid")
            XCTAssertFalse(style(.system, scheme).wantsLiquidGlass(.bar))
            XCTAssertFalse(style(.zood, scheme).wantsLiquidGlass(.bar), "ZOOD's is opaque")
        }
    }

    func testTheGlassThemeHasNoColouredSkyUnderTheContent() {
        // Wave 1's glass ground ran sky to violet; the content's ground is
        // now the system's own grouped background, in light and in dark.
        XCTAssertEqual("\(style(.glass, .light).ground)", "\(LinearGradient(colors: [Color(.systemGroupedBackground)], startPoint: .top, endPoint: .bottom))")
        XCTAssertEqual("\(style(.glass, .dark).ground)", "\(style(.glass, .light).ground)", "it follows the system's appearance by itself")
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
                XCTAssertFalse(solid.wantsLiquidGlass(.bar), "\(theme) asks for no glass under Reduce Transparency")
                XCTAssertEqual("\(solid.barFill)", "\(AnyShapeStyle(solid.solidBar))")
            }
        }
    }

    func testIncreaseContrastMakesTheBarsSolidAndTheEdgesFirm() {
        let glass = ThemeStyle(theme: .glass, scheme: .light, reduceTransparency: false, increaseContrast: true)
        XCTAssertFalse(glass.wantsLiquidGlass(.bar), "no glass under Increase Contrast")
        XCTAssertEqual("\(glass.barFill)", "\(AnyShapeStyle(glass.solidBar))")
        XCTAssertNotEqual("\(glass.edge)", "\(Color.clear)", "and the surfaces get an edge")
        let zood = ThemeStyle(theme: .zood, scheme: .dark, reduceTransparency: false, increaseContrast: true)
        XCTAssertGreaterThan(alpha(of: zood.edge), alpha(of: style(.zood, .dark).edge), "ZOOD's bronze hairline is firmer")
    }

    func testTheGlassThemeSaysHonestlyWhetherThisSystemHasTheEffect() {
        if #available(iOS 26.0, *) {
            XCTAssertTrue(ThemeAvailability.hasLiquidGlass)
        } else {
            XCTAssertFalse(ThemeAvailability.hasLiquidGlass)
        }
    }

    // MARK: - ZOOD's colours

    func testZoodsPaletteIsTheGuidesOwnNumbers() {
        // Guide p. 9 and the identity package: Pantone 282 C, 482 C at 60 %,
        // 2318 C, 291 C.
        XCTAssertEqual(hex(ZoodPalette.navy), 0x041E42)
        XCTAssertEqual(hex(ZoodPalette.beige), 0xD6C6B8)
        XCTAssertEqual(hex(ZoodPalette.bronze), 0x977756)
        XCTAssertEqual(hex(ZoodPalette.sky), 0xA7C6ED)
        // The tints are the guide's 95/85/60 % toward white, worked out.
        XCTAssertEqual(hex(ZoodPalette.navy95), 0x11294B)
        XCTAssertEqual(hex(ZoodPalette.navy85), 0x2A405E)
        XCTAssertEqual(hex(ZoodPalette.navy60), 0x68788E)
        XCTAssertEqual(hex(ZoodPalette.beige60), 0xE6DDD4)
    }

    func testEveryTextOnZoodsGroundsPassesAA() {
        // WCAG AA: 4.5:1 for text. Every text colour on every surface it is
        // drawn on, on the paper (light) and on the navy (dark).
        let paperGrounds = [ZoodPalette.beige60, ZoodPalette.paper, UIColor(hex: 0xE1D6CB)]
        let navyGrounds = [ZoodPalette.navy, ZoodPalette.navy95, ZoodPalette.navyDeep]
        for ground in paperGrounds {
            for text in [ZoodPalette.inkOnPaper, ZoodPalette.secondaryOnPaper, ZoodPalette.tertiaryOnPaper, ZoodPalette.bronzeDeep] {
                XCTAssertGreaterThanOrEqual(contrast(text, ground), 4.5, "#\(String(hex(text), radix: 16)) on #\(String(hex(ground), radix: 16))")
            }
        }
        for ground in navyGrounds {
            for text in [ZoodPalette.inkOnNavy, ZoodPalette.secondaryOnNavy, ZoodPalette.tertiaryOnNavy, ZoodPalette.bronzeOnNavy] {
                XCTAssertGreaterThanOrEqual(contrast(text, ground), 4.5, "#\(String(hex(text), radix: 16)) on #\(String(hex(ground), radix: 16))")
            }
        }
        // A filled button: white on the deep bronze, navy on the light one.
        XCTAssertGreaterThanOrEqual(contrast(.white, ZoodPalette.bronzeDeep), 4.5)
        XCTAssertGreaterThanOrEqual(contrast(ZoodPalette.navy, ZoodPalette.bronzeOnNavy), 4.5)
        XCTAssertEqual(hex(UIColor(style(.zood, .dark).onTint)), hex(ZoodPalette.navy))
        XCTAssertEqual(hex(UIColor(style(.zood, .light).onTint)), 0xFFFFFF)
        // The copper glyph on its navy plate (a tool's tile).
        XCTAssertGreaterThanOrEqual(contrast(ZoodPalette.copperLight, ZoodPalette.navy), 4.5)
    }

    func testZoodsAccentIsTheBronzeAndTurnsOverWithTheScheme() {
        XCTAssertEqual(hex(UIColor(style(.zood, .light).tint)), hex(ZoodPalette.bronzeDeep))
        XCTAssertEqual(hex(UIColor(style(.zood, .dark).tint)), hex(ZoodPalette.bronzeOnNavy))
        XCTAssertEqual(hex(UIColor(style(.zood, .light).solidCard)), hex(ZoodPalette.paper), "the card is the paper")
        XCTAssertEqual(hex(UIColor(style(.zood, .dark).solidCard)), hex(ZoodPalette.navy95), "and the navy's 95 % tint")
    }

    func testTheSurfaceTokensTakeZoodsColoursThroughTheTraits() {
        // UIKit: a dynamic colour resolved with the theme in its traits.
        func resolved(_ colour: Color, _ theme: AppTheme, _ style: UIUserInterfaceStyle) -> UInt32 {
            let traits = UITraitCollection { $0.appTheme = theme; $0.userInterfaceStyle = style }
            return hex(UIColor(colour).resolvedColor(with: traits))
        }
        XCTAssertEqual(resolved(Surface.label, .zood, .light), hex(ZoodPalette.navy), "navy type on the paper")
        XCTAssertEqual(resolved(Surface.label, .zood, .dark), hex(ZoodPalette.beige60), "beige type on the navy")
        XCTAssertEqual(resolved(Surface.grouped, .zood, .light), hex(ZoodPalette.beige60))
        XCTAssertEqual(resolved(Surface.label, .glass, .light), hex(UIColor.label.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))))

        // SwiftUI: the same colour resolved from an environment that holds
        // the theme — the path every `Text` takes. This is the bridge
        // (`AppThemeKey: UITraitBridgedEnvironmentKey`) doing its work.
        var environment = EnvironmentValues()
        environment.colorScheme = .light
        environment.appTheme = .zood
        let zoodLabel = Surface.label.resolve(in: environment)
        XCTAssertEqual(hex(UIColor(Color(zoodLabel))), hex(ZoodPalette.navy))
        environment.appTheme = .system
        XCTAssertNotEqual(hex(UIColor(Color(Surface.label.resolve(in: environment)))), hex(ZoodPalette.navy))
    }

    // MARK: - ZOOD's type

    func testZoodsFacesAreInTheAppAndTheHeadlineFallsBackHonestly() {
        BrandType.register()
        for name in [BrandType.body.regular, BrandType.body.light, BrandType.body.semibold] {
            XCTAssertNotNil(UIFont(name: name, size: 17), "Vazirmatn's \(name) is registered")
        }
        let licensed = Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: nil)?
            .contains { $0.lastPathComponent.hasPrefix(BrandType.licensedHeadlinePrefix) } ?? false
        XCTAssertEqual(BrandType.hasLicensedHeadline, licensed, "Huwiya is used exactly when its files were bundled")
    }

    func testBothFacesShapeArabicAndCarryLatin() throws {
        BrandType.register()
        var faces = [BrandType.body.regular]
        if BrandType.hasLicensedHeadline { faces.append(BrandType.licensedHeadline.light) }
        for name in faces {
            let font = CTFontCreateWithName(name as CFString, 34, nil)
            XCTAssertEqual(CTFontCopyPostScriptName(font) as String, name, "\(name) is the face, not a substitute")
            // «زود» and a sentence: every glyph from this face, none missing,
            // and the letters joined — a joined ع is not the isolated one.
            for text in ["زود", "عيش في رفاهية", "PDFs, done right."] {
                let runs = glyphRuns(text, font: font)
                XCTAssertFalse(runs.isEmpty)
                for run in runs {
                    XCTAssertEqual(run.font, name, "\(text) is set in \(name), with no fallback")
                    XCTAssertFalse(run.glyphs.contains(0), "\(text) has no missing glyph in \(name)")
                }
            }
            let isolated = try XCTUnwrap(glyphRuns("ع", font: font).first?.glyphs.first)
            let initial = try XCTUnwrap(glyphRuns("عي", font: font).first?.glyphs)
            XCTAssertFalse(initial.contains(isolated), "\(name) joins ع to what follows it")
        }
    }

    // MARK: - The mark

    func testTheAppIconIsTheMarkOverItsCopperLabel() throws {
        // The app icon iOS was given (scripts/icon/make_zood_icons.sh writes
        // it; Xcode puts its 120-px rendering in the app bundle): ZOOD's
        // copper mark on navy, over a copper band along the foot that names
        // the app ("PDF" and a pencil, in navy).
        let url = try XCTUnwrap(
            Bundle.main.urls(forResourcesWithExtension: "png", subdirectory: nil)?
                .first { $0.lastPathComponent.hasPrefix("AppIcon60x60@2x") },
            "the 120-px app icon is in the app"
        )
        let icon = try XCTUnwrap(UIImage(contentsOfFile: url.path)?.cgImage)
        let side = icon.width
        let p = pixels(icon, side: side)
        func copper(_ x: Int, _ y: Int) -> Bool { let i = (y * side + x) * 4; return Int(p[i]) - Int(p[i + 2]) > 30 }
        func share(rows: Range<Int>) -> Double {
            var n = 0
            for y in rows { for x in 0..<side where copper(x, y) { n += 1 } }
            return Double(n) / Double(rows.count * side)
        }
        // The band: the foot of the icon is copper nearly all the way across
        // (the letters and the pencil are the navy in it).
        XCTAssertGreaterThan(share(rows: side * 80 / 100..<side * 98 / 100), 0.6, "a copper band along the foot")
        // Above it: navy with the mark's copper strokes in the middle.
        let upper = share(rows: side * 15 / 100..<side * 65 / 100)
        XCTAssertGreaterThan(upper, 0.05, "the copper mark is above the band")
        XCTAssertLessThan(upper, 0.4, "on navy, not on more copper")
        XCTAssertLessThan(share(rows: 0..<side * 8 / 100), 0.02, "and the top of the icon is the navy ground")
    }

    func testTheLogoArtworkIsInTheCatalogueAsVectors() {
        for name in ["ZoodMark", "ZoodLogoMain", "ZoodLogoVertical", "ZoodLogoHorizontal", "ZoodPattern01", "ZoodPattern02", "ZoodPattern03"] {
            let image = UIImage(named: name)
            XCTAssertNotNil(image, "\(name) is in the asset catalogue")
            XCTAssertEqual(image?.renderingMode, .alwaysTemplate, "\(name) takes the theme's colour")
        }
        // Never stretched: the mark keeps the artwork's own proportions.
        let mark = UIImage(named: "ZoodMark")!
        XCTAssertEqual(mark.size.width / mark.size.height, ZoodIcon.markAspect, accuracy: 0.01)
    }

    // MARK: - Helpers

    private func style(_ theme: AppTheme, _ scheme: ColorScheme, reduceTransparency: Bool = false) -> ThemeStyle {
        ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
    }

    private func components(of colour: UIColor) -> [CGFloat] {
        let resolved = colour.cgColor.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)
        return resolved?.components ?? []
    }

    private func hex(_ colour: UIColor) -> UInt32 {
        let parts = components(of: colour)
        guard parts.count >= 3 else { return 0 }
        return parts.prefix(3).reduce(0) { ($0 << 8) | UInt32((min(max($1, 0), 1) * 255).rounded()) }
    }

    private func alpha(of colour: Color) -> CGFloat {
        components(of: UIColor(colour)).last ?? 0
    }

    /// WCAG's contrast ratio, from the two colours' relative luminance.
    private func contrast(_ one: UIColor, _ other: UIColor) -> CGFloat {
        let first = luminance(one)
        let second = luminance(other)
        return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }

    private func luminance(_ colour: UIColor) -> CGFloat {
        let parts = components(of: colour)
        guard parts.count >= 3 else { return 0 }
        func channel(_ value: CGFloat) -> CGFloat {
            value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(parts[0]) + 0.7152 * channel(parts[1]) + 0.0722 * channel(parts[2])
    }

    private func glyphRuns(_ text: String, font: CTFont) -> [(font: String, glyphs: [CGGlyph])] {
        let attributed = NSAttributedString(string: text, attributes: [.init(kCTFontAttributeName as String): font])
        let line = CTLineCreateWithAttributedString(attributed)
        let runs = CTLineGetGlyphRuns(line) as? [CTRun] ?? []
        return runs.map { run in
            let attributes = CTRunGetAttributes(run) as NSDictionary
            let runFont = attributes[kCTFontAttributeName as String] as! CTFont
            var glyphs = [CGGlyph](repeating: 0, count: CTRunGetGlyphCount(run))
            CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
            return (CTFontCopyPostScriptName(runFont) as String, glyphs)
        }
    }

    private func pixels(_ image: CGImage, side: Int) -> [UInt8] {
        var data = [UInt8](repeating: 0, count: side * side * 4)
        let context = CGContext(
            data: &data, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return data
    }
}
