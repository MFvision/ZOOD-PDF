import SwiftUI

// The look of the chrome, chosen in Settings and kept: the system's, Liquid
// Glass, or ZOOD's own. It is a layer over the tokens in Theme.swift, not a
// replacement for them — every screen still asks for `Surface.label`, `Space`
// and `Radius`; what changes is the material under them, the ground behind
// them, the accent on them and, on ZOOD's, the colours and faces themselves.
//
// The glass theme follows the system's own rule for glass: it is for the
// layer that floats over the content — bars, toolbars, the floating pen
// palette — and never for the content itself. Pages, cards and lists stay
// solid and legible; the glass is the system's (`glassEffect`, iOS 26) or,
// below it, the system's frosted bar material.
//
// The system's accessibility settings decide how far a theme goes. Reduce
// Transparency turns every material into the solid colour behind it, on
// every theme. Increase Contrast gives every surface a firmer edge, makes
// the glass theme's bars solid and takes ZOOD's texture away. Reduce Motion
// is left to `Motion`, as everywhere else.

/// The three looks Settings offers.
enum AppTheme: String, CaseIterable, Identifiable, Sendable {
    /// The system's own materials and accent — what the app looked like before.
    case system
    /// Liquid Glass: the system's glass on the navigation and control layer
    /// where the OS has it (iOS 26 and later), its materials where it does not.
    case glass
    /// ZOOD's: its navy, beige and copper, its faces and its pattern, opaque.
    case zood

    var id: String { rawValue }

    /// The theme before the person chooses one: ZOOD's own, from the first launch.
    static let standard: AppTheme = .zood

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
        case .glass: "Glass on the bars, toolbars and floating palettes only; documents and lists stay solid. Needs iOS 26 for the system's own glass; on older systems the bars use the frosted materials."
        case .zood: "ZOOD's own: navy, warm beige and copper, its typefaces and its pattern."
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

/// A theme resolved for the screen it is being drawn on: the colour scheme,
/// and the accessibility settings that change it. Everything a view needs
/// to draw a surface is read from here, never guessed at the call site.
struct ThemeStyle {
    let theme: AppTheme
    let scheme: ColorScheme
    let reduceTransparency: Bool
    let increaseContrast: Bool

    init(theme: AppTheme, scheme: ColorScheme, reduceTransparency: Bool, increaseContrast: Bool = false) {
        self.theme = theme
        self.scheme = scheme
        self.reduceTransparency = reduceTransparency
        self.increaseContrast = increaseContrast
    }

    private var dark: Bool { scheme == .dark }

    /// Whether a surface of this kind is the system's own Liquid Glass. Only
    /// the glass theme's bars are — never a card, a list or a page — and
    /// not when the person asked for less transparency or more contrast.
    /// `ThemedSurface` still writes the `#available` branch, because an
    /// availability check cannot be carried in a Bool.
    func wantsLiquidGlass(_ surface: ThemeSurface) -> Bool {
        theme == .glass && surface == .bar && !reduceTransparency && !increaseContrast
    }

    /// Whether the glass theme asks for the system's glass at all.
    var wantsLiquidGlass: Bool { wantsLiquidGlass(.bar) }

    /// Whether anything on this theme is see-through at all.
    var translucent: Bool {
        theme != .zood && !reduceTransparency
    }

    /// The accent: the system's (which is the person's own on iOS) for the
    /// system and glass themes; ZOOD's bronze, a step darker on the paper and
    /// a step lighter on the navy, so it reads as text on either.
    var tint: Color {
        switch theme {
        case .system, .glass: .accentColor
        case .zood: Color(uiColor: dark ? ZoodPalette.bronzeOnNavy : ZoodPalette.bronzeDeep)
        }
    }

    /// The text on a control filled with the tint: white on ZOOD's deep
    /// bronze, ZOOD's navy on its light one — each AA.
    var onTint: Color {
        theme == .zood && dark ? Color(uiColor: ZoodPalette.navy) : .white
    }

    /// The ground a screen's content sits on.
    var ground: LinearGradient {
        LinearGradient(colors: groundColors, startPoint: .top, endPoint: .bottom)
    }

    private var groundColors: [Color] {
        switch theme {
        case .system:
            dark
                ? [Color(red: 0.09, green: 0.11, blue: 0.16), Color(red: 0.05, green: 0.06, blue: 0.09)]
                : [Color(red: 0.86, green: 0.92, blue: 0.99), Color(red: 0.97, green: 0.98, blue: 1.0)]
        case .glass:
            // The system's own grouped ground. The glass is over the content;
            // the content does not need a coloured sky under it, and one
            // would fight the documents for attention.
            [Color(.systemGroupedBackground)]
        case .zood:
            // The paper, or the navy, all but flat: the brand is calm, and a
            // gradient would be decoration.
            dark
                ? [Color(uiColor: ZoodPalette.navy), Color(uiColor: ZoodPalette.navyDeep)]
                : [Color(uiColor: ZoodPalette.beige60), Color(uiColor: UIColor(hex: 0xE1D6CB))]
        }
    }

    /// What a card is filled with. On the glass theme a card is content, so
    /// it is solid; under Reduce Transparency, and on ZOOD's, every card is.
    var cardFill: AnyShapeStyle {
        if !translucent || theme == .glass { return AnyShapeStyle(solidCard) }
        return AnyShapeStyle(.regularMaterial)
    }

    /// The bar chrome — navigation, toolbars, the markup bar's palette.
    var barFill: AnyShapeStyle {
        if !translucent || increaseContrast { return AnyShapeStyle(solidBar) }
        return AnyShapeStyle(theme == .glass ? .bar : .regularMaterial)
    }

    /// The colour a card is when it is solid.
    var solidCard: Color {
        switch theme {
        case .zood: Color(uiColor: dark ? ZoodPalette.navy95 : ZoodPalette.paper)
        case .glass: Color(.secondarySystemGroupedBackground)
        case .system: dark ? Color(.secondarySystemBackground) : Color(.systemBackground)
        }
    }

    /// The colour a bar is when it is solid.
    var solidBar: Color {
        switch theme {
        case .zood: solidCard
        case .glass, .system: Color(.secondarySystemBackground)
        }
    }

    /// The hairline that gives a surface its edge: ZOOD's is its bronze,
    /// the others the system's separator. Increase Contrast firms it up.
    var edge: Color {
        switch theme {
        case .zood:
            Color(uiColor: dark ? ZoodPalette.bronzeOnNavy : ZoodPalette.bronze).opacity(increaseContrast ? 0.8 : 0.32)
        case .glass:
            increaseContrast ? Color(.separator) : .clear
        case .system:
            increaseContrast ? Color(.separator) : .white.opacity(0.14)
        }
    }

    /// A card's shadow. ZOOD's is short and faint; the glass theme's cards sit
    /// flat on the ground, as the system's grouped cells do.
    var shadowColour: Color {
        switch theme {
        case .zood: dark ? .black.opacity(0.35) : Color(uiColor: ZoodPalette.navy).opacity(0.07)
        case .glass: .clear
        case .system: .black.opacity(0.06)
        }
    }

    var shadowRadius: CGFloat { theme == .zood ? 8 : 12 }
    var shadowOffset: CGFloat { theme == .zood ? 2 : 5 }

    /// A tool's tile: its glyph and the plate behind it. The system and glass
    /// themes keep the six pastels the design system gives each tool. ZOOD
    /// puts every glyph in copper on a navy plate in light — the foil on the
    /// folder (guide p. 28) — and in the bronze on a faint bronze plate on
    /// the navy; the glyph still tells them apart.
    func tile(_ colour: Color) -> (glyph: Color, plate: Color) {
        guard theme == .zood else { return (colour, colour.opacity(0.16)) }
        return dark
            ? (Color(uiColor: ZoodPalette.bronzeOnNavy), Color(uiColor: ZoodPalette.bronzeOnNavy).opacity(0.14))
            : (Color(uiColor: ZoodPalette.copperLight), Color(uiColor: ZoodPalette.navy))
    }

    /// The weight of a tile's glyph: ZOOD's line icons are thin (guide p. 16).
    var glyphWeight: Font.Weight {
        theme == .zood ? .light : .medium
    }
}

extension View {
    /// The resolved theme, for a view that needs more than a surface.
    func themeStyle(_ theme: AppTheme, _ scheme: ColorScheme, _ reduceTransparency: Bool) -> ThemeStyle {
        ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
    }
}

/// Reads the theme and the accessibility settings that bear on it, once,
/// for a view that draws a themed surface.
private struct ThemeReader<Content: View>: View {
    @ViewBuilder let content: (ThemeStyle) -> Content
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        content(ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency, increaseContrast: contrast == .increased))
    }
}

// MARK: - Surfaces

/// What a surface is for.
enum ThemeSurface {
    /// A card, a panel, a sheet's body: content, so never glass.
    case card
    /// A bar: navigation, a toolbar, a floating palette — the glass layer.
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
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        let style = ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency, increaseContrast: contrast == .increased)
        Group {
            if #available(iOS 26.0, *), style.wantsLiquidGlass(surface) {
                // The system's own glass: it draws its own edge and its own
                // shadow, and it answers the accessibility settings itself.
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
            .overlay(shape.strokeBorder(style.edge, lineWidth: style.increaseContrast ? 1.5 : 1))
    }
}

/// The ground: the theme's colour behind a whole screen.
struct ThemeGround: View {
    /// What the system theme puts there instead, for a screen that was a
    /// plain window colour before the themes existed and should stay one.
    var systemColour: Color?
    @Environment(\.appTheme) private var theme

    var body: some View {
        ThemeReader { style in
            if let systemColour, theme == .system {
                systemColour.ignoresSafeArea()
            } else {
                style.ground.ignoresSafeArea()
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
/// them its navy or its paper, because nothing of it is see-through.
private struct ThemedToolbarModifier: ViewModifier {
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if theme == .zood {
            let style = ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
            content.toolbarBackground(style.ground, for: .navigationBar, .bottomBar, .tabBar)
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

/// A list or a form on the theme's ground. The system and glass themes
/// change nothing — the grouped background and its cells are the system's
/// own, and lists are content, which the glass theme leaves solid. ZOOD's
/// puts its paper cards on its ground.
private struct ThemedScrollBackground: ViewModifier {
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if theme == .zood {
            let style = ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: reduceTransparency)
            content
                .scrollContentBackground(.hidden)
                .listRowBackground(Rectangle().fill(style.solidCard))
                .themedGround()
        } else {
            content
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

/// The one filled button of a screen, in the theme: the tint behind, and on
/// ZOOD's the text colour that passes AA on it.
struct ThemedProminentStyle: PrimitiveButtonStyle {
    @Environment(\.appTheme) private var theme
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        let style = ThemeStyle(theme: theme, scheme: scheme, reduceTransparency: false)
        Button(role: configuration.role, action: configuration.trigger) {
            configuration.label.foregroundStyle(style.onTint)
        }
        .buttonStyle(.borderedProminent)
    }
}

extension PrimitiveButtonStyle where Self == ThemedProminentStyle {
    static var themedProminent: ThemedProminentStyle { ThemedProminentStyle() }
}
