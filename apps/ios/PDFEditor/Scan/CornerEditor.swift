import SwiftUI

/// The page's corners by hand: four handles that follow the finger 1:1
/// from where it grabbed them, a magnifier over the corner while it is
/// dragged so the edge under the fingertip can be seen, the quad drawn
/// live, a haptic when a handle is let go. Auto asks Vision again; Whole
/// takes the whole photo.
struct CornerEditor: View {
    let image: CGImage
    @State private var quad: Quad
    let onDone: (Quad) -> Void
    let onCancel: () -> Void
    let onAuto: () async -> Quad?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    @State private var dragging: Int?
    @State private var dragStart: Quad?
    @State private var finger: CGPoint = .zero
    @State private var releases = 0
    @State private var detecting = false

    private static let magnifierSize: CGFloat = 132
    private static let magnification: CGFloat = 2.6

    init(image: CGImage, quad: Quad, onDone: @escaping (Quad) -> Void, onCancel: @escaping () -> Void, onAuto: @escaping () async -> Quad?) {
        self.image = image
        _quad = State(initialValue: quad)
        self.onDone = onDone
        self.onCancel = onCancel
        self.onAuto = onAuto
    }

    private var imageSize: CGSize { CGSize(width: image.width, height: image.height) }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                let bounds = CGRect(origin: .zero, size: geometry.size).insetBy(dx: Space.x8, dy: Space.x8)
                let fit = ScanGeometry.fit(imageSize, in: bounds)
                ZStack {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: fit.width, height: fit.height)
                        .position(x: fit.midX, y: fit.midY)
                    // Outside the corners, the photo dims.
                    DimmingShape(quad: quad, imageSize: imageSize, rect: fit)
                        .fill(Color.black.opacity(0.35), style: FillStyle(eoFill: true))
                        .allowsHitTesting(false)
                    QuadShape(quad: quad, imageSize: imageSize, rect: fit)
                        .stroke(quad.isConvex ? Color.accentColor : Color.red, style: StrokeStyle(lineWidth: 2, lineJoin: .round))
                    ForEach(0..<4, id: \.self) { corner in
                        handle(corner, fit: fit)
                    }
                    if let dragging {
                        magnifier(corner: dragging, fit: fit, in: geometry.size)
                            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                    }
                }
                .frame(width: geometry.size.width, height: geometry.size.height)
                .coordinateSpace(name: "editor")
                .animation(dragging == nil ? Motion.travel(reduceMotion: reduceMotion) : nil, value: quad)
            }
            .background(Color.black.opacity(0.9))
            .navigationTitle("Corners")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .accessibilityIdentifier("crop.cancel")
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button("Auto", systemImage: "sparkles") {
                        detecting = true
                        Task {
                            if let found = await onAuto() {
                                withAnimation(Motion.flick) { quad = found }
                            }
                            detecting = false
                        }
                    }
                    .disabled(detecting)
                    .accessibilityIdentifier("crop.auto")
                    Button("Whole", systemImage: "rectangle.dashed") {
                        withAnimation(Motion.travel(reduceMotion: reduceMotion)) { quad = .whole(imageSize) }
                    }
                    .accessibilityIdentifier("crop.whole")
                    Button("Done") { onDone(quad) }
                        .disabled(!quad.isConvex)
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("crop.done")
                }
            }
        }
        .sensoryFeedback(.impact(flexibility: .soft), trigger: releases)
        .accessibilityIdentifier("crop.editor")
    }

    private func handle(_ corner: Int, fit: CGRect) -> some View {
        let point = ScanGeometry.viewPoint(quad[corner], imageSize: imageSize, in: fit)
        let active = dragging == corner
        return ZStack {
            Circle()
                .fill(Color.white)
                .frame(width: 22, height: 22)
            Circle()
                .stroke(Color.accentColor, lineWidth: 3)
                .frame(width: 22, height: 22)
        }
        .scaleEffect(active && !reduceMotion ? 1.35 : 1)
        .frame(width: 56, height: 56)
        .contentShape(Circle())
        .position(point)
        .animation(Motion.press, value: active)
        .gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .named("editor"))
                .onChanged { value in
                    if dragging != corner {
                        dragging = corner
                        dragStart = quad
                    }
                    guard let start = dragStart else { return }
                    let scale = imageSize.width / fit.width
                    // Right-to-left layouts mirror the horizontal axis of the translation.
                    let dx = value.translation.width * (layoutDirection == .rightToLeft ? -1 : 1) * scale
                    let dy = value.translation.height * scale
                    var moved = start[corner]
                    moved.x = min(max(moved.x + dx, 0), imageSize.width)
                    moved.y = min(max(moved.y + dy, 0), imageSize.height)
                    quad[corner] = moved
                    finger = value.location
                }
                .onEnded { _ in
                    dragging = nil
                    dragStart = nil
                    releases += 1
                }
        )
        .accessibilityElement()
        .accessibilityLabel(cornerName(corner))
        .accessibilityValue(Text(verbatim: "\(Int(quad[corner].x.rounded())),\(Int(quad[corner].y.rounded()))"))
        .accessibilityIdentifier("crop.handle.\(corner)")
    }

    private func cornerName(_ corner: Int) -> Text {
        switch corner {
        case 0: Text("Top-left corner")
        case 1: Text("Top-right corner")
        case 2: Text("Bottom-right corner")
        default: Text("Bottom-left corner")
        }
    }

    /// The photo around the corner, magnified, placed above the finger (or
    /// below it near the top of the screen) so the finger does not hide it,
    /// with a crosshair on the corner itself.
    private func magnifier(corner: Int, fit: CGRect, in size: CGSize) -> some View {
        let pixel = quad[corner]
        let side = Self.magnifierSize
        let scale = fit.width / imageSize.width * Self.magnification
        let handlePoint = ScanGeometry.viewPoint(pixel, imageSize: imageSize, in: fit)
        let above = handlePoint.y - side / 2 - 40 > 0
        let centre = CGPoint(x: min(max(handlePoint.x, side / 2 + Space.x2), size.width - side / 2 - Space.x2),
                             y: above ? handlePoint.y - side / 2 - 40 : handlePoint.y + side / 2 + 40)
        return ZStack {
            Image(decorative: image, scale: 1)
                .resizable()
                .interpolation(.high)
                .frame(width: imageSize.width * scale, height: imageSize.height * scale)
                .offset(x: side / 2 - pixel.x * scale - (imageSize.width * scale - side) / 2,
                        y: side / 2 - pixel.y * scale - (imageSize.height * scale - side) / 2)
            Path { path in
                path.move(to: CGPoint(x: side / 2, y: 0))
                path.addLine(to: CGPoint(x: side / 2, y: side))
                path.move(to: CGPoint(x: 0, y: side / 2))
                path.addLine(to: CGPoint(x: side, y: side / 2))
            }
            .stroke(Color.accentColor.opacity(0.9), lineWidth: 1)
        }
        .frame(width: side, height: side)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white, lineWidth: 2.5))
        .shadow(color: .black.opacity(0.35), radius: 8, y: 4)
        .position(centre)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .accessibilityIdentifier("crop.magnifier")
    }
}

/// The dimming outside the corners: the photo's rectangle with the quad
/// cut out of it (filled even-odd), animatable with the corners.
struct DimmingShape: Shape {
    var quad: Quad
    var imageSize: CGSize
    var rect: CGRect

    var animatableData: QuadShape.AnimatableData {
        get { QuadShape(quad: quad, imageSize: imageSize, rect: rect).animatableData }
        set {
            var shape = QuadShape(quad: quad, imageSize: imageSize, rect: rect)
            shape.animatableData = newValue
            quad = shape.quad
        }
    }

    func path(in _: CGRect) -> Path {
        var path = Path(rect)
        path.addPath(QuadShape(quad: quad, imageSize: imageSize, rect: rect).path(in: rect))
        return path
    }
}
