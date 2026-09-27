import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

/// Core Spotlight kept in step with the Library's index: one item per
/// document — its name, its kind, the start of its text — so the iOS
/// search finds documents, and opens them in the app. Everything stays in
/// the device's own Spotlight index.
enum SpotlightIndex {
    static let domain = "app.warraq.ios.library"
    /// How much of a document's text Spotlight gets.
    static let textLimit = 60_000

    static var isAvailable: Bool { CSSearchableIndex.isIndexingAvailable() }

    /// Puts a document in, or replaces what was there under the same key.
    static func index(key: String, name: String, kind: LibraryKind, pages: Int, text: String, thumbnailURL: URL?, date: Date?) async {
        guard isAvailable else { return }
        let attributes = CSSearchableItemAttributeSet(contentType: kind == .image ? .image : .pdf)
        attributes.title = name
        attributes.displayName = name
        attributes.identifier = key
        attributes.contentDescription = String(text.prefix(300))
        attributes.textContent = String(text.prefix(textLimit))
        attributes.pageCount = NSNumber(value: pages)
        attributes.thumbnailURL = thumbnailURL
        attributes.contentCreationDate = date
        attributes.kind = kind.rawValue
        let item = CSSearchableItem(uniqueIdentifier: key, domainIdentifier: domain, attributeSet: attributes)
        item.expirationDate = .distantFuture
        try? await CSSearchableIndex.default().indexSearchableItems([item])
    }

    static func delete(keys: [String]) async {
        guard isAvailable, !keys.isEmpty else { return }
        try? await CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: keys)
    }

    static func deleteAll() async {
        guard isAvailable else { return }
        try? await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain])
    }

    /// The document key a Spotlight result carries.
    static func key(from activity: NSUserActivity) -> String? {
        guard activity.activityType == CSSearchableItemActionType else { return nil }
        return activity.userInfo?[CSSearchableItemActivityIdentifier] as? String
    }
}
