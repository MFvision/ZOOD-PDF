import PDFKit
import PencilKit
import SwiftUI

/// Hosts the session's PDFView. Page changes flow back into `session.pageIndex`.
struct PDFKitView: UIViewRepresentable {
    let session: DocumentSession
    @Environment(\.layoutDirection) private var layoutDirection

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeUIView(context: Context) -> PDFView {
        let view = session.pdfView
        view.displaysRTL = layoutDirection == .rightToLeft
        NotificationCenter.default.addObserver(
            context.coordinator, selector: #selector(Coordinator.pageChanged(_:)),
            name: .PDFViewPageChanged, object: view)
        view.accessibilityIdentifier = "doc.pdfview"
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        view.displaysRTL = layoutDirection == .rightToLeft
        // Text selection is only useful while reading or highlighting text.
        let tool = session.tool
        view.isUserInteractionEnabled = tool == nil || tool == .textHighlight || tool == .eraser
    }

    static func dismantleUIView(_ view: PDFView, coordinator: Coordinator) {
        NotificationCenter.default.removeObserver(coordinator)
    }

    @MainActor
    final class Coordinator: NSObject {
        let session: DocumentSession
        init(session: DocumentSession) { self.session = session }

        @objc func pageChanged(_ note: Notification) {
            guard let view = note.object as? PDFView, let page = view.currentPage, let doc = view.document else { return }
            let index = doc.index(for: page)
            if index != NSNotFound, index != session.pageIndex { session.pageIndex = index }
        }

        /// Eraser: tapping an ink or highlight annotation removes it.
        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard session.tool == .eraser, let view = gesture.view as? PDFView else { return }
            let point = gesture.location(in: view)
            guard let page = view.page(for: point, nearest: false) else { return }
            let p = view.convert(point, to: page)
            // Search a few points around the tap: thin ink strokes are hard to hit exactly.
            let hit = page.annotations.last { a in
                (a.type == PDFAnnotationSubtype.ink.rawValue.replacingOccurrences(of: "/", with: "")
                    || a.type == PDFAnnotationSubtype.highlight.rawValue.replacingOccurrences(of: "/", with: ""))
                    && a.bounds.insetBy(dx: -6, dy: -6).contains(p)
            }
            if let hit {
                page.removeAnnotation(hit)
                session.didRemove(hit, on: page)
            }
        }
    }
}

/// iPad thumbnails rail, driven by PDFKit's own PDFThumbnailView.
struct ThumbnailRail: UIViewRepresentable {
    let session: DocumentSession

    func makeUIView(context: Context) -> PDFThumbnailView {
        let v = PDFThumbnailView()
        v.pdfView = session.pdfView
        v.layoutMode = .vertical
        v.thumbnailSize = CGSize(width: 90, height: 120)
        v.backgroundColor = .clear
        v.contentInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        return v
    }

    func updateUIView(_ v: PDFThumbnailView, context: Context) {
        if v.pdfView !== session.pdfView { v.pdfView = session.pdfView }
    }
}

enum InkColor: String, CaseIterable, Identifiable {
    case black, blue, red, green, yellow, purple
    var id: String { rawValue }

    var uiColor: UIColor {
        switch self {
        case .black: .black
        case .blue: UIColor(red: 0.16, green: 0.38, blue: 0.94, alpha: 1)
        case .red: UIColor(red: 0.90, green: 0.22, blue: 0.21, alpha: 1)
        case .green: UIColor(red: 0.18, green: 0.62, blue: 0.33, alpha: 1)
        case .yellow: UIColor(red: 1.0, green: 0.82, blue: 0.10, alpha: 1)
        case .purple: UIColor(red: 0.55, green: 0.33, blue: 0.90, alpha: 1)
        }
    }

    var name: LocalizedStringKey {
        switch self {
        case .black: "color.black"
        case .blue: "color.blue"
        case .red: "color.red"
        case .green: "color.green"
        case .yellow: "color.yellow"
        case .purple: "color.purple"
        }
    }
}

/// Transparent PencilKit canvas over the PDF while a drawing tool is active. Each finished
/// stroke becomes a PDF ink annotation on the page under it (then the canvas is cleared), so
/// what is saved is standard PDF, readable in any viewer.
struct PencilCanvas: UIViewRepresentable {
    let session: DocumentSession

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeUIView(context: Context) -> PKCanvasView {
        let canvas = PKCanvasView()
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.isScrollEnabled = false
        canvas.drawingPolicy = UIDevice.current.userInterfaceIdiom == .pad ? .default : .anyInput
        canvas.delegate = context.coordinator
        canvas.accessibilityIdentifier = "doc.canvas"
        context.coordinator.canvas = canvas
        return canvas
    }

    func updateUIView(_ canvas: PKCanvasView, context: Context) {
        canvas.tool = InkConverter.pkTool(for: session.tool ?? .pen, color: session.inkColor, width: session.inkWidth)
    }

    @MainActor
    final class Coordinator: NSObject, PKCanvasViewDelegate {
        let session: DocumentSession
        weak var canvas: PKCanvasView?
        private var clearing = false

        init(session: DocumentSession) { self.session = session }

        nonisolated func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            MainActor.assumeIsolated { commit(canvasView) }
        }

        private func commit(_ canvasView: PKCanvasView) {
            guard !clearing, !canvasView.drawing.strokes.isEmpty, let tool = session.tool else { return }
            for stroke in canvasView.drawing.strokes {
                if let (page, annotation) = InkConverter.annotation(
                    for: stroke, from: canvasView, in: session.pdfView, tool: tool,
                    color: session.inkColor, width: session.inkWidth) {
                    page.addAnnotation(annotation)
                    session.didAdd(annotation, on: page)
                }
            }
            clearing = true
            canvasView.drawing = PKDrawing()
            clearing = false
        }
    }
}

/// PencilKit → PDF ink annotations.
@MainActor
enum InkConverter {
    static func pkTool(for tool: DocumentSession.Tool, color: InkColor, width: CGFloat) -> any PKTool {
        switch tool {
        case .pen: PKInkingTool(.pen, color: color.uiColor, width: width)
        case .marker: PKInkingTool(.marker, color: color.uiColor, width: width * 3)
        case .highlighter: PKInkingTool(.marker, color: color.uiColor.withAlphaComponent(0.35), width: width * 6)
        case .eraser, .textHighlight: PKInkingTool(.pen, color: .clear, width: 1)
        }
    }

    /// Convert one stroke drawn on `canvas` (which covers `pdfView`) into an ink annotation on
    /// the page under its first point. Coordinates go canvas → PDFView → page space.
    static func annotation(
        for stroke: PKStroke, from canvas: UIView, in pdfView: PDFView, tool: DocumentSession.Tool,
        color: InkColor, width: CGFloat
    ) -> (PDFPage, PDFAnnotation)? {
        let points = stroke.path.interpolatedPoints(by: .distance(2)).map { $0.location.applying(stroke.transform) }
        guard let first = points.first else { return nil }
        guard let page = pdfView.page(for: canvas.convert(first, to: pdfView), nearest: true) else { return nil }
        let pagePoints = points.map { pdfView.convert(canvas.convert($0, to: pdfView), to: page) }
        let scale = max(pdfView.scaleFactor, 0.01)
        let (lineWidth, alpha): (CGFloat, CGFloat) = switch tool {
        case .pen: (width / scale, 1)
        case .marker: (width * 3 / scale, 0.9)
        case .highlighter: (width * 6 / scale, 0.35)
        case .eraser, .textHighlight: (width / scale, 1)
        }
        return (page, inkAnnotation(points: pagePoints, lineWidth: lineWidth, color: color.uiColor.withAlphaComponent(alpha)))
    }

    /// PDFKit ink paths are relative to the annotation's bounds origin.
    static func inkAnnotation(points: [CGPoint], lineWidth: CGFloat, color: UIColor) -> PDFAnnotation {
        let minX = points.map(\.x).min() ?? 0
        let minY = points.map(\.y).min() ?? 0
        let maxX = points.map(\.x).max() ?? 0
        let maxY = points.map(\.y).max() ?? 0
        let bounds = CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
            .insetBy(dx: -lineWidth, dy: -lineWidth)
        let path = UIBezierPath()
        for (i, p) in points.enumerated() {
            let local = CGPoint(x: p.x - bounds.minX, y: p.y - bounds.minY)
            if i == 0 { path.move(to: local) } else { path.addLine(to: local) }
        }
        if points.count == 1, let p = points.first {
            path.addLine(to: CGPoint(x: p.x - bounds.minX + 0.1, y: p.y - bounds.minY))
        }
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        let annotation = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
        let border = PDFBorder()
        border.lineWidth = lineWidth
        annotation.border = border
        annotation.color = color
        annotation.add(path)
        annotation.setValue("ZOOD PDF", forAnnotationKey: .textLabel)
        return annotation
    }

    /// Yellow highlight annotations over a text selection, one per line.
    static func highlight(_ selection: PDFSelection, color: UIColor) -> [(PDFPage, PDFAnnotation)] {
        var out: [(PDFPage, PDFAnnotation)] = []
        for line in selection.selectionsByLine() {
            for page in line.pages {
                let b = line.bounds(for: page)
                guard b.width > 0, b.height > 0 else { continue }
                let a = PDFAnnotation(bounds: b, forType: .highlight, withProperties: nil)
                a.color = color.withAlphaComponent(0.5)
                a.quadrilateralPoints = [
                    NSValue(cgPoint: CGPoint(x: 0, y: b.height)), NSValue(cgPoint: CGPoint(x: b.width, y: b.height)),
                    NSValue(cgPoint: CGPoint(x: 0, y: 0)), NSValue(cgPoint: CGPoint(x: b.width, y: 0)),
                ]
                out.append((page, a))
            }
        }
        return out
    }
}
