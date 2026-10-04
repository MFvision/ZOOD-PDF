import PDFKit
import UIKit

/// Prepare form over one page: the fields already in the file (outlined
/// grey, named), the drafts (outlined in the accent, named, the picked one
/// with its eight handles), and the gestures — a drag draws a draft of the
/// kind in hand, a tap picks one, a drag moves the picked one or, from a
/// handle, resizes it. Inside the view PDFKit lays over the page, so it all
/// scrolls and zooms with the paper; it draws from `FormModel` and writes
/// back through it.
@MainActor
final class FormPageLayer: UIView, UIGestureRecognizerDelegate {
    let page: PDFPage
    let pageIndex: Int
    weak var pdfView: PDFView?
    weak var form: FormModel?

    private var frameOfPage: PageSpace.Frame
    private let existing = CAShapeLayer()
    private let shapes = CAShapeLayer()
    private let picked = CAShapeLayer()
    private let preview = CAShapeLayer()
    private var labels: [UILabel] = []
    private var handleViews: [UIView] = []
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
    private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))

    private enum Drag {
        case none
        case draw(CGPoint)
        case move(UUID, CGRect)
        case resize(UUID, CGRect, CGPoint)
    }

    private var drag = Drag.none
    private var dragStart = CGPoint.zero

    init(page: PDFPage, pageIndex: Int, pdfView: PDFView, form: FormModel) {
        self.page = page
        self.pageIndex = pageIndex
        self.pdfView = pdfView
        self.form = form
        self.frameOfPage = PageSpace.Frame(page: page)
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        for layer in [existing, shapes, picked, preview] {
            layer.lineJoin = .round
            self.layer.addSublayer(layer)
        }
        existing.fillColor = UIColor.systemGray.withAlphaComponent(0.08).cgColor
        existing.strokeColor = UIColor.systemGray.cgColor
        existing.lineWidth = 1
        shapes.fillColor = UIColor.tintColor.withAlphaComponent(0.1).cgColor
        shapes.strokeColor = UIColor.tintColor.withAlphaComponent(0.8).cgColor
        shapes.lineWidth = 1.5
        shapes.lineDashPattern = [4, 3]
        picked.fillColor = UIColor.tintColor.withAlphaComponent(0.18).cgColor
        picked.strokeColor = UIColor.tintColor.cgColor
        picked.lineWidth = 2
        preview.fillColor = nil
        preview.strokeColor = UIColor.tintColor.cgColor
        preview.lineWidth = 2
        preview.lineDashPattern = [6, 4]
        pan.maximumNumberOfTouches = 1
        pan.delegate = self
        tap.delegate = self
        addGestureRecognizer(pan)
        addGestureRecognizer(tap)
        accessibilityIdentifier = "form.layer.\(pageIndex)"
        isAccessibilityElement = true
        accessibilityTraits = .allowsDirectInteraction
        accessibilityLabel = String(localized: "Page \(pageIndex + 1)")
        (pdfView as? DocumentPDFView)?.register(toolLayer: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        for layer in [existing, shapes, picked, preview] {
            layer.frame = bounds
        }
        redraw()
    }

    // MARK: - What the layer shows

    func redraw() {
        guard let form else { return }
        frameOfPage = PageSpace.Frame(page: page)
        labels.forEach { $0.removeFromSuperview() }
        labels = []
        let old = CGMutablePath()
        for (field, rect) in form.fields(onPage: pageIndex) {
            let box = viewRect(fromShown: rect)
            old.addRect(box)
            addLabel(field.name, in: box, color: .systemGray)
        }
        existing.path = old
        let path = CGMutablePath()
        let pickedPath = CGMutablePath()
        var pickedBox: CGRect?
        for draft in form.drafts(onPage: pageIndex) {
            let box = viewRect(fromShown: draft.rect)
            if draft.id == form.selected {
                pickedPath.addRect(box)
                pickedBox = box
            } else {
                path.addRect(box)
            }
            let name = draft.kind == .radio ? "\(draft.name) · \(draft.label)" : draft.name
            addLabel(name, in: box, color: .tintColor)
        }
        shapes.path = path
        picked.path = pickedPath
        showHandles(around: pickedBox)
        accessibilityValue = String(localized: "New fields: \(form.drafts(onPage: pageIndex).count)")
    }

    /// The field's name above its box, in its own direction.
    private func addLabel(_ text: String, in box: CGRect, color: UIColor) {
        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: 10, weight: .semibold)
        label.textColor = color
        label.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.8)
        label.sizeToFit()
        let rtl = text.unicodeScalars.contains { EditModel.isRightToLeftScalar($0) }
        let width = min(label.bounds.width + 4, max(box.width, 40))
        label.frame = CGRect(x: rtl ? box.maxX - width : box.minX, y: box.minY - 13, width: width, height: 12)
        label.textAlignment = rtl ? .right : .left
        label.isAccessibilityElement = false
        addSubview(label)
        labels.append(label)
    }

    private func showHandles(around box: CGRect?) {
        handleViews.forEach { $0.removeFromSuperview() }
        handleViews = []
        guard let box else { return }
        for (place, handle) in EditGeometry.handles.enumerated() {
            let view = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 14))
            view.center = CGPoint(x: box.minX + box.width * handle.x, y: box.minY + box.height * handle.y)
            view.layer.cornerRadius = 7
            view.backgroundColor = .systemBackground
            view.layer.borderColor = UIColor.tintColor.cgColor
            view.layer.borderWidth = 2
            view.isUserInteractionEnabled = false
            view.accessibilityIdentifier = "form.handle.\(pageIndex).\(place)"
            addSubview(view)
            handleViews.append(view)
        }
    }

    // MARK: - The spaces

    private func viewRect(fromShown rect: CGRect) -> CGRect {
        guard let pdfView else { return rect }
        let user = PageSpace.userRect(fromShown: rect, in: frameOfPage)
        return convert(pdfView.convert(user, from: page), from: pdfView)
    }

    private func shownPoint(_ point: CGPoint) -> CGPoint {
        guard let pdfView else { return point }
        return PageSpace.shownPoint(fromUser: pdfView.convert(convert(point, to: pdfView), to: page), in: frameOfPage)
    }

    // MARK: - Gestures

    private func draft(at point: CGPoint) -> FormModel.Draft? {
        guard let form else { return nil }
        return form.drafts(onPage: pageIndex)
            .filter { viewRect(fromShown: $0.rect).insetBy(dx: -6, dy: -6).contains(point) }
            .min { $0.rect.area < $1.rect.area }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let form, !form.working else { return }
        form.selected = draft(at: gesture.location(in: self))?.id
        redraw()
    }

    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        guard let form, !form.working else { return }
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            dragStart = point
            drag = began(at: point, form: form)
        case .changed:
            preview.path = previewPath(at: point, form: form)
        case .ended:
            preview.path = nil
            finish(at: point, form: form)
            drag = .none
        case .cancelled, .failed:
            preview.path = nil
            drag = .none
        default:
            break
        }
    }

    private func began(at point: CGPoint, form: FormModel) -> Drag {
        if let picked = form.picked, picked.page == pageIndex {
            let box = viewRect(fromShown: picked.rect)
            if let handle = EditGeometry.handle(at: point, of: box, tolerance: 22) {
                return .resize(picked.id, picked.rect, handle)
            }
            if box.insetBy(dx: -6, dy: -6).contains(point) {
                return .move(picked.id, picked.rect)
            }
        }
        if form.placing != nil {
            return .draw(point)
        }
        if let under = draft(at: point) {
            form.selected = under.id
            return .move(under.id, under.rect)
        }
        return .none
    }

    private func moved(_ rect: CGRect, handle: CGPoint?, to point: CGPoint) -> CGRect {
        let a = shownPoint(dragStart)
        let b = shownPoint(point)
        return EditGeometry.drag(rect, handle: handle, dx: b.x - a.x, dy: b.y - a.y)
    }

    private func drawn(to point: CGPoint, kind: FormModel.Kind) -> CGRect {
        var box = EditGeometry.between(shownPoint(dragStart), shownPoint(point))
        if kind.isSquare {
            let side = max(box.width, box.height)
            box.size = CGSize(width: side, height: side)
        }
        return box
    }

    private func previewPath(at point: CGPoint, form: FormModel) -> CGPath? {
        switch drag {
        case .none: return nil
        case .draw: return CGPath(rect: viewRect(fromShown: drawn(to: point, kind: form.placing ?? .text)), transform: nil)
        case let .move(_, rect): return CGPath(rect: viewRect(fromShown: moved(rect, handle: nil, to: point)), transform: nil)
        case let .resize(_, rect, handle): return CGPath(rect: viewRect(fromShown: moved(rect, handle: handle, to: point)), transform: nil)
        }
    }

    private func finish(at point: CGPoint, form: FormModel) {
        let tiny = abs(point.x - dragStart.x) < 4 && abs(point.y - dragStart.y) < 4
        switch drag {
        case .none:
            break
        case .draw:
            guard let kind = form.placing else { break }
            let box = drawn(to: point, kind: kind)
            guard box.width >= 6, box.height >= 6 else { break }
            form.add(kind: kind, rect: box, onPage: pageIndex)
        case let .move(id, rect):
            guard !tiny else { break }
            form.move(id, to: moved(rect, handle: nil, to: point))
        case let .resize(id, rect, handle):
            guard !tiny else { break }
            let sized = moved(rect, handle: handle, to: point)
            guard sized.width >= 6, sized.height >= 6 else { break }
            form.move(id, to: sized)
        }
        redraw()
    }

    /// A drag is the layer's only where it would do something: with a kind
    /// in hand, or on a draft. Everywhere else the pages scroll under it.
    override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard let form, !form.working else { return false }
        if gesture === tap { return true }
        guard gesture === pan else { return true }
        if case .none = began(at: gesture.location(in: self), form: form) { return false }
        return true
    }

    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        gesture === tap && other.view !== self
    }
}
