import SwiftUI

/// Edit PDF's bar over the pages, the same dark chrome as the markup bar:
/// undo and redo, which of the page's things is being edited, the controls
/// that kind needs, and Done. While the field on the page is open the bar
/// shows only Cancel and Apply, because nothing else can be done until the
/// text is settled.
struct EditBar: View {
    @Bindable var edit: EditModel
    let undoManager: UndoManager?
    let openPicture: () -> Void
    let openMarks: () -> Void
    let done: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var typing: Bool { edit.editing != nil || edit.placing != nil }

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.x1) {
                    if typing {
                        field
                    } else {
                        tools
                    }
                }
                .padding(.horizontal, Space.x3)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .accessibilityIdentifier("edit.bar")
            if !typing {
                Button("Done", action: done)
                    .font(TextStyle.headline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, Space.x4)
                    .frame(height: 44)
                    .fixedSize()
                    .accessibilityIdentifier("edit.done")
            }
        }
        .frame(height: 44)
        .background(MarkupChrome.bar, ignoresSafeAreaEdges: [])
        .overlay(alignment: .bottom) {
            Rectangle().fill(.white.opacity(0.12)).frame(height: 0.5)
        }
        .environment(\.colorScheme, .dark)
    }

    /// Cancel and Apply, while the text is being typed on the page.
    @ViewBuilder
    private var field: some View {
        Button("Cancel") { edit.cancel() }
            .font(TextStyle.body)
            .foregroundStyle(.white)
            .padding(.horizontal, Space.x3)
            .frame(height: 44)
            .keyboardShortcut(.escape, modifiers: [])
            .accessibilityIdentifier("edit.cancel")
        Spacer(minLength: Space.x4)
        if edit.working {
            ProgressView()
                .tint(.white)
                .frame(height: 44)
                .accessibilityIdentifier("edit.working")
        } else {
            Button(edit.editing != nil ? "Apply" : "Add") {
                Task {
                    if edit.editing != nil {
                        await edit.commit()
                    } else {
                        await edit.addLine()
                    }
                }
            }
            .font(TextStyle.headline)
            .foregroundStyle(Color.accentColor)
            .padding(.horizontal, Space.x3)
            .frame(height: 44)
            .keyboardShortcut(.return, modifiers: .command)
            .accessibilityIdentifier("edit.apply")
        }
    }

    @ViewBuilder
    private var tools: some View {
        barButton("Undo", "arrow.uturn.backward", id: "edit.undo", enabled: undoManager?.canUndo == true) {
            undoManager?.undo()
        }
        barButton("Redo", "arrow.uturn.forward", id: "edit.redo", enabled: undoManager?.canRedo == true) {
            undoManager?.redo()
        }
        divider
        ForEach(EditModel.Mode.allCases) { mode in
            barButton(mode.title, mode.symbol, id: "edit.mode.\(mode.rawValue)", selected: edit.mode == mode) {
                withAnimation(Motion.travel(reduceMotion: reduceMotion)) { edit.mode = mode }
            }
        }
        divider
        switch edit.mode {
        case .text:
            textTools
        case .pictures:
            pictureTools
        case .links:
            linkTools
        }
        divider
        barButton("Page marks", "signature", id: "edit.marks", action: openMarks)
    }

    // MARK: - Text

    @ViewBuilder
    private var textTools: some View {
        barButton("Add a line of text", "character.cursor.ibeam", id: "edit.addLine", selected: edit.placingArmed) {
            edit.placingArmed.toggle()
        }
        Menu {
            Picker("Font", selection: $edit.font) {
                ForEach(EditFace.allCases) { face in
                    Text(verbatim: face.name).tag(face)
                }
            }
        } label: {
            Text(verbatim: edit.font.name)
                .font(TextStyle.subheadline)
                .foregroundStyle(.white)
                .padding(.horizontal, Space.x3)
                .frame(height: 36)
                .background(.white.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .accessibilityLabel(Text("Font"))
        .accessibilityIdentifier("edit.font")
        Menu {
            Picker("Size", selection: $edit.size) {
                ForEach([Float(10), 12, 14, 18, 24, 32], id: \.self) { size in
                    Text(Int(size), format: .number).tag(size)
                }
            }
        } label: {
            Text(Int(edit.size), format: .number)
                .font(TextStyle.subheadline)
                .tabularNumbers()
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(.white.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .accessibilityLabel(Text("Size"))
        .accessibilityIdentifier("edit.size")
        colorDots
    }

    /// The colour a new line is drawn in, as small dots: one tap picks it.
    private var colorDots: some View {
        HStack(spacing: Space.x2) {
            ForEach([MarkupColor.black, .red, .blue, .green]) { color in
                Button {
                    edit.color = color
                } label: {
                    Circle()
                        .fill(color.color)
                        .frame(width: 12, height: 12)
                        .overlay(Circle().strokeBorder(.white.opacity(edit.color == color ? 1 : 0.35), lineWidth: 1.5))
                        .frame(width: 24, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(color.title))
                .accessibilityAddTraits(edit.color == color ? .isSelected : [])
                .accessibilityIdentifier("edit.color.\(color.rawValue)")
            }
        }
    }

    // MARK: - Pictures

    @ViewBuilder
    private var pictureTools: some View {
        barButton("Add a picture", "photo.badge.plus", id: "edit.picture.add", selected: edit.pendingPicture != nil, action: openPicture)
        if let picture = edit.picked {
            barButton("Turn", "rotate.right", id: "edit.picture.turn") {
                Task { await edit.turn(picture, onPage: edit.selectedPicture?.page ?? 0) }
            }
            barButton("Crop", "crop", id: "edit.picture.crop", selected: edit.cropping) {
                edit.cropping.toggle()
            }
            barButton("Replace", "arrow.triangle.2.circlepath", id: "edit.picture.replace") {
                edit.replacingPicture = true
                openPicture()
            }
            barButton("Delete", "trash", id: "edit.picture.delete") {
                Task { await edit.delete(picture, onPage: edit.selectedPicture?.page ?? 0) }
            }
        }
    }

    // MARK: - Links

    @ViewBuilder
    private var linkTools: some View {
        if let link = edit.pickedLink {
            barButton("Where it goes", "link.badge.plus", id: "edit.link.edit") {
                edit.draftLink = DraftLink(page: edit.selectedLink?.page ?? 0, rect: link.shownRect)
            }
            barButton("Remove", "link.slash", id: "edit.link.remove") {
                Task { await edit.remove(link, onPage: edit.selectedLink?.page ?? 0) }
            }
        } else {
            Text("Drag a box on the page to add a link.")
                .font(TextStyle.caption)
                .foregroundStyle(.white.opacity(0.8))
                .padding(.horizontal, Space.x3)
                .accessibilityIdentifier("edit.link.hint")
        }
    }

    // MARK: - Chrome

    private var divider: some View {
        Rectangle()
            .fill(.white.opacity(0.18))
            .frame(width: 0.5, height: 22)
            .padding(.horizontal, Space.x2)
    }

    private func barButton(_ title: LocalizedStringKey, _ symbol: String, id: String, selected: Bool = false, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
        }
        .buttonStyle(.markupTool(selected: selected))
        .disabled(!enabled || edit.working)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(id)
    }
}
