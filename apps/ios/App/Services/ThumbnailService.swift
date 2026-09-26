import CoreSpotlight
import PDFKit
import UIKit
import UniformTypeIdentifiers
import ZoodCore
import ZoodEngine

/// First-page pictures and document text, computed off the main actor.
enum ThumbnailService {
    /// PNG of page 1, fitted into `size` points at screen scale. nil for locked/empty files.
    static func firstPagePNG(_ data: Data, password: String? = nil, size: CGSize = CGSize(width: 300, height: 400)) async -> Data? {
        await Task.detached(priority: .utility) { () -> Data? in
            guard let doc = PDFDocument(data: data) else { return nil }
            if doc.isLocked {
                guard let password, doc.unlock(withPassword: password) else { return nil }
            }
            guard let page = doc.page(at: 0) else { return nil }
            return page.thumbnail(of: size, for: .cropBox).pngData()
        }.value
    }

    /// Page count via PDFKit (cheap) for recents.
    static func pageCount(_ data: Data) async -> Int? {
        await Task.detached(priority: .utility) { () -> Int? in
            PDFDocument(data: data)?.pageCount
        }.value
    }

    /// Plain text: the engine's `text.plain` when this build has warraq-text, else PDFKit.
    static func plainText(_ data: Data, password: String? = nil, limit: Int = 100_000) async -> String? {
        if WarraqEngine.supports("text.plain"), let engine = try? WarraqEngine(data: data, password: password),
           let text = await engine.plainText(maxCharacters: limit) {
            return text
        }
        return await Task.detached(priority: .utility) { () -> String? in
            guard let doc = PDFDocument(data: data) else { return nil }
            if doc.isLocked {
                guard let password, doc.unlock(withPassword: password) else { return nil }
            }
            return doc.string.map { String($0.prefix(limit)) }
        }.value
    }
}

/// Core Spotlight index of recent files (on-device only). Protected or redacted files are
/// indexed without text and without a picture.
enum SpotlightIndexer {
    static let domain = "sa.zood.pdf.recents"

    static func index(_ recent: RecentDocument, text: String?, thumbnail: Data?) async {
        let attrs = CSSearchableItemAttributeSet(contentType: .pdf)
        attrs.title = FileNaming.baseName(recent.name)
        attrs.displayName = recent.name
        attrs.textContent = text
        attrs.thumbnailData = thumbnail
        attrs.keywords = recent.tags
        attrs.contentModificationDate = recent.openedAt
        if let n = recent.pageCount { attrs.pageCount = NSNumber(value: n) }
        let item = CSSearchableItem(uniqueIdentifier: recent.id, domainIdentifier: domain, attributeSet: attrs)
        item.expirationDate = .distantFuture
        try? await CSSearchableIndex.default().indexSearchableItems([item])
    }

    static func remove(id: String) async {
        try? await CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: [id])
    }
}
