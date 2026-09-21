import Foundation
import Observation
import PDFKit
import PencilKit
import WarraqCore

/// Where a note or a text box is about to go, waiting for its words.
struct PendingPlacement: Identifiable, Equatable {
    let id = UUID()
    let tool: AnnotationTool
    let pageIndex: Int
    /// In user space.
    let rect: CGRect
}

/// The markup state of one document: the tool in hand, its colour, the
/// Pencil's drawings not yet committed, and the way every mark reaches the
/// file — PDFKit adds the annotation to its document, the core keeps just
/// that change as an incremental update (`file.rebase`), undo gets a step,
/// and the haptic fires on the commit.
@MainActor @Observable
final class AnnotationEditor {
    let model: DocumentModel
    var tool: AnnotationTool?
    var color: MarkupColor = .yellow
    var lineWidth: CGFloat = 3
    var textSize: CGFloat = 14
    /// The Pencil's strokes per page, until `commitInk()` makes them ink
    /// annotations: the drawing as the canvas shows it, and the same
    /// strokes in user space (the overlay converts them as they land).
    var inkDrawings: [Int: PKDrawing] = [:]
    var inkPaths: [Int: [InkPath]] = [:]
    var pending: PendingPlacement?
    /// Goes up on every commit: the view's haptic trigger.
    private(set) var commits = 0
    private(set) var error: String?
    weak var undoManager: UndoManager?

    init(model: DocumentModel) {
        self.model = model
    }

    var hasUncommittedInk: Bool { inkPaths.values.contains { !$0.isEmpty } }

    // MARK: - Text markup

    /// Highlights, underlines or strikes through a selection, one
    /// annotation per line, and commits.
    func markup(_ selection: PDFSelection, as tool: AnnotationTool) {
        guard tool.isTextMarkup else { return }
        var pages = Set<Int>()
        for line in selection.selectionsByLine() {
            for page in line.pages {
                let bounds = line.bounds(for: page)
                guard bounds.width > 0, bounds.height > 0 else { continue }
                let annotation = PDFAnnotation(bounds: bounds, forType: tool.subtype, withProperties: nil)
                annotation.color = color.uiColor
                page.addAnnotation(annotation)
                if let index = model.pdf?.index(for: page) { pages.insert(index) }
            }
        }
        guard !pages.isEmpty else { return }
        commit()
    }

    // MARK: - Shapes

    func addShape(_ tool: AnnotationTool, in rect: CGRect, on pageIndex: Int) {
        guard let page = model.pdf?.page(at: pageIndex), rect.width > 2, rect.height > 2 else { return }
        let annotation = PDFAnnotation(bounds: rect, forType: tool.subtype, withProperties: nil)
        annotation.color = color.uiColor
        let border = PDFBorder()
        border.lineWidth = lineWidth
        annotation.border = border
        page.addAnnotation(annotation)
        commit()
    }

    func addArrow(from start: CGPoint, to end: CGPoint, on pageIndex: Int) {
        guard let page = model.pdf?.page(at: pageIndex), hypot(end.x - start.x, end.y - start.y) > 4 else { return }
        let bounds = CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
                            width: abs(end.x - start.x), height: abs(end.y - start.y))
            .insetBy(dx: -lineWidth * 3, dy: -lineWidth * 3)
        let annotation = PDFAnnotation(bounds: bounds, forType: .line, withProperties: nil)
        annotation.color = color.uiColor
        annotation.startPoint = start
        annotation.endPoint = end
        annotation.endLineStyle = .closedArrow
        annotation.interiorColor = color.uiColor
        let border = PDFBorder()
        border.lineWidth = lineWidth
        annotation.border = border
        page.addAnnotation(annotation)
        commit()
    }

    // MARK: - Notes and text

    func addNote(_ text: String, at placement: PendingPlacement) {
        guard let page = model.pdf?.page(at: placement.pageIndex) else { return }
        let side: CGFloat = 22
        let bounds = CGRect(x: placement.rect.midX - side / 2, y: placement.rect.midY - side / 2, width: side, height: side)
        let annotation = PDFAnnotation(bounds: bounds, forType: .text, withProperties: nil)
        annotation.contents = text
        annotation.color = color.uiColor
        annotation.iconType = .comment
        page.addAnnotation(annotation)
        commit()
    }

    /// A text box. PDFKit draws it once; then the core redraws its
    /// appearance with shaped Arabic and a ToUnicode that reads back
    /// (`forms.fix_appearances`), so every viewer shows the words and every
    /// reader finds them.
    func addFreeText(_ text: String, at placement: PendingPlacement, size: CGFloat, rightToLeft: Bool) {
        guard let page = model.pdf?.page(at: placement.pageIndex) else { return }
        var rect = placement.rect
        if rect.width < 40 || rect.height < size * 1.5 {
            rect = CGRect(x: rect.minX, y: rect.maxY - size * 1.6, width: max(rect.width, 160), height: max(rect.height, size * 1.6))
        }
        let annotation = PDFAnnotation(bounds: rect, forType: .freeText, withProperties: nil)
        annotation.contents = text
        annotation.font = UIFont.systemFont(ofSize: size)
        annotation.fontColor = color.uiColor
        annotation.color = .clear
        annotation.alignment = rightToLeft ? .right : .left
        page.addAnnotation(annotation)
        commit(thenShapeArabic: true)
    }

    // MARK: - Ink

    /// Every stroke the Pencil left becomes an ink annotation of its colour
    /// and width (a PDF ink has one width: the pressure's variation stays
    /// on the canvas), then the pages commit together.
    func commitInk() {
        let pending = inkPaths.filter { !$0.value.isEmpty }
        inkDrawings.removeAll()
        inkPaths.removeAll()
        guard !pending.isEmpty, let pdf = model.pdf else { return }
        for (index, paths) in pending {
            guard let page = pdf.page(at: index) else { continue }
            for ink in paths {
                page.addAnnotation(Self.inkAnnotation(ink))
            }
        }
        commit()
    }

    /// Throws the strokes away instead.
    func discardInk() {
        inkDrawings.removeAll()
        inkPaths.removeAll()
    }

    /// A stroke, already in user space, as one ink annotation.
    static func inkAnnotation(_ ink: InkPath) -> PDFAnnotation {
        let width = max(ink.width, 1)
        let bounds = ink.path.bounds.insetBy(dx: -width, dy: -width)
        let annotation = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
        annotation.color = ink.color
        let border = PDFBorder()
        border.lineWidth = width
        annotation.border = border
        annotation.add(ink.path)
        return annotation
    }

    // MARK: - Removing

    func remove(_ annotation: PDFAnnotation) {
        guard let page = annotation.page else { return }
        page.removeAnnotation(annotation)
        commit()
    }

    /// Every markup annotation in the document, in page order.
    var annotations: [(page: Int, annotation: PDFAnnotation)] {
        guard let pdf = model.pdf else { return [] }
        return (0..<pdf.pageCount).flatMap { index -> [(Int, PDFAnnotation)] in
            (pdf.page(at: index)?.annotations ?? []).filter(\.isMarkup).map { (index, $0) }
        }
    }

    // MARK: - Committing

    /// The commit under way, so a test (or a Done that follows at once)
    /// can wait for it.
    private(set) var pendingCommit: Task<Void, Never>?

    private func commit(thenShapeArabic: Bool = false) {
        let undoManager = self.undoManager
        let previous = pendingCommit
        pendingCommit = Task {
            await previous?.value
            undoManager?.beginUndoGrouping()
            defer { undoManager?.endUndoGrouping() }
            do {
                try await model.commitPDFKitChanges(undoManager: undoManager)
                if thenShapeArabic {
                    try await shapeArabicAppearances(undoManager: undoManager)
                }
                commits += 1
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Waits for every commit started so far.
    func settle() async {
        while let task = pendingCommit {
            await task.value
            if pendingCommit == task { pendingCommit = nil }
        }
    }

    /// Redraws text boxes and fields whose words PDFKit wrote with a font
    /// that has no Arabic, with the bundled face, shaped.
    func shapeArabicAppearances(undoManager: UndoManager?) async throws {
        guard let font = AppFonts.arabic else { return }
        struct Args: Encodable { let password: String? }
        let reply = try await Core.callStatic(op: "forms.fix_appearances", args: Args(password: model.password), blobs: [model.bytes, font])
        let comments = reply.object["comments"] as? Int ?? 0
        let fields = reply.object["fields"] as? Int ?? 0
        if comments + fields > 0, let fixed = reply.blobs.first {
            try await model.replace(bytes: fixed, undoManager: undoManager)
        }
    }

    func clearError() {
        error = nil
    }
}

/// The Arabic face the core writes with — Amiri (SIL OFL), subset and
/// embedded on each write.
enum AppFonts {
    static let arabic: Data? = {
        guard let url = Bundle.main.url(forResource: "Amiri-Regular", withExtension: "ttf") else { return nil }
        return try? Data(contentsOf: url)
    }()
}
