import Foundation

/// What the widgets show, computed from the shared container so that the
/// timeline providers stay a line each and the unit tests can seed a
/// container and check the entries without WidgetKit.
public enum WidgetTimelines {
    /// The recent documents a widget of `capacity` cells shows, newest
    /// first, only those whose file is still where it was.
    public static func recents(from store: RecentsStore = RecentsStore(), capacity: Int) -> [RecentDocument] {
        Array(store.load().filter { $0.resolveURL() != nil }.prefix(capacity))
    }

    /// The last searches for the Library search widget.
    public static func searches(from store: SearchesStore = SearchesStore(), capacity: Int) -> [RecentSearch] {
        Array(store.load().prefix(capacity))
    }

    /// Whether the device can scan with a camera (the app records it at
    /// launch); the Scan widget says "from photos" where it cannot.
    public static var cameraAvailable: Bool {
        AppGroup.flag("cameraAvailable")
    }
}
