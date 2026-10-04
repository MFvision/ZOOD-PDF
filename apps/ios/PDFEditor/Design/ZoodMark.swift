import SwiftUI

// The app's mark, in the app: ZOOD's own mark (the arcs and the swash that
// make its Z) as the app icon carries it — copper on navy, the way the brand
// foil-stamps it on its folder (guide p. 28). The artwork is the vector
// `ZoodMark` in the asset catalogue, cut from the brand's Main Logo .ai with
// the icon by scripts/icon/make_zood_icons.sh, so the mark beside a title
// and the icon on the Home Screen are one drawing.

/// The icon's composition, in numbers both the generator
/// (scripts/icon/make_zood_icons.py) and the app use.
enum ZoodIcon {
    /// The mark's width as a share of the icon's side (MARK_WIDTH there).
    static let markWidth: CGFloat = 0.60
    /// The mark's own proportions, from its artwork box (507.229 × 409.514).
    static let markAspect: CGFloat = 507.229 / 409.514
    /// The navy ground, top to foot (NAVY there).
    static let ground: [Color] = [0x0A2A55, 0x041E42, 0x031631].map { Color(uiColor: UIColor(hex: $0)) }
    /// The copper, lit edge to shaded (COPPER there).
    static let copper: [Color] = [0xC9A27C, 0x977756, 0x7A5C3F].map { Color(uiColor: UIColor(hex: $0)) }
}

/// The app's mark on its navy tile, at whatever size it is given. The tile's
/// corner follows the icon's proportion, so the mark beside a title looks
/// like the icon on the Home Screen.
struct ZoodMark: View {
    var size: CGFloat = 32
    /// Off, the mark is drawn on nothing, in `colour` — for a place that
    /// has a ground of its own.
    var showsTile = true
    var colour: Color = Surface.label
    /// Off, the tile is square — for comparing with the icon file itself,
    /// which is full bleed (iOS cuts its own corners).
    var rounded = true

    var body: some View {
        ZStack {
            if showsTile {
                RoundedRectangle(cornerRadius: rounded ? size * 0.2237 : 0, style: .continuous)
                    .fill(LinearGradient(colors: ZoodIcon.ground, startPoint: .top, endPoint: .bottom))
                mark
                    .foregroundStyle(
                        LinearGradient(colors: ZoodIcon.copper, startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
            } else {
                mark.foregroundStyle(colour)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var mark: some View {
        Image("ZoodMark")
            .renderingMode(.template)
            .resizable()
            .aspectRatio(ZoodIcon.markAspect, contentMode: .fit)
            .frame(width: size * ZoodIcon.markWidth)
    }
}

#Preview {
    HStack(spacing: Space.x5) {
        ZoodMark(size: 20)
        ZoodMark(size: 32)
        ZoodMark(size: 64)
        ZoodMark(size: 64, showsTile: false)
    }
    .padding()
}
