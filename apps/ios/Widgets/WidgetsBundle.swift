import SwiftUI
import WidgetKit

/// The app's widgets. One so far — Recent documents, in every size the
/// Home and Lock Screens offer; Scan and Library search join with the
/// scanner and the Library's index.
@main
struct WidgetsBundle: WidgetBundle {
    var body: some Widget {
        RecentDocumentsWidget()
    }
}
