import SwiftUI

/// How the pages are laid out: scrolled continuously, one page at a time
/// with the platform's swipe (no page curl), or as a book — two pages side
/// by side, the first on its own as a cover, one each side of an unfolded
/// iPhone Duo's fold (offered where the screen is wide enough).
enum PageLayout: String, CaseIterable, Identifiable {
    case continuous
    case single
    case book

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .continuous: "Continuous"
        case .single: "Single page"
        case .book: "Two pages"
        }
    }

    var symbol: String {
        switch self {
        case .continuous: "rectangle.portrait.on.rectangle.portrait"
        case .single: "rectangle.portrait"
        case .book: "book.pages"
        }
    }
}

/// The keys in UserDefaults for how a document is shown; they apply to
/// every document, as a reader's preferences do.
enum ViewSettingsKey {
    static let layout = "view.layout"
    static let night = "view.night"
}
