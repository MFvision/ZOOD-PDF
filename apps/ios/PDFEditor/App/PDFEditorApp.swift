import SwiftUI

/// محرر PDF. Three kinds of scene: the Library (the first window); a
/// document in a window of its own, opened from the Library on iPad; and
/// documents handed to the app from outside — Files, Mail, Safari, "Open
/// in" — which open in a document scene of their own. All take the chosen
/// language and appearance from Settings.
@main
struct PDFEditorApp: App {
    /// For the Home Screen's quick actions, which UIKit delivers.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        // ZOOD's faces, before the first scene draws (Design/Brand.swift).
        BrandType.register()
    }

    var body: some Scene {
        WindowGroup(id: "library") {
            LibraryShell()
                .appEnvironment()
        }
        WindowGroup(id: "document", for: DocumentReference.self) { $reference in
            DocumentWindow(reference: reference)
                .appEnvironment()
        }
        DocumentGroup(viewing: PDFEditorDocument.self) { configuration in
            NavigationStack {
                DocumentView(model: configuration.document.model)
            }
            .appEnvironment()
        }
        .commands {
            DocumentCommands()
        }
    }
}
