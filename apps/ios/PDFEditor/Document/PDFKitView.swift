import PDFKit
import SwiftUI

/// PDFKit's view of the pages: its own pinch, scroll and page physics,
/// continuous vertical, pages ordered right-to-left for an Arabic document.
struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument
    let displaysRTL: Bool
    @Binding var currentPage: Int

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.displaysRTL = displaysRTL
        view.pageShadowsEnabled = true
        view.backgroundColor = .secondarySystemBackground
        view.document = document
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.pageChanged(_:)),
            name: .PDFViewPageChanged,
            object: view
        )
        // Opened at a page (a search hit): go there once the view has laid
        // out its pages.
        if currentPage > 0, let page = document.page(at: min(currentPage, max(document.pageCount - 1, 0))) {
            DispatchQueue.main.async { view.go(to: page) }
        }
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        context.coordinator.parent = self
        if view.document !== document {
            // The bytes changed (an edit): show the same page of the new
            // document, and keep the direction the document asks for.
            view.document = document
            view.displaysRTL = displaysRTL
            if let page = document.page(at: min(currentPage, max(document.pageCount - 1, 0))) {
                view.go(to: page)
            }
        } else if let shown = view.currentPage, document.index(for: shown) != currentPage,
                  let page = document.page(at: min(currentPage, max(document.pageCount - 1, 0))) {
            // The page was asked for from outside (Go to page, a search hit).
            view.go(to: page)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    @MainActor
    final class Coordinator: NSObject {
        var parent: PDFKitView

        init(parent: PDFKitView) {
            self.parent = parent
        }

        @objc func pageChanged(_ notification: Notification) {
            guard let view = notification.object as? PDFView,
                  let page = view.currentPage,
                  let document = view.document else { return }
            let index = document.index(for: page)
            if parent.currentPage != index {
                parent.currentPage = index
            }
        }
    }
}
