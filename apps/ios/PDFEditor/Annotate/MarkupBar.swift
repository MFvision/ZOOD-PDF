import SwiftUI

/// The markup bar: the tools, the colour, undo and redo, and Done. Shown
/// under the toolbar while marking up; a chosen tool is filled in.
struct MarkupBar: View {
    @Bindable var editor: AnnotationEditor
    let undoManager: UndoManager?
    let openStamps: () -> Void
    let openSignature: () -> Void
    let done: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.x2) {
                    ForEach(AnnotationTool.allCases) { tool in
                        toolButton(tool)
                    }
                    Divider()
                        .frame(height: 24)
                        .padding(.horizontal, Space.x2)
                    Button(action: openStamps) {
                        Label("Stamp", systemImage: "seal")
                    }
                    .buttonStyle(.markupTool(selected: false))
                    .accessibilityIdentifier("markup.stamp")
                    Button(action: openSignature) {
                        Label("Signature", systemImage: "signature")
                    }
                    .buttonStyle(.markupTool(selected: false))
                    .accessibilityIdentifier("markup.signature")
                    Divider()
                        .frame(height: 24)
                        .padding(.horizontal, Space.x2)
                    colorMenu
                    Button {
                        undoManager?.undo()
                    } label: {
                        Label("Undo", systemImage: "arrow.uturn.backward")
                    }
                    .buttonStyle(.markupTool(selected: false))
                    .disabled(undoManager?.canUndo != true)
                    .accessibilityIdentifier("markup.undo")
                    Button {
                        undoManager?.redo()
                    } label: {
                        Label("Redo", systemImage: "arrow.uturn.forward")
                    }
                    .buttonStyle(.markupTool(selected: false))
                    .disabled(undoManager?.canRedo != true)
                    .accessibilityIdentifier("markup.redo")
                }
                .padding(.horizontal, Space.x4)
                .padding(.vertical, Space.x3)
            }
            .overlay(alignment: .trailing) {
                Button("Done", action: done)
                    .font(TextStyle.headline)
                    .padding(.horizontal, Space.x4)
                    .padding(.vertical, Space.x3)
                    .background(.bar)
                    .accessibilityIdentifier("markup.done")
            }
            if editor.tool == .ink {
                Text(editor.hasUncommittedInk ? "Choose another tool or Done to keep the drawing." : "Draw with a finger or the Pencil; two fingers scroll.")
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
                    .padding(.bottom, Space.x2)
                    .accessibilityIdentifier("markup.hint")
            }
        }
        .background(.bar)
        .overlay(alignment: .bottom) {
            Divider()
        }
    }

    private func toolButton(_ tool: AnnotationTool) -> some View {
        Button {
            withAnimation(Motion.travel(reduceMotion: reduceMotion)) {
                if editor.tool == tool {
                    editor.tool = nil
                } else {
                    if editor.tool == .ink { editor.commitInk() }
                    editor.tool = tool
                    if tool == .ink, editor.color == .yellow { editor.color = .black }
                }
            }
        } label: {
            Label(tool.title, systemImage: tool.symbol)
        }
        .buttonStyle(.markupTool(selected: editor.tool == tool))
        .accessibilityAddTraits(editor.tool == tool ? .isSelected : [])
        .accessibilityIdentifier("markup.\(tool.rawValue)")
    }

    private var colorMenu: some View {
        Menu {
            Picker("Colour", selection: $editor.color) {
                ForEach(MarkupColor.allCases) { color in
                    Label {
                        Text(color.title)
                    } icon: {
                        Image(systemName: "circle.fill")
                            .foregroundStyle(color.color)
                    }
                    .tag(color)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label {
                Text("Colour")
            } icon: {
                Image(systemName: "circle.fill")
                    .foregroundStyle(editor.color.color)
                    .overlay(Circle().strokeBorder(Surface.separator))
            }
        }
        .buttonStyle(.markupTool(selected: false))
        .accessibilityIdentifier("markup.color")
    }
}

/// A tool's button: icon on a plate that fills when the tool is in hand,
/// answering on press.
struct MarkupToolStyle: ButtonStyle {
    let selected: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: 17, weight: .medium))
            .frame(width: 40, height: 36)
            .foregroundStyle(selected ? Color.white : Color.accentColor)
            .background(selected ? Color.accentColor : Color.clear, in: RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.94 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(configuration.isPressed ? nil : Motion.travel(reduceMotion: reduceMotion), value: configuration.isPressed)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == MarkupToolStyle {
    static func markupTool(selected: Bool) -> MarkupToolStyle { MarkupToolStyle(selected: selected) }
}
