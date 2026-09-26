import Foundation

/// Identifiers shared by the app, the widgets and the intents.
public enum ZoodShared {
    /// App Group used for the recents index and thumbnails.
    public static let appGroup = "group.sa.zood.pdf"
    public static let urlScheme = "zoodpdf"
    public static let widgetKindRecents = "sa.zood.pdf.widget.recents"
    public static let widgetKindScan = "sa.zood.pdf.widget.scan"
    public static let widgetKindLockScan = "sa.zood.pdf.widget.lockscan"
    public static let controlKindScan = "sa.zood.pdf.control.scan"
    public static let userActivityOpen = "sa.zood.pdf.open"

    /// Recents directory inside the App Group container, or nil when the group is unavailable
    /// (e.g. an unsigned build); callers fall back to Application Support.
    public static func groupRecentsDirectory() -> URL? {
        #if os(iOS) || os(macOS)
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("Recents", isDirectory: true)
        #else
        nil
        #endif
    }
}

/// `zoodpdf://` links used by widgets, the Control Center control, intents and Spotlight.
public enum DeepLink: Equatable, Sendable {
    public enum ScanMode: String, CaseIterable, Sendable, Codable {
        case document, whiteboard, idCard = "idcard", book
    }

    case home
    case scan(ScanMode)
    case openRecent(id: String)
    /// Open a recent document and start reading it aloud.
    case readAloud(id: String)
    case combine
    case compress

    public var url: URL {
        var c = URLComponents()
        c.scheme = ZoodShared.urlScheme
        switch self {
        case .home:
            c.host = "home"
        case .scan(let mode):
            c.host = "scan"
            c.queryItems = [URLQueryItem(name: "mode", value: mode.rawValue)]
        case .openRecent(let id):
            c.host = "open"
            c.queryItems = [URLQueryItem(name: "id", value: id)]
        case .readAloud(let id):
            c.host = "read"
            c.queryItems = [URLQueryItem(name: "id", value: id)]
        case .combine:
            c.host = "combine"
        case .compress:
            c.host = "compress"
        }
        return c.url ?? URL(fileURLWithPath: "/")
    }

    public init?(url: URL) {
        guard url.scheme?.lowercased() == ZoodShared.urlScheme,
              let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        func q(_ name: String) -> String? { c.queryItems?.first { $0.name == name }?.value }
        switch c.host?.lowercased() {
        case "home", nil, "":
            self = .home
        case "scan":
            self = .scan(q("mode").flatMap(ScanMode.init(rawValue:)) ?? .document)
        case "open":
            guard let id = q("id"), !id.isEmpty, id.count <= 64 else { return nil }
            self = .openRecent(id: id)
        case "read":
            guard let id = q("id"), !id.isEmpty, id.count <= 64 else { return nil }
            self = .readAloud(id: id)
        case "combine":
            self = .combine
        case "compress":
            self = .compress
        default:
            return nil
        }
    }
}
