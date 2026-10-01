import SwiftUI

/// What the menu bar's Document menu can ask of the document on screen.
enum DocumentAction {
    case find, goToPage, nextPage, previousPage
    case toggleThumbnails, toggleNight, toggleReader, showPages
    case export, protect, save
}

/// The document view with focus answers these; the menu items call it.
struct DocumentActions {
    let canSave: Bool
    /// A field of Edit PDF is taking the typing: the arrow keys with ⌘ are
    /// the caret's (the start and end of the line), not the pages'.
    var typing = false
    let perform: (DocumentAction) -> Void
}

private struct DocumentActionsKey: FocusedValueKey {
    typealias Value = DocumentActions
}

extension FocusedValues {
    var documentActions: DocumentActions? {
        get { self[DocumentActionsKey.self] }
        set { self[DocumentActionsKey.self] = newValue }
    }
}

/// The Document menu (iPadOS shows the menu bar; the shortcuts work with
/// any keyboard): find, pages, view modes, export, protect, save.
struct DocumentCommands: Commands {
    @FocusedValue(\.documentActions) private var actions

    var body: some Commands {
        CommandMenu("Document") {
            item("Find…", .find, "f", .command)
            item("Go to Page…", .goToPage, "g", [.command, .option])
            item("Next Page", .nextPage, .rightArrow, .command)
                .disabled(actions?.typing == true)
            item("Previous Page", .previousPage, .leftArrow, .command)
                .disabled(actions?.typing == true)
            Divider()
            item("Thumbnails", .toggleThumbnails, "t", [.command, .option])
            item("Night Mode", .toggleNight, "n", [.command, .option])
            item("Reader Mode", .toggleReader, "r", [.command, .option])
            item("Pages…", .showPages, "p", [.command, .option])
            Divider()
            item("Export…", .export, "e", [.command, .shift])
            item("Protect…", .protect, "l", [.command, .shift])
            Button("Save") { actions?.perform(.save) }
                .keyboardShortcut("s", modifiers: .command)
                .disabled(actions?.canSave != true)
        }
    }

    private func item(_ title: LocalizedStringKey, _ action: DocumentAction, _ key: KeyEquivalent, _ modifiers: EventModifiers) -> some View {
        Button(title) { actions?.perform(action) }
            .keyboardShortcut(key, modifiers: modifiers)
            .disabled(actions == nil)
    }
}
