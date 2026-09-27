import PencilKit
import SwiftUI

/// Draw a signature with a finger or the Pencil, once; it is kept
/// protected and placed on any page afterwards.
struct SignatureSheet: View {
    let store: SignatureStore
    /// Called with the picture to place, kept or just drawn.
    let place: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var drawing = PKDrawing()
    @State private var kept: UIImage?
    @State private var drawingNew = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: Space.x5) {
                if let kept, !drawingNew {
                    VStack(spacing: Space.x4) {
                        Text("Your signature")
                            .font(TextStyle.headline)
                        Image(uiImage: kept)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxHeight: 160)
                            .padding(Space.x5)
                            .background(Surface.paper, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Surface.separator))
                            .accessibilityLabel(Text("Your signature"))
                            .accessibilityIdentifier("signature.kept")
                        HStack(spacing: Space.x4) {
                            Button("Draw a new one", systemImage: "pencil.line") { drawingNew = true }
                                .accessibilityIdentifier("signature.new")
                            Button("Delete", systemImage: "trash", role: .destructive) {
                                store.delete()
                                self.kept = nil
                                drawingNew = true
                            }
                            .accessibilityIdentifier("signature.delete")
                        }
                        .buttonStyle(.bordered)
                    }
                } else {
                    VStack(alignment: .leading, spacing: Space.x3) {
                        Text("Sign here")
                            .font(TextStyle.headline)
                        SignatureCanvas(drawing: $drawing)
                            .frame(height: 220)
                            .background(Surface.paper, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                            .overlay(alignment: .bottom) {
                                Rectangle()
                                    .fill(Surface.separator)
                                    .frame(height: 1)
                                    .padding(.horizontal, Space.x7)
                                    .padding(.bottom, Space.x9)
                                    .allowsHitTesting(false)
                            }
                            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Surface.separator))
                            .accessibilityLabel(Text("Signature canvas"))
                            .accessibilityIdentifier("signature.canvas")
                        HStack {
                            Button("Clear") { drawing = PKDrawing() }
                                .disabled(drawing.strokes.isEmpty)
                                .accessibilityIdentifier("signature.clear")
                            Spacer()
                            Text("It is kept on this device, encrypted, for next time.")
                                .font(TextStyle.caption)
                                .foregroundStyle(Surface.secondaryLabel)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(Space.x5)
            .background(Surface.grouped)
            .navigationTitle("Signature")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("signature.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Place", action: placeIt)
                        .disabled(kept == nil && drawing.strokes.isEmpty)
                        .accessibilityIdentifier("signature.place")
                }
            }
            .alert("Could not keep the signature", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear {
            kept = store.load()
            drawingNew = kept == nil
        }
    }

    private func placeIt() {
        if let kept, !drawingNew {
            place(kept)
            dismiss()
            return
        }
        guard !drawing.strokes.isEmpty else { return }
        let image = Self.image(of: drawing)
        do {
            try store.save(image)
        } catch {
            self.error = error.localizedDescription
            return
        }
        place(image)
        dismiss()
    }

    /// The strokes as a transparent picture, cut to their bounds.
    static func image(of drawing: PKDrawing) -> UIImage {
        let bounds = drawing.bounds.insetBy(dx: -8, dy: -8)
        return drawing.image(from: bounds, scale: 3)
    }
}

/// PencilKit's canvas with a pen, for the signature.
struct SignatureCanvas: UIViewRepresentable {
    @Binding var drawing: PKDrawing

    func makeUIView(context: Context) -> PKCanvasView {
        let canvas = PKCanvasView()
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.drawingPolicy = .anyInput
        canvas.tool = PKInkingTool(.pen, color: .black, width: 4)
        canvas.delegate = context.coordinator
        canvas.drawing = drawing
        canvas.accessibilityIdentifier = "signature.pkcanvas"
        return canvas
    }

    func updateUIView(_ canvas: PKCanvasView, context: Context) {
        if canvas.drawing.strokes.count != drawing.strokes.count {
            canvas.drawing = drawing
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(drawing: $drawing)
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency PKCanvasViewDelegate {
        @Binding var drawing: PKDrawing

        init(drawing: Binding<PKDrawing>) {
            _drawing = drawing
        }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            drawing = canvasView.drawing
        }
    }
}
