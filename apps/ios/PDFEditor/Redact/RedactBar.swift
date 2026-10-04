import SwiftUI

/// Redact's bar over the pages, the same dark chrome as the markup and edit
/// bars: undo and redo, how a touch marks (text or an area), Find and
/// redact, Remove hidden information, the marks (on a phone, where there is
/// no inspector beside the pages), Apply, and Done.
struct RedactBar: View {
    @Bindable var redact: RedactModel
    let undoManager: UndoManager?
    /// Whether the marks are listed beside the pages (iPad): the bar then
    /// has no button for them.
    let inspectorShown: Bool
    let openFind: () -> Void
    let openHidden: () -> Void
    let openMarks: () -> Void
    let apply: () -> Void
    let done: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.x1) {
                    tools
                }
                .padding(.horizontal, Space.x3)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .accessibilityIdentifier("redact.bar")
            if redact.working {
                ProgressView()
                    .tint(.white)
                    .padding(.horizontal, Space.x3)
                    .accessibilityIdentifier("redact.working")
            }
            Button(action: apply) {
                Text("Apply")
                    .font(TextStyle.headline)
                    .foregroundStyle(redact.marks.isEmpty ? Color.white.opacity(0.35) : Color(.systemRed))
                    .padding(.horizontal, Space.x3)
                    .frame(height: 44)
            }
            .disabled(redact.marks.isEmpty || redact.working)
            .keyboardShortcut(.return, modifiers: .command)
            .accessibilityIdentifier("redact.apply")
            Button("Done", action: done)
                .font(TextStyle.headline)
                .foregroundStyle(.white)
                .padding(.horizontal, Space.x4)
                .frame(height: 44)
                .fixedSize()
                .accessibilityIdentifier("redact.done")
        }
        .frame(height: 44)
        .themedSurface(.bar, in: Rectangle(), shadowed: false)
        .overlay(alignment: .bottom) {
            Rectangle().fill(.white.opacity(0.12)).frame(height: 0.5)
        }
        .environment(\.colorScheme, .dark)
    }

    @ViewBuilder
    private var tools: some View {
        barButton("Undo", "arrow.uturn.backward", id: "redact.undo", enabled: undoManager?.canUndo == true) {
            undoManager?.undo()
        }
        barButton("Redo", "arrow.uturn.forward", id: "redact.redo", enabled: undoManager?.canRedo == true) {
            undoManager?.redo()
        }
        divider
        ForEach(RedactModel.Mode.allCases) { mode in
            barButton(mode.title, mode.symbol, id: "redact.mode.\(mode.rawValue)", selected: redact.mode == mode) {
                withAnimation(Motion.travel(reduceMotion: reduceMotion)) { redact.mode = mode }
            }
        }
        divider
        barButton("Find and redact", "text.magnifyingglass", id: "redact.find", action: openFind)
        barButton("Remove hidden information", "eye.slash", id: "redact.hidden", action: openHidden)
        if !inspectorShown {
            divider
            Button(action: openMarks) {
                Label {
                    Text("Marks")
                } icon: {
                    Image(systemName: "list.bullet.rectangle")
                }
                .labelStyle(.iconOnly)
                .overlay(alignment: .topTrailing) {
                    if !redact.marks.isEmpty {
                        Text(redact.marks.count, format: .number)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4)
                            .background(Color(.systemRed), in: Capsule())
                            .offset(x: 8, y: -6)
                    }
                }
            }
            .buttonStyle(.markupTool(selected: false))
            .accessibilityLabel(Text("Marks"))
            .accessibilityValue(Text(redact.marks.count, format: .number))
            .accessibilityIdentifier("redact.marks")
        }
    }

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
        .disabled(!enabled || redact.working)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(id)
    }
}

/// The marks waiting to be applied: each with what the core reads under
/// it, on which page, picked with a tap and taken back with Remove — beside
/// the pages on iPad, in a sheet on a phone. Delete removes the picked one
/// from the keyboard.
struct RedactMarksList: View {
    @Bindable var redact: RedactModel

    var body: some View {
        List {
            Section {
                if redact.marks.isEmpty {
                    Text("Nothing is marked yet. Tap a word, drag over text or an area, or find words and patterns to mark them.")
                        .font(TextStyle.caption)
                        .foregroundStyle(Surface.secondaryLabel)
                        .accessibilityIdentifier("redact.marks.empty")
                }
                ForEach(Array(redact.marks.enumerated()), id: \.element.id) { index, mark in
                    Button {
                        redact.selected = redact.selected == mark.id ? nil : mark.id
                    } label: {
                        HStack(alignment: .firstTextBaseline) {
                            Image(systemName: mark.kind == .area ? "rectangle.dashed" : "text.redaction")
                                .foregroundStyle(Color(.systemRed))
                            VStack(alignment: .leading, spacing: Space.x1) {
                                Text(verbatim: mark.label.isEmpty ? "—" : mark.label)
                                    .font(TextStyle.callout)
                                    .lineLimit(3)
                                Text("Page \(mark.page + 1)")
                                    .font(TextStyle.caption)
                                    .foregroundStyle(Surface.secondaryLabel)
                            }
                            Spacer()
                            if redact.selected == mark.id {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    // Read as what is marked, then where: the list's own words.
                    .accessibilityLabel(Text(verbatim: mark.label.isEmpty ? "—" : mark.label))
                    .accessibilityValue(Text("Page \(mark.page + 1)"))
                    .accessibilityIdentifier("redact.mark.\(index)")
                    .swipeActions {
                        Button(role: .destructive) {
                            redact.remove(mark.id)
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
            } header: {
                Text("Marked to redact")
            } footer: {
                if !redact.marks.isEmpty {
                    Text("Apply takes out what is under the marks: the text, the pictures' pixels and the drawings, not just covered. You can undo until you save.")
                }
            }
            if let id = redact.selected, redact.marks.contains(where: { $0.id == id }) {
                Section {
                    Button(role: .destructive) {
                        redact.remove(id)
                    } label: {
                        Label("Remove this mark", systemImage: "trash")
                    }
                    .keyboardShortcut(.delete, modifiers: [])
                    .accessibilityIdentifier("redact.mark.remove")
                }
            }
            if redact.marks.count > 1 {
                Section {
                    Button(role: .destructive) {
                        redact.removeAll()
                    } label: {
                        Label("Remove every mark", systemImage: "xmark.bin")
                    }
                    .accessibilityIdentifier("redact.marks.clear")
                }
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("redact.list")
    }
}
