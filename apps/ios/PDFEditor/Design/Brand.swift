import CoreText
import SwiftUI
import UIKit

// ZOOD's identity, as the brand's own guide and identity package give it
// (ZOOD – Visual Expression, Bold Brands, Aug 2026; ZOOD New CI): the
// palette in its proportions, the typefaces, the logo and the graphical
// element. The Zood theme in Themes.swift is built from these and nothing
// else; the artwork itself is in the asset catalogue, cut from the brand's
// .ai files by scripts/icon/make_zood_icons.sh, never redrawn.

// MARK: - The palette

/// ZOOD's four colours (guide p. 9) and the tints the guide gives them
/// (95, 85 and 60 %, toward white), plus the few steps a screen needs that
/// the guide does not print — each one a darker or lighter step of a brand
/// colour, chosen so that text on it passes WCAG AA (ThemeTests checks
/// every pair). The proportions are the guide's: navy dominant (40 %), the
/// beige the paper (30 %), the bronze the accent (20 %), the light blue
/// sparing (10 %).
enum ZoodPalette {
    // Navy, Pantone 282 C — the logo, the type on paper, the dark ground.
    static let navy = UIColor(hex: 0x041E42)
    static let navy95 = UIColor(hex: 0x11294B)
    static let navy85 = UIColor(hex: 0x2A405E)
    static let navy60 = UIColor(hex: 0x68788E)
    /// The ground under the pages in dark: a shade of the navy, so white
    /// paper sits in it the way a page sits on the folder (guide p. 28).
    static let navyDeep = UIColor(hex: 0x021631)

    // Beige, Pantone 482 C at 60 % — the paper.
    static let beige = UIColor(hex: 0xD6C6B8)
    static let beige60 = UIColor(hex: 0xE6DDD4)
    /// The card on the paper: the beige at a quarter, the envelope's stock (p. 30).
    static let paper = UIColor(hex: 0xF5F1ED)

    // Bronze, Pantone 2318 C — the accent, the copper foil (p. 28).
    static let bronze = UIColor(hex: 0x977756)
    /// The copper the mark is foiled in, at its lit edge.
    static let copperLight = UIColor(hex: 0xC9A27C)
    /// The bronze one step darker: the accent as text and as a fill under
    /// white text on the paper (4.8:1 on the beige, 6.5:1 under white).
    static let bronzeDeep = UIColor(hex: 0x73563A)
    /// The bronze one step lighter: the accent as text on the navy (5.3:1),
    /// and as a fill under navy text (5.3:1).
    static let bronzeOnNavy = UIColor(hex: 0xAE8B66)

    // Light blue, Pantone 291 C — sparing: the frosted pattern on the navy.
    static let sky = UIColor(hex: 0xA7C6ED)

    // Text, by role. On the paper the type is the navy and two tints of it;
    // on the navy it is the paper's beige and two warm greys.
    static let inkOnPaper = navy
    static let secondaryOnPaper = navy85
    static let tertiaryOnPaper = UIColor(hex: 0x485A73)
    static let inkOnNavy = beige60
    static let secondaryOnNavy = UIColor(hex: 0xB5AEA8)
    static let tertiaryOnNavy = UIColor(hex: 0x97938E)
}

extension UIColor {
    /// An sRGB colour from `0xRRGGBB`.
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

// MARK: - The theme as a UIKit trait

/// The chosen theme as a trait, bridged both ways with `\.appTheme` in the
/// SwiftUI environment. That is what lets a plain `Color` — `Surface.label`
/// and its kin, used as a `Color` all over the app — turn navy on ZOOD's
/// paper without a call site knowing: a dynamic UIColor reads the theme off
/// the traits it is resolved with, as it reads light or dark.
private struct AppThemeTrait: UITraitDefinition {
    static let defaultValue = AppTheme.system
    static let affectsColorAppearance = true
    static let identifier = "app.warraq.ios.theme"
    static let name = "AppTheme"
}

extension UITraitCollection {
    var appTheme: AppTheme { self[AppThemeTrait.self] }
}

extension UIMutableTraits {
    var appTheme: AppTheme {
        get { self[AppThemeTrait.self] }
        set { self[AppThemeTrait.self] = newValue }
    }
}

struct AppThemeKey: EnvironmentKey {
    static let defaultValue = AppTheme.system
}

extension AppThemeKey: UITraitBridgedEnvironmentKey {
    static func read(from traitCollection: UITraitCollection) -> AppTheme {
        traitCollection.appTheme
    }

    static func write(to mutableTraits: inout any UIMutableTraits, value: AppTheme) {
        mutableTraits.appTheme = value
    }
}

extension EnvironmentValues {
    /// The theme every themed surface reads. `appEnvironment()` puts the
    /// chosen one here; a preview or a test can override it on its own.
    var appTheme: AppTheme {
        get { self[AppThemeKey.self] }
        set { self[AppThemeKey.self] = newValue }
    }
}

extension Color {
    /// The system's colour on the system and glass themes; on ZOOD's, its
    /// own for the paper (light) and for the navy (dark).
    static func themed(system: UIColor, paper: UIColor, navy: UIColor) -> Color {
        Color(uiColor: UIColor { traits in
            guard traits.appTheme == .zood else { return system.resolvedColor(with: traits) }
            return traits.userInterfaceStyle == .dark ? navy : paper
        })
    }
}

// MARK: - Type

/// ZOOD's typefaces (guide p. 10–11, and the identity package). Headlines
/// are in **ITF Huwiya Arabic**, the face the brand bought; body copy, in
/// Arabic and Latin, is **Vazirmatn** (SIL OFL 1.1, bundled).
///
/// Huwiya is a commercial font and never enters the repository: it is
/// loaded from `PDFEditor/Resources/LicensedFonts/` (git-ignored) when the
/// files are there, and the headlines fall back to Vazirmatn Light when
/// they are not, so a clean checkout builds and looks right. This enum is
/// the one place either face is named.
enum BrandType {
    /// The licensed headline face: its files' prefix in LicensedFonts.
    static let licensedHeadlinePrefix = "ItfHuwiyaArabic"
    /// Its weights the theme uses, by PostScript name.
    static let licensedHeadline = (light: "ItfHuwiyaArabic-Light", regular: "ItfHuwiyaArabic-Regular", medium: "ItfHuwiyaArabic-Medium")
    /// The OFL face's file, and its named instances, by PostScript name.
    static let bodyFile = "Vazirmatn-Variable"
    static let body = (light: "Vazirmatn-Regular_Light", regular: "Vazirmatn-Regular", medium: "Vazirmatn-Regular_Medium", semibold: "Vazirmatn-Regular_SemiBold")

    /// Registers the bundled faces with the process, once. Called before
    /// the first scene draws; a face already registered is not an error.
    @MainActor static func register() {
        guard !registered else { return }
        registered = true
        var urls: [URL] = []
        if let body = Bundle.main.url(forResource: bodyFile, withExtension: "ttf") { urls.append(body) }
        urls += (Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? [])
            .filter { $0.lastPathComponent.hasPrefix(licensedHeadlinePrefix) }
        for url in urls {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    @MainActor private static var registered = false

    /// Whether the licensed headline face is in this build.
    static var hasLicensedHeadline: Bool {
        UIFont(name: licensedHeadline.light, size: 12) != nil
    }

    /// A headline: Huwiya when it is here, else Vazirmatn, light at display
    /// sizes and regular below them, as the guide sets Canela's place.
    static func headline(size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
        let licensed = hasLicensedHeadline
        let name: String
        if size >= 26 {
            name = licensed ? licensedHeadline.light : body.light
        } else {
            name = licensed ? licensedHeadline.regular : body.regular
        }
        return .custom(name, size: size, relativeTo: style)
    }

    /// Body copy in Vazirmatn, at the system text style's size so Dynamic
    /// Type scales it the same.
    static func text(_ style: Font.TextStyle, emphasis: Bool = false) -> Font {
        .custom(emphasis ? body.semibold : body.regular, size: defaultSize(style), relativeTo: style)
    }

    /// The text styles' default sizes (Large, the default Dynamic Type).
    static func defaultSize(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        @unknown default: 17
        }
    }
}

/// What a piece of text is, for a screen that wants the theme's type: the
/// system's text styles on the system and glass themes, ZOOD's faces on
/// its own. `.themeFont(_:)` reads the theme from the environment.
enum TypeRole {
    case display, largeTitle, title, headline, body, callout, subheadline, caption

    func font(for theme: AppTheme) -> Font {
        guard theme == .zood else {
            switch self {
            case .display, .largeTitle: return TextStyle.largeTitle
            case .title: return TextStyle.title
            case .headline: return TextStyle.headline
            case .body: return TextStyle.body
            case .callout: return TextStyle.callout
            case .subheadline: return TextStyle.subheadline
            case .caption: return TextStyle.caption
            }
        }
        switch self {
        case .display: return BrandType.headline(size: 38, relativeTo: .largeTitle)
        case .largeTitle: return BrandType.headline(size: 32, relativeTo: .largeTitle)
        case .title: return BrandType.headline(size: 22, relativeTo: .title2)
        case .headline: return BrandType.text(.headline, emphasis: true)
        case .body: return BrandType.text(.body)
        case .callout: return BrandType.text(.callout)
        case .subheadline: return BrandType.text(.subheadline)
        case .caption: return BrandType.text(.caption)
        }
    }
}

private struct ThemeFontModifier: ViewModifier {
    let role: TypeRole
    @Environment(\.appTheme) private var theme

    func body(content: Content) -> some View {
        content.font(role.font(for: theme))
    }
}

extension View {
    /// The theme's type for this role.
    func themeFont(_ role: TypeRole) -> some View {
        modifier(ThemeFontModifier(role: role))
    }
}

/// ZOOD's body face as the default for every text that names no font of
/// its own — Form rows, labels, buttons. Applied once at a scene's root.
struct ThemeTypeface: ViewModifier {
    @Environment(\.appTheme) private var theme

    func body(content: Content) -> some View {
        if theme == .zood {
            content.font(BrandType.text(.body))
        } else {
            content
        }
    }
}

// MARK: - The logo

/// ZOOD's three logos (identity package, "01. Logo Design"), as vector
/// template images coloured by the caller. Never stretched: they keep their
/// own proportions, and the clear space around them is a quarter of the
/// mark's height — the guide gives none, so this is the app's rule, wide
/// enough that nothing crowds the arcs.
struct ZoodLogo: View {
    enum Kind: String {
        /// The mark beside «زود» over ZOOD.
        case main = "ZoodLogoMain"
        /// The mark over «زود» over ZOOD.
        case vertical = "ZoodLogoVertical"
        /// The mark over «ZOOD زود» on one line.
        case horizontal = "ZoodLogoHorizontal"
    }

    let kind: Kind
    /// The logo's height, without its clear space.
    var height: CGFloat
    var colour: Color = Surface.label

    /// The mark's share of each logo's height, from the artwork's own boxes
    /// (scripts/icon/zood): the clear space is reckoned from the mark.
    private var markHeight: CGFloat {
        switch kind {
        case .main: height
        case .vertical: height * 409.5 / 738.2
        case .horizontal: height * 409.5 / 563.2
        }
    }

    static let clearSpaceShare: CGFloat = 0.25

    var body: some View {
        Image(kind.rawValue)
            .renderingMode(.template)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(height: height)
            .foregroundStyle(colour)
            .padding(markHeight * Self.clearSpaceShare)
            // The logo is read as the brand's name, in both scripts.
            .accessibilityElement()
            .accessibilityLabel(Text(verbatim: "ZOOD زود"))
            .accessibilityAddTraits(.isImage)
    }
}

// MARK: - The graphical element

/// The brand's graphical element (guide pp. 12–14; identity package, "03.
/// Graphical Elements"): the logo's curve drawn out into vertical lines
/// with one S-bend each. Used the way the guide uses it on glass (p. 53) —
/// a frosted texture, faint — and only where it earns its place: the home
/// screen's hero, the welcome tour, an empty state. Never behind text that
/// has to be read, and gone under Increase Contrast, where a texture is
/// noise.
struct ZoodPattern: View {
    enum Kind: String {
        /// "Pattern 02": the dense woven field.
        case woven = "ZoodPattern02"
        /// "Pattern 01": three lines, two of them bending.
        case lines = "ZoodPattern01"
        /// "Pattern 03": two thin lines, one bend.
        case line = "ZoodPattern03"
    }

    var kind: Kind = .woven
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        if contrast != .increased {
            Image(kind.rawValue)
                .renderingMode(.template)
                .resizable()
                .aspectRatio(contentMode: .fill)
                // Frosted, not printed: navy breathed onto the paper; on the
                // navy, the light blue, as light catches etched glass.
                .foregroundStyle(scheme == .dark ? Color(uiColor: ZoodPalette.sky).opacity(0.13) : Color(uiColor: ZoodPalette.navy).opacity(0.07))
                .accessibilityHidden(true)
                .allowsHitTesting(false)
        }
    }
}
