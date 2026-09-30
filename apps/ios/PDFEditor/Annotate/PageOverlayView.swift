import PDFKit
import PencilKit
import UIKit

/// The view PDFKit lays over each page (`PDFPageOverlayViewProvider`): the
/// Pencil's canvas while the drawing tool is in hand,
/// and the gestures of the other tools — a drag that marks text or draws a
/// box, a tap that drops a note — each tracking the finger 1:1 and
/// committing on release. Without a tool it lets every touch through to
/// PDFKit's own scrolling, pinching and selecting.
@MainActor
final class PageOverlayView: UIView, PKCanvasViewDelegate, UIGestureRecognizerDelegate, UIPencilInteractionDelegate {
    let page: PDFPage
    let pageIndex: Int
    weak var pdfView: PDFView?
    weak var editor: AnnotationEditor?

    /// Edit PDF, when it is open: its own layer over the page, added beside
    /// the markup gestures and removed when the editor closes.
    weak var edit: EditModel?

    private var canvas: PKCanvasView?
    private var editLayer: EditPageLayer?
    private let preview = CAShapeLayer()
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
    private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    private var dragStart: CGPoint = .zero
    private var tool: AnnotationTool?

    init(page: PDFPage, pageIndex: Int, pdfView: PDFView, editor: AnnotationEditor?) {
        self.page = page
        self.pageIndex = pageIndex
        self.pdfView = pdfView
        self.editor = editor
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        preview.fillColor = nil
        preview.lineWidth = 2
        preview.lineJoin = .round
        preview.lineCap = .round
        layer.addSublayer(preview)
        pan.maximumNumberOfTouches = 1
        pan.delegate = self
        tap.delegate = self
        addGestureRecognizer(pan)
        addGestureRecognizer(tap)
        accessibilityIdentifier = "page.overlay.\(pageIndex)"
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        canvas?.frame = bounds
        editLayer?.frame = bounds
        preview.frame = bounds
    }

    // MARK: - What the overlay shows

    func update(night: Bool, tool: AnnotationTool?) {
        self.tool = tool
        let active = tool != nil
        isUserInteractionEnabled = active || edit != nil
        pan.isEnabled = active && tool != .ink
        tap.isEnabled = active && tool != .ink
        if tool == .ink {
            showCanvas()
        } else {
            hideCanvas()
        }
        showEditLayer()
    }

    /// Edit PDF's layer: over the page while the editor is open, gone the
    /// moment it closes, so nothing it drew is left on a page nobody is
    /// editing.
    private func showEditLayer() {
        guard let edit, let pdfView else {
            editLayer?.removeFromSuperview()
            editLayer = nil
            return
        }
        if let editLayer {
            editLayer.edit = edit
            editLayer.frame = bounds
            editLayer.redraw()
            return
        }
        let layer = EditPageLayer(page: page, pageIndex: pageIndex, pdfView: pdfView, edit: edit)
        layer.frame = bounds
        addSubview(layer)
        editLayer = layer
    }

    private func showCanvas() {
        if canvas == nil {
            let canvas = PKCanvasView(frame: bounds)
            canvas.backgroundColor = .clear
            canvas.isOpaque = false
            canvas.drawingPolicy = .anyInput
            canvas.delegate = self
            canvas.isScrollEnabled = false
            canvas.accessibilityIdentifier = "page.canvas.\(pageIndex)"
            canvas.tool = editor?.inkTool ?? PKInkingTool(.pen, color: .black, width: 4)
            // The Pencil's double-tap: eraser and back, as the palette shows.
            canvas.addInteraction(UIPencilInteraction(delegate: self))
            addSubview(canvas)
            self.canvas = canvas
        }
        // The strokes not yet committed, or a clean canvas.
        canvas?.drawing = editor?.inkDrawings[pageIndex] ?? PKDrawing()
        canvas?.tool = editor?.inkTool ?? PKInkingTool(.pen, color: .black, width: 4)
        canvas?.isHidden = false
    }

    private func hideCanvas() {
        guard let canvas else { return }
        canvas.resignFirstResponder()
        canvas.isHidden = true
    }

    /// The palette changed the pen: the canvas takes it.
    func applyInk() {
        guard let canvas, let editor else { return }
        canvas.tool = editor.inkTool
    }

    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        guard UIPencilInteraction.preferredTapAction != .ignore else { return }
        editor?.togglePencilEraser()
        applyInk()
    }

    /// Keeps the editor's copy of the page's strokes, in user space, so
    /// they survive the page scrolling away and commit later.
    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard let editor, let pdfView else { return }
        editor.inkDrawings[pageIndex] = canvasView.drawing
        editor.inkPaths[pageIndex] = canvasView.drawing.strokes.map { stroke in
            let path = UIBezierPath()
            let count = stroke.path.count
            let step = max(count / 400, 1)
            var points: [CGPoint] = []
            for i in stride(from: 0, to: count, by: step) {
                points.append(pdfView.convert(canvasView.convert(stroke.path[i].location, to: pdfView), to: page))
            }
            if count > 1, (count - 1) % step != 0, let last = stroke.path.last {
                points.append(pdfView.convert(canvasView.convert(last.location, to: pdfView), to: page))
            }
            if let first = points.first {
                path.move(to: first)
                for point in points.dropFirst() {
                    path.addLine(to: point)
                }
                if points.count == 1 {
                    path.addLine(to: CGPoint(x: first.x + 0.5, y: first.y))
                }
            }
            let width = stroke.ink.inkType == .marker ? 8 : max(stroke.path.first?.size.width ?? 3, 1)
            return InkPath(path: path, color: stroke.ink.color, width: width)
        }
    }

    // MARK: - Gestures

    private func userPoint(_ point: CGPoint) -> CGPoint {
        guard let pdfView else { return point }
        return pdfView.convert(convert(point, to: pdfView), to: page)
    }

    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        guard let tool, let editor else { return }
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            dragStart = point
            preview.strokeColor = editor.color.uiColor.cgColor
        case .changed:
            if tool.isTextMarkup {
                showSelection(from: dragStart, to: point)
            } else if tool.takesBox {
                showBox(from: dragStart, to: point, tool: tool)
            }
        case .ended:
            preview.path = nil
            if tool.isTextMarkup {
                let selection = textSelection(from: dragStart, to: point)
                pdfView?.clearSelection()
                if let selection {
                    editor.markup(selection, as: tool)
                }
            } else if tool == .arrow {
                editor.addArrow(from: userPoint(dragStart), to: userPoint(point), on: pageIndex)
            } else if tool.takesBox {
                let a = userPoint(dragStart)
                let b = userPoint(point)
                let rect = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
                if tool == .freeText {
                    editor.pending = PendingPlacement(tool: .freeText, pageIndex: pageIndex, rect: rect)
                } else {
                    editor.addShape(tool, in: rect, on: pageIndex)
                }
            }
        case .cancelled, .failed:
            preview.path = nil
            pdfView?.clearSelection()
        default:
            break
        }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let tool, let editor else { return }
        let point = userPoint(gesture.location(in: self))
        switch tool {
        case .note:
            editor.pending = PendingPlacement(tool: .note, pageIndex: pageIndex, rect: CGRect(origin: point, size: .zero))
        case .freeText:
            let rect = CGRect(x: point.x, y: point.y - editor.textSize * 1.6, width: 160, height: editor.textSize * 1.6)
            editor.pending = PendingPlacement(tool: .freeText, pageIndex: pageIndex, rect: rect)
        case .highlight, .underline, .strikeout:
            // A tap marks the word under it.
            if let word = page.selectionForWord(at: point), word.string?.isEmpty == false {
                editor.markup(word, as: tool)
            }
        default:
            break
        }
    }

    private func showSelection(from start: CGPoint, to end: CGPoint) {
        guard let selection = textSelection(from: start, to: end) else { return }
        pdfView?.setCurrentSelection(selection, animate: false)
    }

    /// The words a drag covers: from the first point to the last as a
    /// reading selection when both land on text, else whatever sits in the
    /// band the finger crossed (a swipe begun on blank paper, or across
    /// the gap between two lines).
    private func textSelection(from start: CGPoint, to end: CGPoint) -> PDFSelection? {
        let a = userPoint(start)
        let b = userPoint(end)
        if let selection = page.selection(from: a, to: b), selection.string?.isEmpty == false {
            return selection
        }
        let band = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
            .insetBy(dx: 0, dy: -8)
        if let selection = page.selection(for: band), selection.string?.isEmpty == false {
            return selection
        }
        return nil
    }

    private func showBox(from start: CGPoint, to end: CGPoint, tool: AnnotationTool) {
        let rect = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
        let path: UIBezierPath
        switch tool {
        case .ellipse:
            path = UIBezierPath(ovalIn: rect)
        case .arrow:
            path = UIBezierPath()
            path.move(to: start)
            path.addLine(to: end)
            let angle = atan2(end.y - start.y, end.x - start.x)
            let head: CGFloat = 12
            for turn in [CGFloat.pi * 0.8, -CGFloat.pi * 0.8] {
                path.move(to: end)
                path.addLine(to: CGPoint(x: end.x + head * cos(angle + turn), y: end.y + head * sin(angle + turn)))
            }
        default:
            path = UIBezierPath(rect: rect)
        }
        preview.path = path.cgPath
    }

    // A one-finger drag is the tool's; two fingers still scroll and pinch.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        false
    }
}

/// A Pencil stroke in user space, waiting to be an ink annotation.
struct InkPath {
    let path: UIBezierPath
    let color: UIColor
    let width: CGFloat
}
