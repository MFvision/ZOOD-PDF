import SwiftUI

/// The markup bar, after the owner's design target: a thin dark toolbar
/// over the pages — undo and redo, the text tools (a text box, the
/// highlighter, underline, strike-through), the pen with its colours as
/// small dots, shapes, a note, crop, stamp, signature — and Done. A chosen
/// tool is lit in the accent.
struct MarkupBar: View {
    @Bindable var editor: AnnotationEditor
    let undoManager: UndoManager?
    let openStamps: () -> Void
    let openSignature: () -> Void
    let openCrop: () -> Void
    let done: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // The tools scroll under a Done that stays put at the end. The bar
        // is cut to the width it is given: a horizontal scroll view's own
        // ideal width is its content's, and a stack would grow to it, past
        // the screen's edge (which is where Done ended up in a test run).
        GeometryReader { geometry in
            ZStack(alignment: .trailing) {
                ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.x1) {
                    barButton("Undo", "arrow.uturn.backward", id: "markup.undo", enabled: undoManager?.canUndo == true) { undoManager?.undo() }
                    barButton("Redo", "arrow.uturn.forward", id: "markup.redo", enabled: undoManager?.canRedo == true) { undoManager?.redo() }
                    divider
                    toolButton(.freeText)
                    toolButton(.highlight)
                    toolButton(.underline)
                    toolButton(.strikeout)
                    divider
                    toolButton(.ink)
                    penDots
                    divider
                    shapesMenu
                    toolButton(.note)
                    divider
                    barButton("Crop", "crop", id: "markup.crop", action: openCrop)
                    barButton("Stamp", "seal", id: "markup.stamp", action: openStamps)
                    barButton("Signature", "signature", id: "markup.signature", action: openSignature)
                }
                .padding(.leading, Space.x3)
                .padding(.trailing, 88)
            }
            .frame(width: geometry.size.width, height: 44)
            .accessibilityIdentifier("markup.bar")
            Button("Done", action: done)
                .font(TextStyle.headline)
                .foregroundStyle(.white)
                .padding(.horizontal, Space.x4)
                .frame(height: 44)
                .background(MarkupChrome.bar)
                .accessibilityIdentifier("markup.done")
            }
            .frame(width: geometry.size.width, height: 44)
        }
        .frame(height: 44)
        .background(MarkupChrome.bar)
        .overlay(alignment: .bottom) {
            Rectangle().fill(.white.opacity(0.12)).frame(height: 0.5)
        }
        .environment(\.colorScheme, .dark)
    }

    private var divider: some View {
        Rectangle()
            .fill(.white.opacity(0.18))
            .frame(width: 0.5, height: 22)
            .padding(.horizontal, Space.x2)
    }

    /// The pen's colours, as small dots; one tap picks the colour and the pen.
    private var penDots: some View {
        HStack(spacing: Space.x2) {
            ForEach([MarkupColor.red, .blue, .green, .black]) { color in
                Button {
                    editor.color = color
                    if editor.tool != .ink { editor.tool = .ink }
                } label: {
                    Circle()
                        .fill(color.color)
                        .frame(width: 12, height: 12)
                        .overlay(Circle().strokeBorder(.white.opacity(editor.color == color && editor.tool == .ink ? 1 : 0.35), lineWidth: 1.5))
                        .frame(width: 24, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(color.title))
                .accessibilityAddTraits(editor.color == color ? .isSelected : [])
                .accessibilityIdentifier("markup.pen.\(color.rawValue)")
            }
        }
    }

    private var shapesMenu: some View {
        Menu {
            ForEach([AnnotationTool.rectangle, .ellipse, .arrow]) { tool in
                Button {
                    choose(tool)
                } label: {
                    Label(tool.title, systemImage: tool.symbol)
                }
                .accessibilityIdentifier("markup.\(tool.rawValue)")
            }
        } label: {
            let current = [AnnotationTool.rectangle, .ellipse, .arrow].first { $0 == editor.tool }
            Label("Shapes", systemImage: current?.symbol ?? "square.on.circle")
                .labelStyle(.iconOnly)
                .font(.system(size: 17, weight: .medium))
                .frame(width: 40, height: 36)
                .foregroundStyle(current != nil ? Color.white : Color.white.opacity(0.9))
                .background(current != nil ? Color.accentColor : Color.clear, in: RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .accessibilityIdentifier("markup.shapes")
    }

    private func toolButton(_ tool: AnnotationTool) -> some View {
        barButton(tool.title, tool.symbol, id: "markup.\(tool.rawValue)", selected: editor.tool == tool) {
            choose(tool)
        }
    }

    private func choose(_ tool: AnnotationTool) {
        withAnimation(Motion.travel(reduceMotion: reduceMotion)) {
            if editor.tool == tool {
                editor.tool = nil
            } else {
                if editor.tool == .ink { editor.commitInk() }
                editor.tool = tool
                if tool == .ink, editor.color == .yellow { editor.color = .black }
                if tool.isTextMarkup, editor.color == .black { editor.color = .yellow }
            }
        }
    }

    private func barButton(_ title: LocalizedStringKey, _ symbol: String, id: String, selected: Bool = false, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
        }
        .buttonStyle(.markupTool(selected: selected))
        .disabled(!enabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(id)
    }
}

/// The dark glass the markup chrome is made of.
enum MarkupChrome {
    static var bar: some ShapeStyle { Color(white: 0.11).opacity(0.94) }
}

/// A tool's button on the dark bar: a white glyph, lit in the accent when
/// the tool is in hand, answering on press.
struct MarkupToolStyle: ButtonStyle {
    let selected: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: 17, weight: .medium))
            .frame(width: 40, height: 36)
            .foregroundStyle(isEnabled ? Color.white : Color.white.opacity(0.3))
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

/// The floating pen palette at the bottom while the pen is in hand: the
/// pen, marker, pencil and eraser, three widths, and the colour swatches.
/// What it sets, the canvases on the pages take at once.
struct PenPalette: View {
    @Bindable var editor: AnnotationEditor
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: Space.x3) {
            ForEach(InkKind.allCases) { kind in
                Button {
                    editor.inkKind = kind
                } label: {
                    Image(systemName: kind.symbol)
                        .font(.system(size: 18, weight: .medium))
                        .frame(width: 40, height: 40)
                        .foregroundStyle(editor.inkKind == kind ? Color.white : Surface.label)
                        .background(editor.inkKind == kind ? Color.accentColor : Color.clear, in: Circle())
                }
                .buttonStyle(.pressable)
                .accessibilityLabel(Text(kind.title))
                .accessibilityAddTraits(editor.inkKind == kind ? .isSelected : [])
                .accessibilityIdentifier("pen.\(kind.rawValue)")
            }
            Rectangle().fill(Surface.separator).frame(width: 0.5, height: 24)
            ForEach([CGFloat(2), 4, 8], id: \.self) { width in
                Button {
                    editor.lineWidth = width
                } label: {
                    Circle()
                        .fill(Surface.label)
                        .frame(width: 6 + width * 1.5, height: 6 + width * 1.5)
                        .frame(width: 32, height: 40)
                        .overlay(Circle().strokeBorder(Color.accentColor, lineWidth: editor.lineWidth == width ? 2 : 0).frame(width: 30, height: 30))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("\(Int(width)) points"))
                .accessibilityIdentifier("pen.width.\(Int(width))")
            }
            Rectangle().fill(Surface.separator).frame(width: 0.5, height: 24)
            ForEach(MarkupColor.allCases) { color in
                Button {
                    editor.color = color
                    if editor.inkKind == .eraser { editor.inkKind = .pen }
                } label: {
                    Circle()
                        .fill(color.color)
                        .frame(width: 22, height: 22)
                        .overlay(Circle().strokeBorder(Surface.separator, lineWidth: 0.5))
                        .overlay(Circle().strokeBorder(Color.accentColor, lineWidth: editor.color == color ? 2.5 : 0).padding(-4))
                        .frame(width: 32, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(color.title))
                .accessibilityAddTraits(editor.color == color ? .isSelected : [])
                .accessibilityIdentifier("pen.color.\(color.rawValue)")
            }
        }
        .padding(.horizontal, Space.x4)
        .padding(.vertical, Space.x2)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(.white.opacity(0.15), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pen.palette")
    }
}
