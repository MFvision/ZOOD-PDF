import PDFKit
import SwiftUI
import WarraqCore

/// The signature floating over the pages until it is placed: dragged
/// with a finger, sized with a pinch, following 1:1, then written into the
/// page by the core (`images.add`, an incremental update) at that spot.
struct SignaturePlacer: View {
    let image: UIImage
    let model: DocumentModel
    let host: PDFViewHost
    let undoManager: UndoManager?
    let finished: () -> Void
    @State private var center: CGPoint?
    @State private var width: CGFloat = 180
    @State private var dragOffset: CGSize = .zero
    @State private var pinch: CGFloat = 1
    @State private var working = false
    @State private var error: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var aspect: CGFloat { image.size.height / max(image.size.width, 1) }

    var body: some View {
        GeometryReader { geometry in
            let at = CGPoint(x: (center?.x ?? geometry.size.width / 2) + dragOffset.width,
                             y: (center?.y ?? geometry.size.height / 2) + dragOffset.height)
            let shownWidth = width * pinch
            ZStack {
                Color.black.opacity(0.001)
                    .contentShape(Rectangle())
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: shownWidth, height: shownWidth * aspect)
                    .padding(Space.x3)
                    .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.button, style: .continuous).strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])))
                    .shadow(color: .black.opacity(0.2), radius: 10, y: 4)
                    .position(at)
                    .gesture(drag(in: geometry.size))
                    .simultaneousGesture(magnify)
                    .accessibilityLabel(Text("Signature, drag to place, pinch to resize"))
                    .accessibilityIdentifier("signature.floating")
                VStack {
                    Spacer()
                    HStack(spacing: Space.x4) {
                        Button("Cancel", role: .cancel, action: finished)
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("signature.cancelPlace")
                        Button {
                            place(at: at, width: shownWidth, in: geometry)
                        } label: {
                            if working {
                                ProgressView()
                            } else {
                                Label("Place here", systemImage: "checkmark")
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(working)
                        .accessibilityIdentifier("signature.confirm")
                    }
                    .padding(Space.x4)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, Space.x6)
                }
            }
            .alert("Could not place the signature", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
        }
    }

    private func drag(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                dragOffset = value.translation
            }
            .onEnded { value in
                let base = center ?? CGPoint(x: size.width / 2, y: size.height / 2)
                var next = CGPoint(x: base.x + value.translation.width, y: base.y + value.translation.height)
                next.x = min(max(next.x, 20), size.width - 20)
                next.y = min(max(next.y, 20), size.height - 20)
                dragOffset = .zero
                withAnimation(reduceMotion ? nil : Motion.flick) {
                    center = next
                }
            }
    }

    private var magnify: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                pinch = value.magnification
            }
            .onEnded { value in
                width = min(max(width * value.magnification, 40), 600)
                pinch = 1
            }
    }

    /// Where the picture floats, in the page's shown space, then through
    /// the core into the page.
    private func place(at point: CGPoint, width shownWidth: CGFloat, in geometry: GeometryProxy) {
        guard let view = host.view else { return }
        let frameInPDFView = CGRect(x: point.x - shownWidth / 2, y: point.y - shownWidth * aspect / 2,
                                    width: shownWidth, height: shownWidth * aspect)
        guard let page = view.page(for: frameInPDFView.origin, nearest: true) ?? view.page(for: CGPoint(x: frameInPDFView.midX, y: frameInPDFView.midY), nearest: true),
              let document = view.document else {
            error = String(localized: "Drop the signature over a page.")
            return
        }
        let index = document.index(for: page)
        let userRect = view.convert(frameInPDFView, to: page)
        let frame = PageSpace.Frame(page: page)
        let shown = PageSpace.shownRect(fromUser: userRect, in: frame)
        working = true
        Task {
            do {
                try await Self.place(image: image, in: shown, on: index, of: model, undoManager: undoManager)
                finished()
            } catch {
                self.error = error.localizedDescription
            }
            working = false
        }
    }

    static func place(image: UIImage, in shown: CGRect, on page: Int, of model: DocumentModel, undoManager: UndoManager?) async throws {
        guard let png = image.pngData() else { throw CoreError.edit("the signature could not be encoded") }
        struct Args: Encodable { let page: Int; let matrix: [Float] }
        try await model.apply("images.add", args: Args(page: page, matrix: PageSpace.uprightMatrix(in: shown)), blobs: [png], undoManager: undoManager)
    }
}
