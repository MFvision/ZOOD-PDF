import SwiftUI
import UIKit

/// The Home Screen's quick actions (a long press on the icon): Scan, and
/// the document opened last, named. Each carries an `AppRoute` URL that the
/// scene delegate hands to the Library.
enum QuickActions {
    static let scanType = "app.warraq.ios.scan"
    static let lastType = "app.warraq.ios.last"
    private static let urlKey = "url"

    /// Sets the items: Scan always, the last document when there is one.
    /// UIKit's items take Strings, so these titles are localized as such.
    @MainActor
    static func update(lastDocument: RecentDocument?) {
        var items = [
            UIApplicationShortcutItem(type: scanType, localizedTitle: String(localized: "Scan a document"),
                                      localizedSubtitle: nil, icon: UIApplicationShortcutIcon(systemImageName: "doc.viewfinder"),
                                      userInfo: [urlKey: AppRoute.scan.url.absoluteString as NSString]),
        ]
        if let lastDocument {
            items.append(UIApplicationShortcutItem(type: lastType, localizedTitle: lastDocument.name,
                                                   localizedSubtitle: String(localized: "Last document"),
                                                   icon: UIApplicationShortcutIcon(systemImageName: "clock.arrow.circlepath"),
                                                   userInfo: [urlKey: AppRoute.open(id: lastDocument.id).url.absoluteString as NSString]))
        }
        UIApplication.shared.shortcutItems = items
    }

    /// The route a tapped item asks for.
    static func route(for item: UIApplicationShortcutItem) -> AppRoute? {
        if let string = item.userInfo?[urlKey] as? String, let url = URL(string: string), let route = AppRoute(url: url) {
            return route
        }
        switch item.type {
        case scanType: return .scan
        case lastType: return .lastDocument
        default: return nil
        }
    }
}

/// The app delegate: hands the scene delegate over, so quick actions and
/// the launch-time shortcut reach the Library.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

/// Posts the route of a quick action; the Library takes it as the scene
/// becomes active.
@MainActor
final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        if let item = connectionOptions.shortcutItem, let route = QuickActions.route(for: item) {
            route.post()
        }
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem) async -> Bool {
        guard let route = QuickActions.route(for: shortcutItem) else { return false }
        route.post()
        return true
    }
}
