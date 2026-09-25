import SwiftUI
import ZoodCore

/// The captured picture with four draggable corner handles (dark UI, like the camera).
struct CornerEditor: View {
    let image: ScanImage
    let title: LocalizedStringKey
    let onRetake: () -> Void
    let onUse: (Quad) -> Void

    @State private var quad: Quad

    init(image: ScanImage, quad: Quad?, title: LocalizedStringKey, onRetake: @escaping () -> Void, onUse: @escaping (Quad) -> Void) {
        self.image = image
        self.title = title
        self.onRetake = onRetake
        self.onUse = onUse
        _quad = State(initialValue: quad ?? Quad.inset(image.size))
    }

    var body: some View {
        VStack(spacing: 16) {
            Text(title).font(.headline).foregroundStyle(.white)
            GeometryReader { geo in
                let fit = ScanLayout.aspectFit(image.size, in: Rect2(x: 0, y: 0, width: geo.size.width, height: geo.size.height))
                let s = fit.width / image.size.width
                let toView = { (p: Point2) in CGPoint(x: fit.x + p.x * s, y: fit.y + p.y * s) }
                ZStack(alignment: .topLeading) {
                    Image(decorative: image.cg, scale: 1)
                        .resizable()
                        .frame(width: fit.width, height: fit.height)
                        .offset(x: fit.x, y: fit.y)
                    Path { path in
                        let pts = quad.points.map(toView)
                        path.addLines(pts)
                        path.closeSubpath()
                    }
                    .fill(Color.accentColor.opacity(0.15))
                    Path { path in
                        let pts = quad.points.map(toView)
                        path.addLines(pts)
                        path.closeSubpath()
                    }
                    .stroke(Color.accentColor, lineWidth: 2)
                    ForEach(0..<4, id: \.self) { i in
                        handle(i, at: toView(quad.points[i]))
                            .gesture(
                                DragGesture(coordinateSpace: .named("corners")).onChanged { g in
                                    let p = Point2(
                                        min(max((g.location.x - fit.x) / s, 0), image.size.width),
                                        min(max((g.location.y - fit.y) / s, 0), image.size.height))
                                    set(i, p)
                                }
                            )
                    }
                }
                .coordinateSpace(.named("corners"))
            }
            HStack {
                Button("scan.retake", action: onRetake)
                    .buttonStyle(.bordered)
                    .tint(.white)
                Spacer()
                Button("scan.resetCorners") { quad = Quad.inset(image.size, by: 0) }
                    .foregroundStyle(.white.opacity(0.8))
                Spacer()
                Button("scan.useScan") { onUse(Quad.ordered(quad.points) ?? quad) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("scan.useScan")
            }
            .padding(.horizontal)
        }
        .padding(.vertical)
        .background(Color.black.ignoresSafeArea())
    }

    private func handle(_ index: Int, at point: CGPoint) -> some View {
        Circle()
            .fill(.white)
            .frame(width: 26, height: 26)
            .overlay(Circle().strokeBorder(Color.accentColor, lineWidth: 3))
            .shadow(radius: 3)
            .frame(width: 48, height: 48) // comfortable hit area
            .contentShape(Circle())
            .position(point)
            .accessibilityElement()
            .accessibilityLabel(Text(cornerName(index)))
            .accessibilityAdjustableAction { direction in
                // VoiceOver: swipe up/down moves the corner outwards/inwards by 2 % of the image.
                let d = (direction == .increment ? -1.0 : 1.0) * 0.02
                var p = quad.points[index]
                let cx = image.size.width / 2
                let cy = image.size.height / 2
                p.x += (p.x < cx ? d : -d) * image.size.width
                p.y += (p.y < cy ? d : -d) * image.size.height
                set(index, p)
            }
    }

    private func set(_ index: Int, _ p: Point2) {
        switch index {
        case 0: quad.topLeft = p
        case 1: quad.topRight = p
        case 2: quad.bottomRight = p
        default: quad.bottomLeft = p
        }
    }

    private func cornerName(_ i: Int) -> LocalizedStringKey {
        switch i {
        case 0: "scan.corner.topLeft"
        case 1: "scan.corner.topRight"
        case 2: "scan.corner.bottomRight"
        default: "scan.corner.bottomLeft"
        }
    }
}
