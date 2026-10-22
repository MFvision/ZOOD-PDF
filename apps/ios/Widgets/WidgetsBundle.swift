import SwiftUI
import WidgetKit

/// The app's widgets: Recent documents (Home Screen, all sizes, and the
/// Lock Screen's rectangle and inline line), Scan (a one-tap launch, on the
/// Home Screen and as a Lock Screen circle), Library search (the last
/// searches), Ask ZOOD (a Home Screen and Lock Screen button), and the
/// Control Center's Scan and Ask ZOOD controls. All read the shared
/// container and open the app through its routes.
@main
struct WidgetsBundle: WidgetBundle {
    var body: some Widget {
        RecentDocumentsWidget()
        ScanWidget()
        LibrarySearchWidget()
        ScanControl()
        AskZoodWidget()
        AskZoodControl()
    }
}
