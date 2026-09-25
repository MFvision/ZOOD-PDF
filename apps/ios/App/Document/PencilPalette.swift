import Combine
import PDFKit
import SwiftUI

/// Floating bottom glass palette (as in the mock-up): pen, marker, highlighter, eraser, text
/// highlight, colours, width, undo, done.
struct PencilPalette: View {
    @Bindable var session: DocumentSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hasSelection = false

    var body: some View {
        VStack(spacing: 10) {
            if session.tool == .textHighlight {
                Button {
                    highlightSelection()
                } label: {
                    Label("annotate.highlightSelection", systemImage: "highlighter")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!hasSelection)
                .accessibilityIdentifier("annotate.highlightSelection")
            }
            // Fits on iPad; scrolls sideways on narrow iPhones.
            ViewThatFits(in: .horizontal) {
                paletteRow
                ScrollView(.horizontal, showsIndicators: false) { paletteRow }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .glass(28)
            .shadow(color: .black.opacity(0.15), radius: 16, y: 6)
        }
        .padding(.bottom, 12)
        .onReceive(NotificationCenter.default.publisher(for: .PDFViewSelectionChanged, object: session.pdfView)) { _ in
            hasSelection = !(session.pdfView.currentSelection?.string ?? "").isEmpty
        }
    }

    private var paletteRow: some View {
        HStack(spacing: 6) {
            ForEach(DocumentSession.Tool.allCases) { tool in
                toolButton(tool)
            }
            Divider().frame(height: 28)
            ForEach(InkColor.allCases) { color in
                colorButton(color)
            }
            Divider().frame(height: 28)
            Menu {
                Picker("annotate.width", selection: $session.inkWidth) {
                    Text("annotate.width.thin").tag(CGFloat(1.5))
                    Text("annotate.width.medium").tag(CGFloat(3))
                    Text("annotate.width.thick").tag(CGFloat(6))
                }
            } label: {
                Image(systemName: "lineweight").frame(width: 36, height: 36)
            }
            .accessibilityLabel(Text("annotate.width"))
            Button {
                Task { await session.undoLast() }
            } label: {
                Image(systemName: "arrow.uturn.backward").frame(width: 36, height: 36)
            }
            .disabled(!session.canUndo)
            .accessibilityLabel(Text("common.undo"))
            Button("common.done") {
                withAnimation(reduceMotion ? nil : .spring(response: 0.3)) { session.tool = nil }
            }
            .fontWeight(.semibold)
            .padding(.horizontal, 8)
            .accessibilityIdentifier("annotate.done")
        }
    }

    private func toolButton(_ tool: DocumentSession.Tool) -> some View {
        let selected = session.tool == tool
        return Button {
            session.tool = tool
        } label: {
            Image(systemName: symbol(tool))
                .font(.system(size: 18, weight: selected ? .semibold : .regular))
                .frame(width: 36, height: 36)
                .foregroundStyle(selected ? Color.white : Color.primary)
                .background(selected ? Color.accentColor : Color.clear, in: Circle())
        }
        .accessibilityLabel(Text(label(tool)))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("annotate.\(tool.rawValue)")
    }

    private func colorButton(_ color: InkColor) -> some View {
        let selected = session.inkColor == color
        return Button {
            session.inkColor = color
        } label: {
            Circle()
                .fill(Color(uiColor: color.uiColor))
                .frame(width: 22, height: 22)
                .overlay(Circle().strokeBorder(Color.primary.opacity(selected ? 0.9 : 0.15), lineWidth: selected ? 2.5 : 1))
                .padding(4)
        }
        .accessibilityLabel(Text(color.name))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func highlightSelection() {
        guard let selection = session.pdfView.currentSelection else { return }
        let color = session.inkColor == .black ? InkColor.yellow.uiColor : session.inkColor.uiColor
        for (page, annotation) in InkConverter.highlight(selection, color: color) {
            page.addAnnotation(annotation)
            session.didAdd(annotation, on: page)
        }
        session.pdfView.clearSelection()
    }

    private func symbol(_ tool: DocumentSession.Tool) -> String {
        switch tool {
        case .pen: "pencil.tip"
        case .marker: "paintbrush.pointed"
        case .highlighter: "highlighter"
        case .eraser: "eraser"
        case .textHighlight: "text.line.first.and.arrowtriangle.forward"
        }
    }

    private func label(_ tool: DocumentSession.Tool) -> LocalizedStringKey {
        switch tool {
        case .pen: "annotate.pen"
        case .marker: "annotate.marker"
        case .highlighter: "annotate.highlighter"
        case .eraser: "annotate.eraser"
        case .textHighlight: "annotate.textHighlight"
        }
    }
}
