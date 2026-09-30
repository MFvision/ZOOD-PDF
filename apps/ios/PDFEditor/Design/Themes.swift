import SwiftUI

// The look of the chrome, chosen in Settings and kept: the system's, Liquid
// Glass, or ZOOD's own. It is a layer over the tokens in Theme.swift, not a
// replacement for them — every screen still asks for `Surface.label`, `Space`
// and `Radius`; what changes is the material under them, the ground behind
// them and the accent on them.
//
// Two of the system's accessibility settings decide how far a theme goes.
// Reduce Transparency turns every material into the solid colour behind it,
// on every theme, because a person who asked to see less through a surface
// meant it. Reduce Motion is left to `Motion`, as everywhere else.

/// The three looks Settings offers.
enum AppTheme: String, CaseIterable, Identifiable, Sendable {
    /// The system's own materials and accent — what the app looked like before.
    case system
    /// Liquid Glass: the system's glass where the OS has it (iOS 26 and
    /// later), its materials where it does not.
    case glass
    /// ZOOD's: ink and gold on warm paper, opaque throughout.
    case zood

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .system: "System"
        case .glass: "Liquid Glass"
        case .zood: "Zood"
        }
    }

    /// What the row says under the picker, in the person's language.
    var caption: LocalizedStringKey {
        switch self {
        case .system: "The system's own materials and accent colour."
        case .glass: "Glass chrome over a soft ground. Needs iOS 26 for the system's own glass; on older systems it uses the frosted materials instead."
        case .zood: "ZOOD's own: ink and gold, with no translucency."
        }
    }
}

/// What the system this build is running on can actually do. Settings tells
/// the person when the glass theme has to fall back, rather than showing a
/// choice that quietly does nothing.
enum ThemeAvailability {
    /// Whether the system has Liquid Glass itself (iOS 26 and later).
    static var hasLiquidGlass: Bool {
        if #available(iOS 26.0, *) { return true }
        return false
    }
}

/// ZOOD's two colours. The same numbers the app mark is drawn with
/// (`scripts/icon/make_zood_icon.py`), so the icon and the theme agree.
enum ZoodPalette {
    /// The ink, lightest to deepest: the mark's ground, and the theme's dark surfaces.
    static let inkLight = Color(red: 0x2B / 255, green: 0x35 / 255, blue: 0x60 / 255)
    static let ink = Color(red: 0x14 / 255, green: 0x1C / 255, blue: 0x39 / 255)
    static let inkDeep = Color(red: 0x08 / 255, green: 0x0B / 255, blue: 0x1A / 255)
    /// The gold, from the light face of the fold to its dark one.
    static let goldLight = Color(red: 0xFA / 255, green: 0xD9 / 255, blue: 0x8C / 255)
    static let gold = Color(red: 0xEE / 255, green: 0xBE / 255, blue: 0x58 / 255)
    static let goldDeep = Color(red: 0xC6 / 255, green: 0x84 / 255, blue: 0x20 / 255)
    /// The warm paper the light theme sits on, and the warmer white a card
    /// on it is: a card that were plain white would be the system's card.
    static let paper = Color(red: 0xFB / 255, green: 0xF8 / 255, blue: 0xF2 / 255)
    static let paperShade = Color(red: 0xF1 / 255, green: 0xE9 / 255, blue: 0xDA / 255)
    static let card = Color(red: 0xFF / 255, green: 0xFC / 255, blue: 0xF5 / 255)
    /// A card on the ink: solid, not a material — this theme is never glass.
    static let cardOnInk = Color(red: 0x1C / 255, green: 0x24 / 255, blue: 0x46 / 255)
    /// The accent, dark enough on paper to carry white text (7.7:1), and the
    /// gold itself on ink (9:1).
    static let accentOnPaper = Color(red: 0x8A / 255, green: 0x5A / 255, blue: 0x12 / 255)
    static let accentOnInk = Color(red: 0xEE / 255, green: 0xC1 / 255, blue: 0x69 / 255)
}

/// A theme resolved for the screen it is being drawn on: the colour scheme,
/// and whether the person asked for less transparency. Everything a view
/// needs to draw a surface is read from here, never guessed at the call site.
struct ThemeStyle {
    let theme: AppTheme
    let scheme: ColorScheme
    let reduceTransparency: Bool

    init(theme: AppTheme, scheme: ColorScheme, reduceTransparency: Bool) {
        self.theme = theme
        self.scheme = scheme
        self.reduceTransparency = reduceTransparency
    }

    private var dark: Bool { scheme == .dark }

    /// Whether the system's own Liquid Glass is used. It needs the glass
    /// theme, a system that has the effect at all, and a person who has not
    /// asked for less transparency. `ThemedSurface` is the only caller: it
    /// still has to write the `#available` branch, because an availability
    /// check cannot be carried in a Bool.
    var wantsLiquidGlass: Bool {
        theme == .glass && !reduceTransparency
    }

    /// Whether anything on this theme is see-through at all.
    var translucent: Bool {
        theme != .zood && !reduceTransparency
    }

    /// The accent: the system's (which is the person's own on iOS) for the
    /// system and glass themes, ZOOD's bronze-on-paper or gold-on-ink for its.
    var tint: Color {
        switch theme {
        case .system, .glass: .accentColor
        case .zood: dark ? ZoodPalette.accentOnInk : ZoodPalette.accentOnPaper
        }
    }

    /// The ground a screen's content sits on. Glass needs something behind it
    /// to be glass over, so its ground carries more colour than the system's.
    var ground: LinearGradient {
        LinearGradient(colors: groundColors, startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    private var groundColors: [Color] {
        switch theme {
        case .system:
            dark
                ? [Color(red: 0.09, green: 0.11, blue: 0.16), Color(red: 0.05, green: 0.06, blue: 0.09)]
                : [Color(red: 0.86, green: 0.92, blue: 0.99), Color(red: 0.97, green: 0.98, blue: 1.0)]
        case .glass:
            // Glass needs colour behind it or it is only a grey blur: this
            // ground runs sky to haze to a little violet, as the owner's
            // design target does.
            dark
                ? [Color(red: 0.05, green: 0.10, blue: 0.24), Color(red: 0.07, green: 0.09, blue: 0.18), Color(red: 0.14, green: 0.07, blue: 0.22)]
                : [Color(red: 0.74, green: 0.85, blue: 0.99), Color(red: 0.88, green: 0.93, blue: 1.0), Color(red: 0.96, green: 0.92, blue: 1.0)]
        case .zood:
            dark
                ? [ZoodPalette.ink, ZoodPalette.inkDeep]
                : [ZoodPalette.paper, ZoodPalette.paperShade]
        }
    }

    /// What a card is filled with. Under Reduce Transparency, and on the
    /// ZOOD theme, it is a solid colour — never a material that has been
    /// made "nearly" opaque, which reads as a bug.
    var cardFill: AnyShapeStyle {
        if !translucent { return AnyShapeStyle(solidCard) }
        return AnyShapeStyle(.regularMaterial)
    }

    /// The bar chrome — navigation, toolbars, the markup bar's palette — one
    /// step thinner than a card, as the system's own bars are.
    var barFill: AnyShapeStyle {
        if !translucent { return AnyShapeStyle(solidCard) }
        return AnyShapeStyle(theme == .glass ? .ultraThinMaterial : .regularMaterial)
    }

    /// The colour a card falls back to when nothing may be translucent.
    var solidCard: Color {
        switch theme {
        case .zood: dark ? ZoodPalette.cardOnInk : ZoodPalette.card
        case .system, .glass: dark ? Color(.secondarySystemBackground) : Color(.systemBackground)
        }
    }

    /// The hairline that gives a surface its edge. Glass wants a light one;
    /// ZOOD wants a warm one that reads on paper.
    var edge: Color {
        switch theme {
        case .zood: dark ? ZoodPalette.gold.opacity(0.34) : ZoodPalette.goldDeep.opacity(0.30)
        case .glass: dark ? .white.opacity(0.18) : .white.opacity(0.55)
        case .system: .white.opacity(0.14)
        }
    }

    /// A card's shadow. ZOOD's is warm and short, glass's is wide and soft.
    var shadowColour: Color {
        switch theme {
        case .zood: dark ? .black.opacity(0.4) : ZoodPalette.goldDeep.opacity(0.12)
        case .glass: dark ? .black.opacity(0.35) : Color(red: 0.1, green: 0.2, blue: 0.4).opacity(0.12)
        case .system: .black.opacity(0.06)
        }
    }

    var shadowRadius: CGFloat { theme == .zood ? 6 : 12 }
    var shadowOffset: CGFloat { theme == .zood ? 2 : 5 }

    /// ZOOD's type treatment: its headings are set a weight heavier than the
    /// system's, which is the only change a theme may make to type — a face
    /// of its own would break Arabic shaping and Dynamic Type.
    var headingWeight: Font.Weight {
        theme == .zood ? .heavy : .bold
    }

    /// A tool's coloured tile. The system and glass themes keep the six
    /// pastels the design system gives each tool; ZOOD puts every tile in its
    /// own gold, the way an app with a brand does — the glyph still tells
    /// them apart, and on ZOOD's ground six pastels read as somebody else's.
    func tile(_ colour: Color) -> Color {
        theme == .zood ? tint : colour
    }
}

// MARK: - The theme in the environment

extension EnvironmentValues {
    /// The theme every themed surface reads. `appEnvironment()` puts the
    /// chosen one here; a preview or a test can override it on its own.
    @Entry var appTheme: AppTheme = .system
}

extension View {
    /// The resolved theme, for a view that needs more than a surface.
    func themeStyle(_ theme: AppTheme, _ scheme: ColorScheme, _ reduceTransparency: Bool) -> ThemeStyle {
        ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
    }
}

// MARK: - Surfaces

/// What a surface is for. The three differ only in how much of what is behind
/// them they let through, as the system's own materials do.
enum ThemeSurface {
    /// A card, a panel, a sheet's body: the thickest.
    case card
    /// A bar: navigation, a toolbar, a floating palette.
    case bar
}

// The shape must be insettable: the edge is stroked inside it, so that a
// hairline never straddles the surface's own boundary.
private struct ThemedSurfaceModifier<Outline: InsettableShape>: ViewModifier {
    let surface: ThemeSurface
    let shape: Outline
    let shadowed: Bool
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        let style = ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
        Group {
            if #available(iOS 26.0, *), style.wantsLiquidGlass {
                // The system's own glass: it draws its own edge and its own
                // shadow, so neither is added over it.
                content.glassEffect(.regular, in: shape)
            } else {
                material(content, style)
            }
        }
        .shadow(
            color: shadowed ? style.shadowColour : .clear,
            radius: shadowed ? style.shadowRadius : 0,
            y: shadowed ? style.shadowOffset : 0
        )
    }

    /// The honest fallback: the system's frosted materials, or a solid
    /// colour when nothing may be see-through, with the theme's own edge.
    private func material(_ content: Content, _ style: ThemeStyle) -> some View {
        content
            .background(surface == .bar ? style.barFill : style.cardFill, in: shape)
            .overlay(shape.strokeBorder(style.edge, lineWidth: 1))
    }
}

/// The ground: the theme's gradient behind a whole screen.
struct ThemeGround: View {
    /// What the system theme puts there instead, for a screen that was a
    /// plain window colour before the themes existed and should stay one.
    var systemColour: Color?
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let style = ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
        ZStack {
            if let systemColour, theme == .system {
                systemColour.ignoresSafeArea()
            } else {
                ground(style)
            }
        }
    }

    private func ground(_ style: ThemeStyle) -> some View {
        style.ground
            .ignoresSafeArea()
            // The glass theme's ground carries one soft highlight, so that
            // what is drawn over it has something to bend. Reduce
            // Transparency takes it away with the rest of the depth.
            .overlay(alignment: .top) {
                if style.theme == .glass, style.translucent {
                    RadialGradient(
                        colors: [.white.opacity(scheme == .dark ? 0.10 : 0.55), .clear],
                        center: .top, startRadius: 0, endRadius: 420
                    )
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                }
            }
    }
}

extension View {
    /// A surface of the chosen theme, in whatever shape the caller draws it.
    func themedSurface(_ surface: ThemeSurface, in shape: some InsettableShape, shadowed: Bool = true) -> some View {
        modifier(ThemedSurfaceModifier(surface: surface, shape: shape, shadowed: shadowed))
    }

    /// A card, a panel or a sheet's body in the chosen theme.
    func themedCard(radius: CGFloat = Radius.sheet, shadowed: Bool = true) -> some View {
        themedSurface(.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous), shadowed: shadowed)
    }

    /// A bar or a floating palette in the chosen theme.
    func themedBar(radius: CGFloat = Radius.sheet, shadowed: Bool = true) -> some View {
        themedSurface(.bar, in: RoundedRectangle(cornerRadius: radius, style: .continuous), shadowed: shadowed)
    }

    /// The ground behind a whole screen. `systemColour` is what the system
    /// theme puts there instead, for a screen that was a plain window colour
    /// before the themes existed.
    func themedGround(systemColour: Color? = nil) -> some View {
        background(ThemeGround(systemColour: systemColour))
    }
}

/// The navigation and bottom bars. The system and glass themes leave them to
/// the system — on iOS 26 those bars are already Liquid Glass, and nothing
/// the app could draw would be better glass than the system's own. ZOOD gives
/// them its ink or its paper, because its whole point is that nothing is
/// see-through.
private struct ThemedToolbarModifier: ViewModifier {
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if theme == .zood {
            let style = ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
            content.toolbarBackground(style.solidCard, for: .navigationBar, .bottomBar, .tabBar)
        } else {
            content
        }
    }
}

extension View {
    /// The bars of a screen in the chosen theme.
    func themedToolbar() -> some View {
        modifier(ThemedToolbarModifier())
    }
}

/// A list or a form on the theme's ground. On the system theme nothing
/// changes — the grouped background is the system's own, and that is what
/// that theme means.
private struct ThemedScrollBackground: ViewModifier {
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if theme == .system {
            content
        } else {
            let style = ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
            content
                .scrollContentBackground(.hidden)
                .listRowBackground(
                    Rectangle().fill(style.translucent ? AnyShapeStyle(.regularMaterial) : AnyShapeStyle(style.solidCard))
                )
                .themedGround()
        }
    }
}

extension View {
    /// A `List` or a `Form` drawn on the theme's ground.
    func themedScrollBackground() -> some View {
        modifier(ThemedScrollBackground())
    }
}

/// The accent, applied once at the root of a scene so that every control the
/// system draws — switches, pickers, links — takes the theme's colour.
struct ThemeTint: ViewModifier {
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        let style = ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
        content.tint(style.tint)
    }
}
