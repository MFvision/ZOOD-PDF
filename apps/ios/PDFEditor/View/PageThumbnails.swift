import Observation
import PDFKit
import SwiftUI

/// Thumbnails of the pages, drawn by PDFKit once each per revision of the
/// document and kept while the document is open.
@MainActor @Observable
final class PageThumbnailCache {
    private var images: [Key: UIImage] = [:]
    @ObservationIgnored private var inFlight: Set<Key> = []

    private struct Key: Hashable {
        let revision: Int
        let page: Int
        let width: Int
    }

    func image(of page: Int, in model: DocumentModel, width: CGFloat) -> UIImage? {
        let key = Key(revision: model.revision, page: page, width: Int(width))
        if let image = images[key] { return image }
        guard !inFlight.contains(key), let pdfPage = model.pdf?.page(at: page) else { return nil }
        inFlight.insert(key)
        // The screen the app is on (iPhone Duo has two), not UIScreen.main.
        let traitScale = UITraitCollection.current.displayScale
        let scale = traitScale > 0 ? traitScale : 3
        let bounds = pdfPage.bounds(for: .cropBox)
        let rotated = pdfPage.rotation % 180 != 0
        let aspect = rotated ? bounds.width / max(bounds.height, 1) : bounds.height / max(bounds.width, 1)
        let size = CGSize(width: width * scale, height: width * aspect * scale)
        // PDFPage is not Sendable; the thumbnail is drawn on the main
        // actor but off the current turn, so the grid scrolls meanwhile.
        Task { @MainActor in
            let image = pdfPage.thumbnail(of: size, for: .cropBox)
            images[key] = image
            inFlight.remove(key)
            // Older revisions' pictures are not needed again.
            images = images.filter { $0.key.revision == model.revision }
        }
        return nil
    }
}

/// One page's thumbnail on paper, with its number under it.
struct PageThumbnail: View {
    let model: DocumentModel
    let cache: PageThumbnailCache
    let page: Int
    let width: CGFloat
    var selected = false
    var current = false

    var body: some View {
        VStack(spacing: Space.x2) {
            ZStack {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(Surface.paper)
                if let image = cache.image(of: page, in: model, width: width) {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                }
            }
            .aspectRatio(aspect, contentMode: .fit)
            .frame(width: width)
            .overlay {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(selected || current ? Color.accentColor : Surface.separator, lineWidth: selected ? 3 : 1)
            }
            .shadow(color: .black.opacity(0.14), radius: 4, y: 2)
            Text(page + 1, format: .number)
                .font(TextStyle.caption)
                .tabularNumbers()
                .foregroundStyle(current ? Color.accentColor : Surface.secondaryLabel)
        }
    }

    private var aspect: CGFloat {
        guard let pdfPage = model.pdf?.page(at: page) else { return 210 / 297 }
        let bounds = pdfPage.bounds(for: .cropBox)
        let rotated = pdfPage.rotation % 180 != 0
        let w = rotated ? bounds.height : bounds.width
        let h = rotated ? bounds.width : bounds.height
        return h > 0 ? w / h : 210 / 297
    }
}

/// The thumbnails beside the pages (a column on iPad) or under them (a
/// strip on iPhone): tap one to go to it; the page on screen is marked.
struct ThumbnailsSidebar: View {
    @Bindable var model: DocumentModel
    let cache: PageThumbnailCache
    let width: CGFloat
    let horizontal: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(horizontal ? .horizontal : .vertical) {
                Group {
                    if horizontal {
                        LazyHStack(spacing: Space.x4) { cells }
                            .padding(.horizontal, Space.x4)
                            .padding(.vertical, Space.x3)
                    } else {
                        LazyVStack(spacing: Space.x4) { cells }
                            .padding(.vertical, Space.x4)
                            .frame(width: width)
                    }
                }
            }
            .background(Surface.grouped)
            .onChange(of: model.currentPage, initial: true) {
                withAnimation(Motion.travel) {
                    proxy.scrollTo(model.currentPage, anchor: .center)
                }
            }
        }
        .accessibilityIdentifier("document.thumbnails")
    }

    private var cells: some View {
        ForEach(0..<max(model.pageCount, 0), id: \.self) { page in
            Button {
                model.currentPage = page
            } label: {
                PageThumbnail(model: model, cache: cache, page: page, width: horizontal ? width : width - Space.x6 * 2, current: page == model.currentPage)
            }
            .buttonStyle(.pressable)
            .id(page)
            .accessibilityLabel(Text("Page \(page + 1)"))
            .accessibilityAddTraits(page == model.currentPage ? .isSelected : [])
            .accessibilityIdentifier("thumbnail.\(page)")
        }
    }
}
