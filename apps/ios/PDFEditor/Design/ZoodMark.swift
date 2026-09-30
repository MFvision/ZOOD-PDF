import SwiftUI

// The ZOOD mark, in the app. It is the same drawing as the app icon
// (scripts/icon/make_zood_icon.py, whose 1024-point grid the numbers below
// are taken from): a slab Z — ZOOD's initial, and the stroke of the Arabic
// zay — drawn as a leaflet folded in a Z, three panels of one gold on ink.
// Original artwork; it copies nobody's icon.

/// The letter, as three paths on a unit square. The head is the top bar, the
/// fold the diagonal, the foot the bottom bar; each takes the light
/// differently, which is what makes the letter read as paper close up and as
/// one shape at 20 points.
enum ZoodLetter {
    // The icon's grid, divided by 1024.
    private static let left = 292.0 / 1024
    private static let right = 732.0 / 1024
    private static let top = 308.0 / 1024
    private static let bottom = 716.0 / 1024
    private static let bar = 92.0 / 1024
    private static let shear = 156.0 / 1024

    private static var headBottom: Double { top + bar }
    private static var footTop: Double { bottom - bar }
    private static var outerFoot: Double { left + shear }
    private static var innerHead: Double { right - shear }

    private static func path(_ points: [(Double, Double)], in rect: CGRect) -> Path {
        var path = Path()
        for (index, point) in points.enumerated() {
            let place = CGPoint(x: rect.minX + rect.width * point.0, y: rect.minY + rect.height * point.1)
            if index == 0 { path.move(to: place) } else { path.addLine(to: place) }
        }
        path.closeSubpath()
        return path
    }

    static func head(in rect: CGRect) -> Path {
        path([(left, top), (right, top), (right, headBottom), (left, headBottom)], in: rect)
    }

    /// The fold reaches a hair into the head and the foot, which are drawn
    /// over it: two shapes that merely meet leave a light seam where they do.
    static func fold(in rect: CGRect) -> Path {
        let seam = 2.0 / 1024
        return path(
            [(innerHead, headBottom - seam), (right, headBottom - seam), (outerFoot, footTop + seam), (left, footTop + seam)],
            in: rect
        )
    }

    static func foot(in rect: CGRect) -> Path {
        path([(left, footTop), (right, footTop), (right, bottom), (left, bottom)], in: rect)
    }
}

/// The whole letter as one shape, for a place that wants it in a single
/// colour — a template image, a mask, the tinted app icon.
struct ZoodLetterShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = ZoodLetter.head(in: rect)
        path.addPath(ZoodLetter.fold(in: rect))
        path.addPath(ZoodLetter.foot(in: rect))
        return path
    }
}

/// The app's mark: the letter on its ink tile, at whatever size it is given.
/// The tile's corner follows the same proportion as the icon's, so the mark
/// beside a title looks like the icon on the Home Screen.
struct ZoodMark: View {
    var size: CGFloat = 32
    /// Off, the letter is drawn on nothing — for a place that already has a
    /// dark ground of its own.
    var showsTile = true

    private var rect: CGRect { CGRect(x: 0, y: 0, width: size, height: size) }

    var body: some View {
        ZStack {
            if showsTile {
                RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [ZoodPalette.inkLight, ZoodPalette.ink, ZoodPalette.inkDeep],
                            startPoint: .topLeading, endPoint: .bottomTrailing
                        )
                    )
            }
            ZoodLetter.fold(in: rect).fill(gold(ZoodPalette.gold, ZoodPalette.goldDeep))
            ZoodLetter.head(in: rect).fill(gold(ZoodPalette.goldLight, ZoodPalette.gold))
            ZoodLetter.foot(in: rect).fill(gold(ZoodPalette.gold, ZoodPalette.goldDeep))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func gold(_ start: Color, _ end: Color) -> LinearGradient {
        LinearGradient(colors: [start, end], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

#Preview {
    HStack(spacing: Space.x5) {
        ZoodMark(size: 20)
        ZoodMark(size: 32)
        ZoodMark(size: 64)
    }
    .padding()
}
