import PDFKit
import PencilKit
import SwiftUI

/// The PDFView on screen, reachable from SwiftUI views that need its
/// geometry (placing a signature) or its navigation (Go to page).
@MainActor @Observable
final class PDFViewHost {
    weak var view: PDFView?

    func go(toPage index: Int) {
        guard let view, let document = view.document, let page = document.page(at: index) else { return }
        view.go(to: page)
    }

    func go(to selection: PDFSelection) {
        guard let view else { return }
        view.setCurrentSelection(selection, animate: true)
        view.go(to: selection)
    }

    /// The page under a point of the PDFView, and the point in its user space.
    func page(at point: CGPoint) -> (page: PDFPage, index: Int, point: CGPoint)? {
        guard let view, let page = view.page(for: point, nearest: true), let document = view.document else { return nil }
        return (page, document.index(for: page), view.convert(point, to: page))
    }

    /// A box of the PDFView, in a page's user space.
    func userRect(_ rect: CGRect, on page: PDFPage) -> CGRect {
        view?.convert(rect, to: page) ?? rect
    }
}

/// PDFKit's view of the pages: its own pinch, scroll and page physics,
/// continuous or one page at a time (swiped, no curl), pages ordered
/// right-to-left for an Arabic document, night mode, the search's hits
/// highlighted and scrolled to, and the markup tools laid over the pages.
struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument
    let displaysRTL: Bool
    let layout: PageLayout
    let night: Bool
    let editor: AnnotationEditor?
    /// The tool in hand, passed on its own so a change of tool reaches the
    /// overlays (the view is only re-evaluated for what its body reads).
    let tool: AnnotationTool?
    /// The pen's kind, colour and width, so the canvases follow the palette.
    var inkSignature: String = ""
    /// Edit PDF, when the editor is open: the overlays get its layer.
    var edit: EditModel?
    /// What the editor is doing, passed on its own so a change of mode, of
    /// what is picked or of the lists reaches the layers over the pages.
    var editSignature: String = ""
    let host: PDFViewHost?
    /// PDFKit draws these highlighted (the search's hits) and scrolls to
    /// `currentHighlight` when it changes.
    var highlights: [PDFSelection] = []
    var currentHighlight: PDFSelection?
    @Binding var currentPage: Int

    func makeUIView(context: Context) -> DocumentPDFView {
        let view = DocumentPDFView()
        view.autoScales = true
        view.displayDirection = .vertical
        view.displaysRTL = displaysRTL
        view.pageShadowsEnabled = true
        view.backgroundColor = .secondarySystemBackground
        view.document = document
        view.pageOverlayViewProvider = context.coordinator
        view.onMarkup = { [weak editor] tool, selection in
            editor?.markup(selection, as: tool)
        }
        view.accessibilityIdentifier = "document.pdfView"
        // One element to UIKit's accessibility too: PDFKit's own text
        // elements (visual order for Arabic) stay out of the tree; the
        // page's value is the core's text, on the SwiftUI element around it.
        view.isAccessibilityElement = true
        applyLayout(to: view)
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.pageChanged(_:)),
            name: .PDFViewPageChanged,
            object: view
        )
        host?.view = view
        context.coordinator.layout = layout
        context.coordinator.night = night
        // Opened at a page (a search hit from the Library): go there once
        // the view has laid out its pages.
        if currentPage > 0, let page = document.page(at: min(currentPage, max(document.pageCount - 1, 0))) {
            DispatchQueue.main.async { view.go(to: page) }
        }
        return view
    }

    func updateUIView(_ view: DocumentPDFView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        host?.view = view
        view.locale = context.environment.locale
        if view.document !== document {
            // The bytes changed (an edit): show the same place in the new
            // document, and keep the direction the document asks for.
            let destination = view.currentDestination
            let scale = view.scaleFactor
            coordinator.overlays.removeAll()
            view.document = document
            view.displaysRTL = displaysRTL
            let index = min(currentPage, max(document.pageCount - 1, 0))
            if let page = document.page(at: index) {
                if let destination, !view.autoScales {
                    view.scaleFactor = scale
                    view.go(to: PDFDestination(page: page, at: destination.point))
                } else {
                    view.go(to: page)
                }
            }
        } else if view.displaysRTL != displaysRTL {
            view.displaysRTL = displaysRTL
        }
        if coordinator.layout != layout {
            coordinator.layout = layout
            let page = view.currentPage
            applyLayout(to: view)
            if let page { view.go(to: page) }
        }
        if coordinator.night != night || coordinator.tool != tool || coordinator.editor !== editor {
            coordinator.night = night
            coordinator.tool = tool
            coordinator.editor = editor
            for overlay in coordinator.overlays.values {
                // The editor can arrive after the first page was shown.
                overlay.editor = editor
                overlay.update(night: night, tool: tool)
            }
        }
        if coordinator.inkSignature != inkSignature {
            coordinator.inkSignature = inkSignature
            for overlay in coordinator.overlays.values {
                overlay.applyInk()
            }
        }
        if coordinator.editSignature != editSignature || coordinator.edit !== edit {
            coordinator.editSignature = editSignature
            coordinator.edit = edit
            for overlay in coordinator.overlays.values {
                overlay.edit = edit
                overlay.update(night: night, tool: tool)
            }
            // One element while the pages are only read — the core's text of
            // the page is its value — and a container while the editor is
            // open, so the field the text is typed in, which lives inside a
            // page's overlay, is reachable by VoiceOver and by a test.
            view.isAccessibilityElement = edit == nil
            // The arrow keys are the editor's only while something is picked.
            if let edit, edit.hasSomethingPicked {
                view.onNudge = { dx, dy, far in
                    Task { await edit.nudge(dx: dx, dy: dy, far: far) }
                }
            } else {
                view.onNudge = nil
            }
        }
        if view.highlightedSelections?.count != highlights.count || view.highlightedSelections?.first !== highlights.first {
            view.highlightedSelections = highlights.isEmpty ? nil : highlights
        }
        if let currentHighlight, coordinator.shownHighlight !== currentHighlight {
            coordinator.shownHighlight = currentHighlight
            view.setCurrentSelection(currentHighlight, animate: true)
            view.go(to: currentHighlight)
        } else if currentHighlight == nil, coordinator.shownHighlight != nil {
            coordinator.shownHighlight = nil
            view.clearSelection()
        }
        // Go to page, asked from outside (the thumbnails, the outline, a
        // number typed): the binding moved but the view did not.
        if let document = view.document, let page = view.currentPage, document.index(for: page) != currentPage,
           currentPage >= 0, currentPage < document.pageCount, coordinator.lastReported != currentPage,
           let target = document.page(at: currentPage) {
            view.go(to: target)
        }
    }

    private func applyLayout(to view: PDFView) {
        switch layout {
        case .continuous:
            view.usePageViewController(false)
            view.displayMode = .singlePageContinuous
        case .single:
            view.displayMode = .singlePage
            // Apple's own page swipe, no curl.
            view.usePageViewController(true, withViewOptions: [UIPageViewController.OptionsKey.interPageSpacing: 12])
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency PDFPageOverlayViewProvider {
        var parent: PDFKitView
        var layout: PageLayout = .continuous
        var night = false
        var tool: AnnotationTool?
        weak var editor: AnnotationEditor?
        var shownHighlight: PDFSelection?
        var lastReported = -1
        var overlays: [PDFPage: PageOverlayView] = [:]
        var inkSignature = ""
        weak var edit: EditModel?
        var editSignature = ""

        init(parent: PDFKitView) {
            self.parent = parent
        }

        @objc func pageChanged(_ notification: Notification) {
            guard let view = notification.object as? PDFView,
                  let page = view.currentPage,
                  let document = view.document else { return }
            let index = document.index(for: page)
            lastReported = index
            if parent.currentPage != index {
                parent.currentPage = index
            }
        }

        func pdfView(_ view: PDFView, overlayViewFor page: PDFPage) -> UIView? {
            if let overlay = overlays[page] {
                overlay.edit = parent.edit ?? edit
                overlay.update(night: night, tool: tool)
                return overlay
            }
            guard let document = view.document else { return nil }
            let overlay = PageOverlayView(page: page, pageIndex: document.index(for: page), pdfView: view,
                                          editor: parent.editor ?? editor)
            overlay.edit = parent.edit ?? edit
            overlay.update(night: night, tool: tool)
            overlays[page] = overlay
            return overlay
        }

        func pdfView(_ pdfView: PDFView, willEndDisplayingOverlayView overlayView: UIView, for page: PDFPage) {
            // Kept in `overlays`: the drawing stays with the page while it
            // is scrolled away.
        }
    }
}

/// PDFView with the markup actions in the selection's edit menu: select
/// words, then Highlight, Underline or Strike through, as in Books.
final class DocumentPDFView: PDFView {
    var onMarkup: ((AnnotationTool, PDFSelection) -> Void)?
    /// The interface's language (chosen in Settings, not always the system's).
    var locale: Locale = .current
    /// Edit PDF's arrow keys, with a keyboard: a point at a time over the
    /// picked picture or link, ten with Shift. Nil when nothing is picked,
    /// so the keys stay the view's own.
    var onNudge: ((CGFloat, CGFloat, Bool) -> Void)?
    /// Edit PDF's field, while one is open. It lives inside a page's
    /// overlay, and PDFKit's page lists its own text to accessibility
    /// instead of its subviews, so the field is listed here, first — or
    /// VoiceOver (and the keyboard's focus, for a test) would never find it.
    weak var editField: UIView? {
        didSet { UIAccessibility.post(notification: .layoutChanged, argument: editField) }
    }

    override var accessibilityElements: [Any]? {
        get {
            guard let editField else { return super.accessibilityElements }
            return [editField] + (super.accessibilityElements ?? subviews)
        }
        set { super.accessibilityElements = newValue }
    }

    override var keyCommands: [UIKeyCommand]? {
        guard onNudge != nil else { return super.keyCommands }
        let keys = [UIKeyCommand.inputLeftArrow, UIKeyCommand.inputRightArrow,
                    UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow]
        // Which way each key moves is read back in `nudged`, from the
        // command's own input and modifiers.
        let commands = keys.flatMap { key in
            [UIKeyModifierFlags(), .shift].map { modifiers -> UIKeyCommand in
                let command = UIKeyCommand(title: "", action: #selector(nudged(_:)), input: key,
                                           modifierFlags: modifiers)
                command.wantsPriorityOverSystemBehavior = true
                return command
            }
        }
        return commands + (super.keyCommands ?? [])
    }

    @objc private func nudged(_ command: UIKeyCommand) {
        guard let onNudge, let input = command.input else { return }
        let far = command.modifierFlags.contains(.shift)
        switch input {
        case UIKeyCommand.inputLeftArrow: onNudge(-1, 0, far)
        case UIKeyCommand.inputRightArrow: onNudge(1, 0, far)
        case UIKeyCommand.inputUpArrow: onNudge(0, -1, far)
        case UIKeyCommand.inputDownArrow: onNudge(0, 1, far)
        default: break
        }
    }

    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard let selection = currentSelection, selection.string?.isEmpty == false else { return }
        let actions = [AnnotationTool.highlight, .underline, .strikeout].map { tool in
            UIAction(title: String(localized: String.LocalizationValue(tool.rawValueTitle), locale: locale), image: UIImage(systemName: tool.symbol)) { [weak self] _ in
                guard let self, let selection = self.currentSelection else { return }
                self.onMarkup?(tool, selection)
                self.clearSelection()
            }
        }
        let menu = UIMenu(title: "", identifier: UIMenu.Identifier("app.warraq.markup"), options: .displayInline, children: actions)
        builder.insertSibling(menu, afterMenu: .standardEdit)
    }
}

private extension AnnotationTool {
    /// The title's key, for the UIKit menu (SwiftUI's `LocalizedStringKey`
    /// is not reachable from UIKit).
    var rawValueTitle: String {
        switch self {
        case .highlight: "Highlight"
        case .underline: "Underline"
        case .strikeout: "Strike through"
        case .ink: "Draw"
        case .note: "Note"
        case .rectangle: "Rectangle"
        case .ellipse: "Ellipse"
        case .arrow: "Arrow"
        case .freeText: "Text"
        }
    }
}
