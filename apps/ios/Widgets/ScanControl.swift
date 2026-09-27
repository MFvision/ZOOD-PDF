import AppIntents
import SwiftUI
import WidgetKit

/// The Control Center's Scan control (iOS 18): a button that runs the
/// "Scan a document" intent, which opens the app on the scanner. It can
/// also sit on the Lock Screen's bottom corners and on the Action button.
struct ScanControl: ControlWidget {
    static let kind = "app.warraq.ios.widgets.scancontrol"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: ScanDocumentIntent()) {
                Label("Scan a document", systemImage: "doc.viewfinder")
            }
        }
        .displayName("Scan a document")
        .description("Opens the scanner.")
    }
}
