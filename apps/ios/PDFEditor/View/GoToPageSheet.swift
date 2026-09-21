import SwiftUI

/// Go to page: a number typed in either script.
struct GoToPageSheet: View {
    @Bindable var model: DocumentModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Page number", text: $text)
                        .keyboardType(.numberPad)
                        .focused($focused)
                        .onSubmit(go)
                        .accessibilityIdentifier("goto.field")
                } footer: {
                    Text("From 1 to \(model.pageCount)")
                        .tabularNumbers()
                }
            }
            .navigationTitle("Go to page")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Go", action: go)
                        .disabled(parsed == nil)
                        .accessibilityIdentifier("goto.go")
                }
            }
        }
        .presentationDetents([.height(220)])
        .onAppear { focused = true }
    }

    /// The number, Arabic-Indic or Persian digits included; nil when it is
    /// not a page.
    private var parsed: Int? {
        Self.pageNumber(from: text, count: model.pageCount)
    }

    static func pageNumber(from text: String, count: Int) -> Int? {
        var digits = ""
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x30...0x39: digits.append(Character(scalar))
            case 0x660...0x669: digits.append(Character(UnicodeScalar(scalar.value - 0x660 + 0x30)!))
            case 0x6F0...0x6F9: digits.append(Character(UnicodeScalar(scalar.value - 0x6F0 + 0x30)!))
            case 0x20, 0x2C, 0x66C: continue
            default: return nil
            }
        }
        guard digits.count <= 7, let number = Int(digits), number >= 1, number <= count else { return nil }
        return number
    }

    private func go() {
        guard let page = parsed else { return }
        model.currentPage = page - 1
        dismiss()
    }
}
