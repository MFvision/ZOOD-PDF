import PDFKit
import SwiftUI

/// Crop: drag the four edges over the page; what is outside goes. The
/// margins, in points, apply to this page or to all through `pages.crop`.
struct CropSheet: View {
    @Bindable var pages: PagesModel
    let cache: PageThumbnailCache
    let page: Int
    @Environment(\.dismiss) private var dismiss
    @State private var inset = EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0)
    @State private var allPages = false
    @State private var drag: (edge: Edge, start: CGFloat)?

    private var model: DocumentModel { pages.model }

    private var pageSize: CGSize {
        guard let pdfPage = model.pdf?.page(at: page) else { return CGSize(width: 595, height: 842) }
        return PageSpace.Frame(page: pdfPage).shownSize
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: Space.x5) {
                GeometryReader { geometry in
                    let fit = fitted(in: geometry.size)
                    ZStack {
                        Group {
                            if let image = cache.image(of: page, in: model, width: 600) {
                                Image(uiImage: image).resizable()
                            } else {
                                Surface.paper
                            }
                        }
                        .frame(width: fit.width, height: fit.height)
                        .overlay {
                            cropOverlay(in: fit)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .padding(Space.x5)
                Form {
                    Section {
                        LabeledContent("Kept") {
                            Text("\(Int(keptSize.width)) × \(Int(keptSize.height)) pt")
                                .tabularNumbers()
                        }
                        Toggle("Every page", isOn: $allPages)
                            .accessibilityIdentifier("crop.allPages")
                        Button("Reset") { inset = EdgeInsets() }
                            .disabled(inset == EdgeInsets())
                    }
                }
                .frame(maxHeight: 170)
                .scrollDisabled(true)
            }
            .background(Surface.grouped)
            .navigationTitle("Crop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Crop", action: apply)
                        .disabled(inset == EdgeInsets())
                        .accessibilityIdentifier("crop.apply")
                }
            }
        }
        .presentationDetents([.large])
    }

    private var keptSize: CGSize {
        CGSize(width: max(pageSize.width - inset.leading - inset.trailing, 1),
               height: max(pageSize.height - inset.top - inset.bottom, 1))
    }

    private func fitted(in available: CGSize) -> CGRect {
        let scale = min(available.width / pageSize.width, available.height / pageSize.height)
        let size = CGSize(width: pageSize.width * scale, height: pageSize.height * scale)
        return CGRect(x: (available.width - size.width) / 2, y: (available.height - size.height) / 2, width: size.width, height: size.height)
    }

    /// The dimmed outside, the kept box, and a handle on each edge that
    /// follows the finger.
    private func cropOverlay(in fit: CGRect) -> some View {
        let scale = fit.width / pageSize.width
        let kept = CGRect(x: inset.leading * scale, y: inset.top * scale,
                          width: keptSize.width * scale, height: keptSize.height * scale)
        return ZStack(alignment: .topLeading) {
            Color.black.opacity(0.45)
                .mask {
                    Rectangle()
                        .overlay(alignment: .topLeading) {
                            Rectangle()
                                .frame(width: kept.width, height: kept.height)
                                .offset(x: kept.minX, y: kept.minY)
                                .blendMode(.destinationOut)
                        }
                        .compositingGroup()
                }
            Rectangle()
                .strokeBorder(Color.accentColor, lineWidth: 2)
                .frame(width: kept.width, height: kept.height)
                .offset(x: kept.minX, y: kept.minY)
            handle(.top, at: CGPoint(x: kept.midX, y: kept.minY), fit: fit, scale: scale)
            handle(.bottom, at: CGPoint(x: kept.midX, y: kept.maxY), fit: fit, scale: scale)
            handle(.leading, at: CGPoint(x: kept.minX, y: kept.midY), fit: fit, scale: scale)
            handle(.trailing, at: CGPoint(x: kept.maxX, y: kept.midY), fit: fit, scale: scale)
        }
        .frame(width: fit.width, height: fit.height)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("crop.frame")
    }

    private func handle(_ edge: Edge, at point: CGPoint, fit: CGRect, scale: CGFloat) -> some View {
        let horizontal = edge == .top || edge == .bottom
        return Capsule()
            .fill(Color.accentColor)
            .frame(width: horizontal ? 44 : 10, height: horizontal ? 10 : 44)
            .overlay(Capsule().strokeBorder(.white, lineWidth: 1.5))
            .shadow(radius: 2)
            .contentShape(Rectangle().size(width: 60, height: 60))
            .position(point)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if drag == nil { drag = (edge, current(edge)) }
                        let delta = (horizontal ? value.translation.height : value.translation.width) / scale
                        set(edge, (drag?.start ?? 0) + (edge == .bottom || edge == .trailing ? -delta : delta))
                    }
                    .onEnded { _ in drag = nil }
            )
            .accessibilityLabel(Text(edgeName(edge)))
            .accessibilityValue(Text("\(Int(current(edge))) points"))
            .accessibilityAdjustableAction { direction in
                set(edge, current(edge) + (direction == .increment ? 6 : -6))
            }
            .accessibilityIdentifier("crop.handle.\(edgeName(edge))")
    }

    private func edgeName(_ edge: Edge) -> String {
        switch edge {
        case .top: "top"
        case .bottom: "bottom"
        case .leading: "leading"
        case .trailing: "trailing"
        }
    }

    private func current(_ edge: Edge) -> CGFloat {
        switch edge {
        case .top: inset.top
        case .bottom: inset.bottom
        case .leading: inset.leading
        case .trailing: inset.trailing
        }
    }

    private func set(_ edge: Edge, _ value: CGFloat) {
        let limit: CGFloat
        switch edge {
        case .top: limit = pageSize.height - inset.bottom - 36
        case .bottom: limit = pageSize.height - inset.top - 36
        case .leading: limit = pageSize.width - inset.trailing - 36
        case .trailing: limit = pageSize.width - inset.leading - 36
        }
        let clamped = min(max(value, 0), max(limit, 0))
        switch edge {
        case .top: inset.top = clamped
        case .bottom: inset.bottom = clamped
        case .leading: inset.leading = clamped
        case .trailing: inset.trailing = clamped
        }
    }

    private func apply() {
        // The page's left edge is the leading one as shown; the core takes
        // margins as the page is shown.
        let margins = PagesModel.Margins(top: Float(inset.top), right: Float(inset.trailing), bottom: Float(inset.bottom), left: Float(inset.leading))
        let which = allPages ? Array(0..<pages.pageCount) : [page]
        pages.crop(which, margins: margins)
        dismiss()
    }
}
