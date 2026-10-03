import SwiftUI

/// Simple mosque glyph (dome, finial, two minarets) in a unit square; used for pins and the radar.
struct MosqueGlyph: Shape {
    func path(in r: CGRect) -> Path {
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: r.minX + x * r.width, y: r.minY + y * r.height) }
        var path = Path()
        // Base
        path.addRect(CGRect(origin: p(0.2, 0.6), size: CGSize(width: 0.6 * r.width, height: 0.34 * r.height)))
        // Onion dome
        path.move(to: p(0.24, 0.62))
        path.addCurve(to: p(0.5, 0.2), control1: p(0.22, 0.42), control2: p(0.42, 0.3))
        path.addCurve(to: p(0.76, 0.62), control1: p(0.58, 0.3), control2: p(0.78, 0.42))
        path.closeSubpath()
        // Finial and crescent dot
        path.addRect(CGRect(origin: p(0.485, 0.1), size: CGSize(width: 0.03 * r.width, height: 0.12 * r.height)))
        path.addEllipse(in: CGRect(origin: p(0.465, 0.04), size: CGSize(width: 0.07 * r.width, height: 0.07 * r.height)))
        // Minarets
        for x in [0.04, 0.86] as [CGFloat] {
            path.addRect(CGRect(origin: p(x, 0.32), size: CGSize(width: 0.1 * r.width, height: 0.62 * r.height)))
            path.move(to: p(x, 0.32))
            path.addLine(to: p(x + 0.05, 0.16))
            path.addLine(to: p(x + 0.1, 0.32))
            path.closeSubpath()
        }
        return path
    }
}

/// Mosque skyline for the horizon: a large dome with two side domes and two tall minarets.
struct MosqueSkyline: Shape {
    func path(in r: CGRect) -> Path {
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: r.minX + x * r.width, y: r.minY + y * r.height) }
        var path = Path()
        path.addRect(CGRect(origin: p(0.16, 0.66), size: CGSize(width: 0.68 * r.width, height: 0.34 * r.height)))
        func dome(_ cx: CGFloat, _ halfW: CGFloat, base: CGFloat, top: CGFloat) {
            path.move(to: p(cx - halfW, base))
            path.addCurve(to: p(cx, top), control1: p(cx - halfW * 1.05, base - (base - top) * 0.55), control2: p(cx - halfW * 0.45, top + (base - top) * 0.2))
            path.addCurve(to: p(cx + halfW, base), control1: p(cx + halfW * 0.45, top + (base - top) * 0.2), control2: p(cx + halfW * 1.05, base - (base - top) * 0.55))
            path.closeSubpath()
            path.addRect(CGRect(origin: p(cx - 0.004, top - 0.08), size: CGSize(width: 0.008 * r.width, height: 0.09 * r.height)))
        }
        dome(0.5, 0.17, base: 0.68, top: 0.2)
        dome(0.27, 0.08, base: 0.7, top: 0.46)
        dome(0.73, 0.08, base: 0.7, top: 0.46)
        for x in [0.06, 0.9] as [CGFloat] {
            path.addRect(CGRect(origin: p(x, 0.12), size: CGSize(width: 0.04 * r.width, height: 0.88 * r.height)))
            path.addRect(CGRect(origin: p(x - 0.008, 0.34), size: CGSize(width: 0.056 * r.width, height: 0.03 * r.height)))
            path.move(to: p(x, 0.12))
            path.addLine(to: p(x + 0.02, 0.0))
            path.addLine(to: p(x + 0.04, 0.12))
            path.closeSubpath()
        }
        return path
    }
}

/// The Kaaba as a small isometric cube with its gold band; used on the full compass.
struct KaabaIcon: View {
    var size: CGFloat = 34
    var body: some View {
        Canvas { ctx, s in
            let w = s.width, h = s.height
            var front = Path()
            front.addRect(CGRect(x: w * 0.12, y: h * 0.3, width: w * 0.5, height: h * 0.58))
            var side = Path()
            side.move(to: CGPoint(x: w * 0.62, y: h * 0.3))
            side.addLine(to: CGPoint(x: w * 0.88, y: h * 0.18))
            side.addLine(to: CGPoint(x: w * 0.88, y: h * 0.74))
            side.addLine(to: CGPoint(x: w * 0.62, y: h * 0.88))
            side.closeSubpath()
            var top = Path()
            top.move(to: CGPoint(x: w * 0.12, y: h * 0.3))
            top.addLine(to: CGPoint(x: w * 0.38, y: h * 0.18))
            top.addLine(to: CGPoint(x: w * 0.88, y: h * 0.18))
            top.addLine(to: CGPoint(x: w * 0.62, y: h * 0.3))
            top.closeSubpath()
            ctx.fill(front, with: .color(Color(hex: 0x111111)))
            ctx.fill(side, with: .color(Color(hex: 0x262626)))
            ctx.fill(top, with: .color(Color(hex: 0x3A3A3A)))
            ctx.fill(Path(CGRect(x: w * 0.12, y: h * 0.4, width: w * 0.5, height: h * 0.07)), with: .color(Theme.gold))
            var band = Path()
            band.move(to: CGPoint(x: w * 0.62, y: h * 0.4))
            band.addLine(to: CGPoint(x: w * 0.88, y: h * 0.28))
            band.addLine(to: CGPoint(x: w * 0.88, y: h * 0.35))
            band.addLine(to: CGPoint(x: w * 0.62, y: h * 0.47))
            band.closeSubpath()
            ctx.fill(band, with: .color(Theme.goldDeep))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
