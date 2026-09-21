import Foundation

/// Where a widget, a Control Center control, a Shortcut, a Home Screen
/// quick action or a Spotlight result sends the app: the same few places,
/// however they were asked for. As a URL (`pdfeditor://scan`,
/// `pdfeditor://open/<id>`, `pdfeditor://search?q=…`, `pdfeditor://last`)
/// for widgets, which can only open links; as a value posted through the
/// shared container for intents, which may run in another process before
/// the app comes to the front.
public enum AppRoute: Equatable, Sendable {
    /// Start a scan.
    case scan
    /// Open a recent document by its id.
    case open(id: UUID)
    /// Open a document the Library indexed, by its key.
    case openKey(String)
    /// Search the Library (an empty query opens the search field).
    case search(String)
    /// Open the document opened last.
    case lastDocument

    public static let notification = Notification.Name("app.warraq.ios.route")
    private static let pendingKey = "pendingRoute"

    // MARK: - URLs

    public var url: URL {
        var parts = URLComponents()
        parts.scheme = AppGroup.urlScheme
        switch self {
        case .scan:
            parts.host = "scan"
        case let .open(id):
            parts.host = "open"
            parts.path = "/\(id.uuidString)"
        case let .openKey(key):
            parts.host = "document"
            parts.queryItems = [URLQueryItem(name: "key", value: key)]
        case let .search(query):
            parts.host = "search"
            parts.queryItems = query.isEmpty ? nil : [URLQueryItem(name: "q", value: query)]
        case .lastDocument:
            parts.host = "last"
        }
        // Every component above is one the scheme can carry.
        return parts.url ?? URL(string: "\(AppGroup.urlScheme)://scan")!
    }

    public init?(url: URL) {
        guard url.scheme == AppGroup.urlScheme, let host = url.host() else { return nil }
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        switch host {
        case "scan":
            self = .scan
        case "open":
            guard let id = UUID(uuidString: url.lastPathComponent) else { return nil }
            self = .open(id: id)
        case "document":
            guard let key = parts?.queryItems?.first(where: { $0.name == "key" })?.value, !key.isEmpty else { return nil }
            self = .openKey(key)
        case "search":
            self = .search(parts?.queryItems?.first(where: { $0.name == "q" })?.value ?? "")
        case "last":
            self = .lastDocument
        default:
            return nil
        }
    }

    // MARK: - Hand-over between processes

    /// Leaves the route for the app to take when it is next in front, and
    /// tells the app now if this is its own process.
    public func post() {
        let defaults = UserDefaults(suiteName: AppGroup.identifier) ?? .standard
        defaults.set(url.absoluteString, forKey: Self.pendingKey)
        NotificationCenter.default.post(name: Self.notification, object: nil, userInfo: ["url": url])
    }

    /// The route left by an intent, taken once.
    public static func takePending() -> AppRoute? {
        let defaults = UserDefaults(suiteName: AppGroup.identifier) ?? .standard
        guard let string = defaults.string(forKey: pendingKey) else { return nil }
        defaults.removeObject(forKey: pendingKey)
        return URL(string: string).flatMap(AppRoute.init(url:))
    }
}
