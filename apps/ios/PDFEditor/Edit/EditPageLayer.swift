import PDFKit
import UIKit

/// Edit PDF over one page: the boxes of what can be edited, the handles of
/// what is picked, and the field the text is typed in — inside the view
/// PDFKit lays over the page, so everything moves, scrolls and zooms with
/// the paper under it.
///
/// It draws from `EditModel`'s lists and writes back through it; it holds no
/// state of the document itself. Gestures track the finger 1:1 and commit on
/// release, like the markup tools: a drag shows where the picture or the
/// link will land, and only the release calls the core.
@MainActor
final class EditPageLayer: UIView, UITextViewDelegate {
    let page: PDFPage
    let pageIndex: Int
    weak var pdfView: PDFView?
    weak var edit: EditModel?

    /// The page's crop box and rotation: the three spaces meet here.
    private var frameOfPage: PageSpace.Frame
    private let shapes = CAShapeLayer()
    private let picked = CAShapeLayer()
    private let preview = CAShapeLayer()
    private var handleViews: [UIView] = []
    private var field: UITextView?
    private var fieldBox = CGRect.zero
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
    private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    /// What the current drag is doing, worked out when it began.
    private enum Drag {
        case none
        case movePicture(PagePicture, EditGeometry.Matrix)
        case resizePicture(PagePicture, EditGeometry.Matrix, CGPoint)
        case cropPicture(PagePicture, EditGeometry.Clip, CGPoint)
        case moveLink(PageLink, CGRect)
        case resizeLink(PageLink, CGRect, CGPoint)
        case drawLink(CGPoint)
        case placePicture(CGPoint)
    }

    private var drag = Drag.none
    /// The touch's start, in this view's own coordinates.
    private var dragStart = CGPoint.zero

    init(page: PDFPage, pageIndex: Int, pdfView: PDFView, edit: EditModel?) {
        self.page = page
        self.pageIndex = pageIndex
        self.pdfView = pdfView
        self.edit = edit
        self.frameOfPage = PageSpace.Frame(page: page)
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        for layer in [shapes, picked, preview] {
            layer.fillColor = nil
            layer.lineJoin = .round
            self.layer.addSublayer(layer)
        }
        shapes.strokeColor = UIColor.tintColor.withAlphaComponent(0.55).cgColor
        shapes.lineWidth = 1
        shapes.lineDashPattern = [4, 3]
        picked.strokeColor = UIColor.tintColor.cgColor
        picked.lineWidth = 2
        preview.strokeColor = UIColor.tintColor.cgColor
        preview.lineWidth = 2
        preview.lineDashPattern = [6, 4]
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)
        addGestureRecognizer(tap)
        accessibilityIdentifier = "edit.layer.\(pageIndex)"
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        for layer in [shapes, picked, preview] {
            layer.frame = bounds
        }
        redraw()
    }

    // MARK: - What the layer shows

    /// Draws the page again from the model's lists, and puts the text field
    /// where the paragraph or the tapped point is.
    func redraw() {
        guard let edit else { return }
        frameOfPage = PageSpace.Frame(page: page)
        let path = CGMutablePath()
        let pickedPath = CGMutablePath()
        var pickedBox: CGRect?
        switch edit.mode {
        case .text:
            for paragraph in edit.paragraphs(onPage: pageIndex) ?? [] {
                let box = viewRect(fromStored: paragraph.storedRect)
                guard box.width > 2, box.height > 2 else { continue }
                path.addRoundedRect(in: box, cornerWidth: 3, cornerHeight: 3)
            }
        case .pictures:
            for picture in edit.pictures(onPage: pageIndex) ?? [] {
                let box = viewBox(of: picture)
                guard box.width > 2, box.height > 2 else { continue }
                if picture.id == edit.selectedPicture?.id(onPage: pageIndex) {
                    pickedPath.addRect(box)
                    pickedBox = box
                } else if picture.isEditable {
                    path.addRect(box)
                }
            }
        case .links:
            for link in edit.links(onPage: pageIndex) ?? [] {
                let box = viewRect(fromShown: link.shownRect)
                guard box.width > 2, box.height > 2 else { continue }
                if link.id == edit.selectedLink?.id(onPage: pageIndex) {
                    pickedPath.addRect(box)
                    pickedBox = box
                } else {
                    path.addRoundedRect(in: box, cornerWidth: 3, cornerHeight: 3)
                }
            }
        }
        shapes.path = path
        picked.path = pickedPath
        showHandles(around: pickedBox, cropping: edit.mode == .pictures && edit.cropping)
        showField()
    }

    /// The eight handles of the picked thing, as small round views so they
    /// are targets a finger can hit, not just something drawn.
    private func showHandles(around box: CGRect?, cropping: Bool) {
        for view in handleViews { view.removeFromSuperview() }
        handleViews = []
        guard let box else { return }
        for (place, handle) in EditGeometry.handles.enumerated() {
            let view = UIView(frame: CGRect(x: 0, y: 0, width: 16, height: 16))
            view.center = CGPoint(x: box.minX + box.width * handle.x, y: box.minY + box.height * handle.y)
            view.layer.cornerRadius = cropping ? 2 : 8
            view.backgroundColor = cropping ? .tintColor : .systemBackground
            view.layer.borderColor = UIColor.tintColor.cgColor
            view.layer.borderWidth = 2
            view.isUserInteractionEnabled = false
            view.accessibilityIdentifier = "edit.handle.\(pageIndex).\(place)"
            addSubview(view)
            handleViews.append(view)
        }
    }

    /// The field the text is typed in: over the paragraph being edited, or
    /// one line high at the point that was tapped. It carries the
    /// paragraph's own direction and alignment, because the text should sit
    /// where the text on the page sits.
    private func showField() {
        guard let edit else { return }
        let wanted: (box: CGRect, paragraph: Paragraph?)?
        if let editing = edit.editing, editing.page == pageIndex {
            wanted = (viewRect(fromStored: editing.paragraph.storedRect), editing.paragraph)
        } else if let placing = edit.placing, placing.page == pageIndex {
            let scale = viewScale
            let height = CGFloat(edit.size) * 1.6 * scale
            let width = min(bounds.width * 0.7, 260 * scale)
            let at = viewPoint(fromStored: placing.point)
            // The line grows away from the point that was tapped, as the core
            // draws it: leftwards for Arabic, rightwards for Latin.
            let leftwards = edit.draftIsRightToLeft
            wanted = (CGRect(x: leftwards ? at.x - width : at.x, y: at.y, width: width, height: height), nil)
        } else {
            wanted = nil
        }
        guard let wanted else {
            if let field {
                field.resignFirstResponder()
                field.removeFromSuperview()
                self.field = nil
            }
            return
        }
        let view = field ?? makeField()
        let rightToLeft = wanted.paragraph?.isRightToLeft ?? edit.draftIsRightToLeft
        view.frame = wanted.box
        fieldBox = wanted.box
        view.font = .systemFont(ofSize: max(9, CGFloat(wanted.paragraph?.fontSize ?? edit.size) * viewScale))
        view.textAlignment = alignment(of: wanted.paragraph, rightToLeft: rightToLeft)
        view.semanticContentAttribute = rightToLeft ? .forceRightToLeft : .forceLeftToRight
        if view.text != edit.draft {
            view.text = edit.draft
        }
        if field == nil {
            field = view
            addSubview(view)
            view.becomeFirstResponder()
        }
    }

    private func makeField() -> UITextView {
        let view = UITextView()
        view.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.96)
        view.layer.borderColor = UIColor.tintColor.cgColor
        view.layer.borderWidth = 2
        view.layer.cornerRadius = 4
        view.textContainerInset = UIEdgeInsets(top: 2, left: 2, bottom: 2, right: 2)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = true
        view.autocorrectionType = .no
        view.spellCheckingType = .no
        view.delegate = self
        view.accessibilityIdentifier = "edit.field"
        return view
    }

    private func alignment(of paragraph: Paragraph?, rightToLeft: Bool) -> NSTextAlignment {
        switch paragraph?.alignment {
        case "center": return .center
        case "justify": return .justified
        case "end": return rightToLeft ? .left : .right
        default: return rightToLeft ? .right : .left
        }
    }

    func textViewDidChange(_ textView: UITextView) {
        edit?.draft = textView.text
    }

    // MARK: - The spaces

    /// How many of this view's points one point of the page as stored is.
    private var viewScale: CGFloat {
        let size = frameOfPage.shownSize
        guard size.width > 0 else { return 1 }
        // The overlay covers the page, so its width is the page's width as
        // shown; the rotation is already in `shownSize`.
        return bounds.width / size.width
    }

    /// A box the core answered in the page's stored space, in this view's own.
    private func viewRect(fromStored rect: CGRect) -> CGRect {
        viewRect(fromUser: PageSpace.userRect(fromStored: rect, in: frameOfPage))
    }

    private func viewRect(fromShown rect: CGRect) -> CGRect {
        viewRect(fromUser: PageSpace.userRect(fromShown: rect, in: frameOfPage))
    }

    private func viewRect(fromUser rect: CGRect) -> CGRect {
        guard let pdfView else { return rect }
        return convert(pdfView.convert(rect, from: page), from: pdfView)
    }

    private func viewPoint(fromStored point: CGPoint) -> CGPoint {
        viewRect(fromStored: CGRect(origin: point, size: .zero)).origin
    }

    /// A touch in this view, in the page's stored space (points from the
    /// top-left corner of the crop box, y down, before `/Rotate`) — where
    /// the core's paragraphs and the text it draws live.
    private func storedPoint(_ point: CGPoint) -> CGPoint {
        guard let pdfView else { return point }
        let user = pdfView.convert(convert(point, to: pdfView), to: page)
        let c = frameOfPage.crop
        return CGPoint(x: user.x - c.minX, y: c.maxY - user.y)
    }

    /// A touch in this view, on the page as shown — where pictures and links
    /// are measured.
    private func shownPoint(_ point: CGPoint) -> CGPoint {
        guard let pdfView else { return point }
        return PageSpace.shownPoint(fromUser: pdfView.convert(convert(point, to: pdfView), to: page), in: frameOfPage)
    }

    /// The box a picture's visible part covers, in this view's own space.
    private func viewBox(of picture: PagePicture) -> CGRect {
        viewRect(fromShown: EditGeometry.bounds(EditGeometry.corners(picture.matrix, clip: picture.clip)))
    }

    // MARK: - Gestures

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let edit, !edit.working else { return }
        let point = gesture.location(in: self)
        switch edit.mode {
        case .text:
            // A field already open commits with the bar's Apply, not with a
            // tap: a tap that closed it would lose what was typed if it
            // landed by accident.
            guard edit.editing == nil, edit.placing == nil else { return }
            if edit.placingArmed {
                edit.beginLine(at: storedPoint(point), onPage: pageIndex)
            } else if let paragraph = edit.paragraph(at: storedPoint(point), onPage: pageIndex) {
                edit.begin(editing: paragraph, onPage: pageIndex)
            }
        case .pictures:
            let at = shownPoint(point)
            let found = (edit.pictures(onPage: pageIndex) ?? [])
                .filter { $0.isEditable && EditGeometry.bounds(EditGeometry.corners($0.matrix, clip: $0.clip)).contains(at) }
                .min { EditGeometry.bounds(EditGeometry.corners($0.matrix, clip: $0.clip)).area < EditGeometry.bounds(EditGeometry.corners($1.matrix, clip: $1.clip)).area }
            edit.selectedPicture = found.map { PictureRef(page: pageIndex, id: $0.id) }
            edit.cropping = false
        case .links:
            let at = shownPoint(point)
            let found = (edit.links(onPage: pageIndex) ?? []).first { $0.shownRect.contains(at) }
            edit.selectedLink = found.map { LinkRef(page: pageIndex, id: $0.id) }
        }
        redraw()
    }

    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        guard let edit, !edit.working else { return }
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            dragStart = point
            drag = began(at: point, edit: edit)
        case .changed:
            show(drag: drag, at: point, edit: edit)
        case .ended:
            preview.path = nil
            finish(drag: drag, at: point, edit: edit)
            drag = .none
        case .cancelled, .failed:
            preview.path = nil
            drag = .none
        default:
            break
        }
    }

    /// What a drag that began at `point` is about to do.
    private func began(at point: CGPoint, edit: EditModel) -> Drag {
        switch edit.mode {
        case .text:
            return .none
        case .pictures:
            if let pending = edit.pendingPicture, pending.page == nil || pending.page == pageIndex {
                return .placePicture(point)
            }
            guard let picture = selected(of: edit) else { return .none }
            let box = viewBox(of: picture)
            if let handle = EditGeometry.handle(at: point, of: box, tolerance: 22) {
                return edit.cropping
                    ? .cropPicture(picture, picture.clip, handle)
                    : .resizePicture(picture, picture.matrix, handle)
            }
            return box.contains(point) ? .movePicture(picture, picture.matrix) : .none
        case .links:
            if let link = selectedLink(of: edit) {
                let box = viewRect(fromShown: link.shownRect)
                if let handle = EditGeometry.handle(at: point, of: box, tolerance: 22) {
                    return .resizeLink(link, link.shownRect, handle)
                }
                if box.contains(point) {
                    return .moveLink(link, link.shownRect)
                }
            }
            return .drawLink(point)
        }
    }

    /// The dashed outline of where the drag has got to, drawn without
    /// calling the core.
    private func show(drag: Drag, at point: CGPoint, edit: EditModel) {
        switch drag {
        case .none:
            preview.path = nil
        case let .movePicture(picture, matrix):
            let moved = EditGeometry.translate(matrix, dx: shownPoint(point).x - shownPoint(dragStart).x,
                                               dy: shownPoint(point).y - shownPoint(dragStart).y)
            preview.path = CGPath(rect: viewRect(fromShown: EditGeometry.bounds(EditGeometry.corners(moved, clip: picture.clip))), transform: nil)
        case let .resizePicture(picture, matrix, handle):
            let sized = EditGeometry.resize(matrix, clip: picture.clip, handle: handle, pointer: shownPoint(point), keepAspect: false)
            preview.path = CGPath(rect: viewRect(fromShown: EditGeometry.bounds(EditGeometry.corners(sized, clip: picture.clip))), transform: nil)
        case let .cropPicture(picture, clip, handle):
            let cropped = EditGeometry.crop(picture.matrix, clip: clip, handle: handle, pointer: shownPoint(point))
            preview.path = CGPath(rect: viewRect(fromShown: EditGeometry.bounds(EditGeometry.corners(picture.matrix, clip: cropped))), transform: nil)
        case let .moveLink(_, rect):
            let moved = EditGeometry.drag(rect, handle: nil, dx: shownPoint(point).x - shownPoint(dragStart).x,
                                          dy: shownPoint(point).y - shownPoint(dragStart).y)
            preview.path = CGPath(rect: viewRect(fromShown: moved), transform: nil)
        case let .resizeLink(_, rect, handle):
            let sized = EditGeometry.drag(rect, handle: handle, dx: shownPoint(point).x - shownPoint(dragStart).x,
                                          dy: shownPoint(point).y - shownPoint(dragStart).y)
            preview.path = CGPath(rect: viewRect(fromShown: sized), transform: nil)
        case let .drawLink(start), let .placePicture(start):
            preview.path = CGPath(rect: EditGeometry.between(start, point), transform: nil)
        }
    }

    /// The release: one call to the core, or nothing when the drag was too
    /// small to have been meant.
    private func finish(drag: Drag, at point: CGPoint, edit: EditModel) {
        let dx = shownPoint(point).x - shownPoint(dragStart).x
        let dy = shownPoint(point).y - shownPoint(dragStart).y
        let tiny = abs(point.x - dragStart.x) < 4 && abs(point.y - dragStart.y) < 4
        switch drag {
        case .none:
            break
        case let .movePicture(picture, matrix):
            guard !tiny else { break }
            let moved = EditGeometry.translate(matrix, dx: dx, dy: dy)
            Task { await edit.transform(picture, onPage: pageIndex, matrix: moved) }
        case let .resizePicture(picture, matrix, handle):
            guard !tiny else { break }
            let sized = EditGeometry.resize(matrix, clip: picture.clip, handle: handle, pointer: shownPoint(point), keepAspect: false)
            Task { await edit.transform(picture, onPage: pageIndex, matrix: sized) }
        case let .cropPicture(picture, clip, handle):
            guard !tiny else { break }
            let cropped = EditGeometry.crop(picture.matrix, clip: clip, handle: handle, pointer: shownPoint(point))
            Task { await edit.transform(picture, onPage: pageIndex, matrix: picture.matrix, clip: cropped) }
        case let .moveLink(link, rect):
            guard !tiny else { break }
            Task { await edit.update(link, onPage: pageIndex, rect: EditGeometry.drag(rect, handle: nil, dx: dx, dy: dy)) }
        case let .resizeLink(link, rect, handle):
            guard !tiny else { break }
            Task { await edit.update(link, onPage: pageIndex, rect: EditGeometry.drag(rect, handle: handle, dx: dx, dy: dy)) }
        case .drawLink:
            let box = EditGeometry.between(shownPoint(dragStart), shownPoint(point))
            guard box.width >= 8, box.height >= 8 else { break }
            edit.draftLink = DraftLink(page: pageIndex, rect: box)
        case .placePicture:
            guard let pending = edit.pendingPicture else { break }
            let box = EditGeometry.between(shownPoint(dragStart), shownPoint(point))
            guard box.width >= 8, box.height >= 8 else { break }
            Task { await edit.placePending(in: EditGeometry.fit(box, aspect: pending.aspect), onPage: pageIndex) }
        }
    }

    private func selected(of edit: EditModel) -> PagePicture? {
        guard let reference = edit.selectedPicture, reference.page == pageIndex else { return nil }
        return (edit.pictures(onPage: pageIndex) ?? []).first { $0.id == reference.id }
    }

    private func selectedLink(of edit: EditModel) -> PageLink? {
        guard let reference = edit.selectedLink, reference.page == pageIndex else { return nil }
        return (edit.links(onPage: pageIndex) ?? []).first { $0.id == reference.id }
    }
}

/// Which picture is picked: the page and the id the core gave it. The id
/// alone would not do — the same id can name a picture on another page.
struct PictureRef: Equatable, Sendable {
    let page: Int
    let id: String

    func id(onPage index: Int) -> String? { page == index ? id : nil }
}

/// Which link is picked.
struct LinkRef: Equatable, Sendable {
    let page: Int
    let id: String

    func id(onPage index: Int) -> String? { page == index ? id : nil }
}

/// A link area drawn on a page and not yet given anywhere to go.
struct DraftLink: Equatable, Identifiable, Sendable {
    let page: Int
    let rect: CGRect

    var id: String { "\(page)-\(rect.minX)-\(rect.minY)" }
}

/// A picture chosen and waiting for where it goes on the page: the bytes as
/// the core will take them (PNG or JPEG, nothing else), and the proportions
/// it is drawn with, so the box it is dragged out in keeps them.
struct PendingPicture: Equatable, Sendable {
    let bytes: Data
    let aspect: CGFloat
    /// The page it is meant for, when it was chosen on one.
    var page: Int?

    /// PNG and JPEG go through as they are — a photo's own JPEG is kept byte
    /// for byte by the core. Anything else (HEIC from the camera, a TIFF) is
    /// drawn once into a PNG, upright by its own orientation.
    static func of(_ bytes: Data, page: Int?) -> PendingPicture? {
        guard let image = UIImage(data: bytes), image.size.height > 0 else { return nil }
        let aspect = image.size.width / image.size.height
        if Self.isPNGOrJPEG(bytes) {
            return PendingPicture(bytes: bytes, aspect: aspect, page: page)
        }
        guard let png = upright(image).pngData() else { return nil }
        return PendingPicture(bytes: png, aspect: aspect, page: page)
    }

    /// PNG or JPEG by content, as the core decides it.
    static func isPNGOrJPEG(_ bytes: Data) -> Bool {
        let head = [UInt8](bytes.prefix(4))
        guard head.count == 4 else { return false }
        if head[0] == 0x89, head[1] == 0x50, head[2] == 0x4E, head[3] == 0x47 { return true }
        return head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF
    }

    /// The picture with its orientation drawn in, so the PNG needs none.
    private static func upright(_ image: UIImage) -> UIImage {
        guard image.imageOrientation != .up else { return image }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }
}
