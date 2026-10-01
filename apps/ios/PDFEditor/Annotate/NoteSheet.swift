import SwiftUI

/// The words of a note or a text box, asked once the place is chosen.
struct NoteSheet: View {
    let placement: PendingPlacement
    @Bindable var editor: AnnotationEditor
    @Environment(\.dismiss) private var dismiss
    @Environment(\.layoutDirection) private var layoutDirection
    @State private var text = ""
    @FocusState private var focused: Bool

    private var isText: Bool { placement.tool == .freeText }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(isText ? "Text" : "Note", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                        .focused($focused)
                        .accessibilityIdentifier("note.field")
                } footer: {
                    if isText {
                        Text("Arabic is shaped and stays searchable.")
                    }
                }
                if isText {
                    Section("Size") {
                        Picker("Size", selection: $editor.textSize) {
                            Text("Small").tag(CGFloat(11))
                            Text("Medium").tag(CGFloat(14))
                            Text("Large").tag(CGFloat(20))
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("note.size")
                    }
                }
            }
            .navigationTitle(isText ? "Add text" : "Add note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add", action: add)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("note.add")
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear { focused = true }
    }

    private func add() {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        if isText {
            let rtl = ScriptDirection.isRightToLeft(words) ?? (layoutDirection == .rightToLeft)
            editor.addFreeText(words, at: placement, size: editor.textSize, rightToLeft: rtl)
        } else {
            editor.addNote(words, at: placement)
        }
        dismiss()
    }
}

/// Which way a text reads, from its first strong letter.
enum ScriptDirection {
    /// True for a right-to-left script, false for a left-to-right one, nil
    /// when the text has no strong letter.
    static func isRightToLeft(_ text: String) -> Bool? {
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x0590...0x08FF, 0xFB1D...0xFDFF, 0xFE70...0xFEFF: return true
            case 0x41...0x5A, 0x61...0x7A, 0xC0...0x24F, 0x370...0x58F: return false
            default: continue
            }
        }
        return nil
    }
}
