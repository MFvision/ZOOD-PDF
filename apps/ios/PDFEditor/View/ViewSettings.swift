import SwiftUI

/// How the pages are laid out: scrolled continuously, or one page at a
/// time with the platform's swipe (no page curl).
enum PageLayout: String, CaseIterable, Identifiable {
    case continuous
    case single

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .continuous: "Continuous"
        case .single: "Single page"
        }
    }

    var symbol: String {
        switch self {
        case .continuous: "rectangle.portrait.on.rectangle.portrait"
        case .single: "rectangle.portrait"
        }
    }
}

/// The keys in UserDefaults for how a document is shown; they apply to
/// every document, as a reader's preferences do.
enum ViewSettingsKey {
    static let layout = "view.layout"
    static let night = "view.night"
}
