import PDFKit
import UIKit

/// Redact over one page: the marks laid on it, and the gestures that lay
/// them — inside the view PDFKit lays over the page, so they scroll and
/// zoom with the paper.
///
/// In *Mark text* a tap marks the word under the finger and a drag the text
/// it crosses, each line its own box round its glyphs (PDFKit's selection
/// gives the geometry; the core then reads the text under the boxes, so the
/// list names it in logical order). In *Mark an area* a drag marks the box
/// it draws. In either, a tap on a mark picks it. Like the editor's layer it
/// holds no state of its own: it draws from `RedactModel` and writes back
/// through it.
@MainActor
final class RedactPageLayer: UIView, UIGestureRecognizerDelegate {
    let page: PDFPage
    let pageIndex: Int
    weak var pdfView: PDFView?
    weak var redact: RedactModel?

    private var frameOfPage: PageSpace.Frame
    private let fills = CAShapeLayer()
    private let picked = CAShapeLayer()
    private let preview = CAShapeLayer()
    private let hovered = CAShapeLayer()
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
    private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    private var dragStart = CGPoint.zero

    init(page: PDFPage, pageIndex: Int, pdfView: PDFView, redact: RedactModel) {
        self.page = page
        self.pageIndex = pageIndex
        self.pdfView = pdfView
        self.redact = redact
        self.frameOfPage = PageSpace.Frame(page: page)
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        for layer in [fills, picked, preview, hovered] {
            layer.lineJoin = .round
            self.layer.addSublayer(layer)
        }
        // The marks red while they wait, as the desktop draws them; the
        // picked one heavier; the drag dashed.
        fills.fillColor = UIColor.systemRed.withAlphaComponent(0.22).cgColor
        fills.strokeColor = UIColor.systemRed.cgColor
        fills.lineWidth = 1.5
        picked.fillColor = UIColor.systemRed.withAlphaComponent(0.35).cgColor
        picked.strokeColor = UIColor.systemRed.cgColor
        picked.lineWidth = 3
        preview.fillColor = UIColor.systemRed.withAlphaComponent(0.12).cgColor
        preview.strokeColor = UIColor.systemRed.cgColor
        preview.lineWidth = 1.5
        preview.lineDashPattern = [5, 3]
        hovered.fillColor = nil
        hovered.strokeColor = UIColor.systemRed.withAlphaComponent(0.6).cgColor
        hovered.lineWidth = 1
        hovered.lineDashPattern = [3, 2]
        pan.maximumNumberOfTouches = 1
        pan.delegate = self
        tap.delegate = self
        addGestureRecognizer(pan)
        addGestureRecognizer(tap)
        addGestureRecognizer(UIHoverGestureRecognizer(target: self, action: #selector(hoverMoved(_:))))
        accessibilityIdentifier = "redact.layer.\(pageIndex)"
        // One element per page: VoiceOver's direct touch marks words on it
        // as a finger does, and a test finds the page where it is drawn.
        isAccessibilityElement = true
        accessibilityTraits = .allowsDirectInteraction
        accessibilityLabel = String(localized: "Page \(pageIndex + 1)")
        (pdfView as? DocumentPDFView)?.register(toolLayer: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        for layer in [fills, picked, preview, hovered] {
            layer.frame = bounds
        }
        redraw()
    }

    // MARK: - What the layer shows

    func redraw() {
        guard let redact else { return }
        frameOfPage = PageSpace.Frame(page: page)
        let path = CGMutablePath()
        let pickedPath = CGMutablePath()
        for mark in redact.marks(onPage: pageIndex) {
            for rect in mark.rects {
                let box = viewRect(fromStored: rect)
                if mark.id == redact.selected {
                    pickedPath.addRect(box)
                } else {
                    path.addRect(box)
                }
            }
        }
        fills.path = path
        picked.path = pickedPath
        let count = redact.marks(onPage: pageIndex).count
        accessibilityValue = String(localized: "Marks: \(count)")
    }

    // MARK: - The spaces

    private func viewRect(fromStored rect: CGRect) -> CGRect {
        guard let pdfView else { return rect }
        let user = PageSpace.userRect(fromStored: rect, in: frameOfPage)
        return convert(pdfView.convert(user, from: page), from: pdfView)
    }

    private func userPoint(_ point: CGPoint) -> CGPoint {
        guard let pdfView else { return point }
        return pdfView.convert(convert(point, to: pdfView), to: page)
    }

    private func storedRect(fromUser rect: CGRect) -> CGRect {
        PageSpace.storedRect(fromUser: rect, in: frameOfPage)
    }

    /// The boxes of the text between two points of this view, a box per
    /// line, in the page's stored space; empty when no text is there.
    private func textBoxes(from start: CGPoint, to end: CGPoint) -> [CGRect] {
        let a = userPoint(start)
        let b = userPoint(end)
        var selection = page.selection(from: a, to: b)
        if selection?.string?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            let band = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
            selection = page.selection(for: band)
        }
        return boxes(of: selection)
    }

    private func boxes(of selection: PDFSelection?) -> [CGRect] {
        guard let selection, selection.string?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { return [] }
        return selection.selectionsByLine()
            .map { $0.bounds(for: page) }
            .filter { $0.width > 0.5 && $0.height > 0.5 }
            .map(storedRect(fromUser:))
    }

    /// The mark under a point of this view, the smallest when they overlap.
    private func mark(at point: CGPoint) -> RedactModel.Mark? {
        guard let redact else { return nil }
        return redact.marks(onPage: pageIndex)
            .filter { $0.rects.contains { viewRect(fromStored: $0).insetBy(dx: -4, dy: -4).contains(point) } }
            .min { ($0.rects.first?.area ?? 0) < ($1.rects.first?.area ?? 0) }
    }

    // MARK: - Gestures

    @objc private func hoverMoved(_ gesture: UIHoverGestureRecognizer) {
        guard let redact, gesture.state == .began || gesture.state == .changed else {
            hovered.path = nil
            return
        }
        let point = gesture.location(in: self)
        // A pointer lights what a tap would mark: the word, or the mark.
        if let mark = mark(at: point) {
            let path = CGMutablePath()
            mark.rects.forEach { path.addRect(viewRect(fromStored: $0).insetBy(dx: -2, dy: -2)) }
            hovered.path = path
        } else if redact.mode == .text, let word = page.selectionForWord(at: userPoint(point)) {
            let path = CGMutablePath()
            boxes(of: word).forEach { path.addRect(viewRect(fromStored: $0)) }
            hovered.path = path
        } else {
            hovered.path = nil
        }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let redact, !redact.working else { return }
        let point = gesture.location(in: self)
        if let mark = mark(at: point) {
            redact.selected = redact.selected == mark.id ? nil : mark.id
            redraw()
            return
        }
        guard redact.mode == .text else {
            redact.selected = nil
            redraw()
            return
        }
        let rects = boxes(of: page.selectionForWord(at: userPoint(point)))
        guard !rects.isEmpty else { return }
        Task { await redact.mark(rects: rects, onPage: pageIndex, kind: .text) }
    }

    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        guard let redact, !redact.working else { return }
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            dragStart = point
        case .changed:
            let path = CGMutablePath()
            if redact.mode == .text {
                textBoxes(from: dragStart, to: point).forEach { path.addRect(viewRect(fromStored: $0)) }
            } else {
                path.addRect(EditGeometry.between(dragStart, point))
            }
            preview.path = path
        case .ended:
            preview.path = nil
            let rects: [CGRect]
            if redact.mode == .text {
                rects = textBoxes(from: dragStart, to: point)
            } else {
                let a = userPoint(dragStart)
                let b = userPoint(point)
                let user = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
                rects = user.width >= 2 && user.height >= 2 ? [storedRect(fromUser: user)] : []
            }
            guard !rects.isEmpty else { return }
            Task { await redact.mark(rects: rects, onPage: pageIndex, kind: redact.mode == .text ? .text : .area) }
        case .cancelled, .failed:
            preview.path = nil
        default:
            break
        }
    }

    /// A one-finger drag marks; two fingers still scroll and pinch.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        false
    }

    /// PDFKit's own taps wait for this layer's, or the page would take the
    /// first tap for its text selection.
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        gesture === tap && other.view !== self
    }
}
