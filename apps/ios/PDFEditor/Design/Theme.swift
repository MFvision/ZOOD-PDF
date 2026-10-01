import SwiftUI

// The design tokens, the iOS counterpart of docs/design/README.md: system
// colours named for what a surface is, the system's text styles (Dynamic
// Type comes with them), a 4-point grid, the same radii as the desktop, and
// motion that is feedback on what the person did — critically damped by
// default, a little bounce only after a flick, a cross-fade under Reduce
// Motion. Nothing here is a hard-coded colour: ZOOD's come from its palette.

/// Surfaces and text, by what they are. Each is the system's colour on the
/// system and glass themes and ZOOD's own on the Zood theme — the paper and
/// the navy of its guide — resolved from the theme in the traits
/// (`Color.themed`, Design/Brand.swift), so a screen asks for `label` and
/// gets the right ink whatever the theme.
enum Surface {
    /// The window, the Library, the sheets' body.
    static let window = Color.themed(system: .systemBackground, paper: ZoodPalette.beige60, navy: ZoodPalette.navy)
    /// Grouped inset sections and cards.
    static let grouped = Color.themed(system: .systemGroupedBackground, paper: ZoodPalette.beige60, navy: ZoodPalette.navy)
    static let groupedCell = Color.themed(system: .secondarySystemGroupedBackground, paper: ZoodPalette.paper, navy: ZoodPalette.navy95)
    /// Behind the pages: the grey paper sits on.
    static let underPage = Color.themed(system: .secondarySystemBackground, paper: ZoodPalette.beige, navy: ZoodPalette.navyDeep)
    /// The paper itself.
    static let paper = Color.white
    static let separator = Color.themed(
        system: .separator,
        paper: ZoodPalette.bronze.withAlphaComponent(0.35),
        navy: ZoodPalette.bronzeOnNavy.withAlphaComponent(0.32)
    )
    static let label = Color.themed(system: .label, paper: ZoodPalette.inkOnPaper, navy: ZoodPalette.inkOnNavy)
    static let secondaryLabel = Color.themed(system: .secondaryLabel, paper: ZoodPalette.secondaryOnPaper, navy: ZoodPalette.secondaryOnNavy)
    static let tertiaryLabel = Color.themed(system: .tertiaryLabel, paper: ZoodPalette.tertiaryOnPaper, navy: ZoodPalette.tertiaryOnNavy)
}

/// The 4-point grid.
enum Space {
    static let x1: CGFloat = 2
    static let x2: CGFloat = 4
    static let x3: CGFloat = 8
    static let x4: CGFloat = 12
    static let x5: CGFloat = 16
    static let x6: CGFloat = 20
    static let x7: CGFloat = 24
    static let x8: CGFloat = 32
    static let x9: CGFloat = 40
    static let x10: CGFloat = 48
}

/// Corner radii, the same steps as the desktop's tokens.
enum Radius {
    static let control: CGFloat = 6
    static let button: CGFloat = 8
    static let group: CGFloat = 10
    static let card: CGFloat = 12
    static let sheet: CGFloat = 16
}

/// Paper on the grey, and cards on the window.
enum Depth {
    static func page<V: View>(_ view: V) -> some View {
        view.shadow(color: .black.opacity(0.16), radius: 6, y: 3)
            .shadow(color: .black.opacity(0.06), radius: 1, y: 0.5)
    }
}

/// Motion as feedback. `travel` is the default for anything that moves
/// (damping 1, no overshoot); `flick` only after a gesture that carried
/// momentum; `quick` for fades and colour changes. Under Reduce Motion
/// everything that would travel cross-fades instead.
enum Motion {
    static let travel: Animation = .smooth(duration: 0.35)
    static let flick: Animation = .spring(duration: 0.35, bounce: 0.2)
    static let quick: Animation = .easeOut(duration: 0.16)
    static let press: Animation = .easeOut(duration: 0.09)

    /// The animation for something that travels, respecting Reduce Motion.
    static func travel(reduceMotion: Bool) -> Animation {
        reduceMotion ? quick : travel
    }
}

/// Type: the system's text styles, so Dynamic Type applies everywhere.
/// Numbers that change in place are tabular. Arabic is never tracked.
enum TextStyle {
    static let largeTitle: Font = .largeTitle.weight(.bold)
    static let title: Font = .title2.weight(.semibold)
    static let headline: Font = .headline
    static let body: Font = .body
    static let callout: Font = .callout
    static let subheadline: Font = .subheadline
    static let caption: Font = .caption
}

extension View {
    /// Numbers that change in place — page counts, sizes — keep their width.
    func tabularNumbers() -> some View {
        monospacedDigit()
    }
}
