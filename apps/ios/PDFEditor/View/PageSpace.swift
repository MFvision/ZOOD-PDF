import CoreGraphics
import PDFKit
import WarraqCore

/// The three coordinate spaces a page lives in, and the way between them.
///
/// - **User space** is the PDF's own: points, y up, the crop box wherever the
///   file put it, before `/Rotate`. PDFKit's annotations, selections and
///   `convert(_:to:)` speak it.
/// - **Stored space** is what the core's readers answer in (`view.search`,
///   `textLines`): points from the top-left corner of the crop box, y down,
///   before `/Rotate`.
/// - **Shown space** is the page as a person sees it: points from the top-left
///   corner after `/Rotate`, y down. The core's `images.add` takes a matrix
///   in it, and PDFKit's page overlays are laid out in it.
enum PageSpace {
    /// A page's crop box and rotation, all the conversions need.
    struct Frame: Equatable {
        let crop: CGRect
        /// 0, 90, 180 or 270, clockwise.
        let rotation: Int

        init(crop: CGRect, rotation: Int) {
            self.crop = crop
            self.rotation = ((rotation % 360) + 360) % 360
        }

        @MainActor
        init(page: PDFPage) {
            self.init(crop: page.bounds(for: .cropBox), rotation: page.rotation)
        }

        /// The page's size as shown.
        var shownSize: CGSize {
            rotation == 90 || rotation == 270
                ? CGSize(width: crop.height, height: crop.width)
                : crop.size
        }
    }

    /// A box the core answered (stored space) as PDFKit wants it (user space).
    static func userRect(fromStored r: CGRect, in frame: Frame) -> CGRect {
        CGRect(x: frame.crop.minX + r.minX,
               y: frame.crop.maxY - r.maxY,
               width: r.width,
               height: r.height)
    }

    /// A point as shown, to user space (the inverse of the core's `Frame::user`).
    static func userPoint(fromShown p: CGPoint, in frame: Frame) -> CGPoint {
        let c = frame.crop
        switch frame.rotation {
        case 90: return CGPoint(x: c.minX + p.y, y: c.minY + p.x)
        case 180: return CGPoint(x: c.maxX - p.x, y: c.minY + p.y)
        case 270: return CGPoint(x: c.maxX - p.y, y: c.maxY - p.x)
        default: return CGPoint(x: c.minX + p.x, y: c.maxY - p.y)
        }
    }

    /// A point in user space, as shown.
    static func shownPoint(fromUser u: CGPoint, in frame: Frame) -> CGPoint {
        let c = frame.crop
        switch frame.rotation {
        case 90: return CGPoint(x: u.y - c.minY, y: u.x - c.minX)
        case 180: return CGPoint(x: c.maxX - u.x, y: u.y - c.minY)
        case 270: return CGPoint(x: c.maxY - u.y, y: c.maxX - u.x)
        default: return CGPoint(x: u.x - c.minX, y: c.maxY - u.y)
        }
    }

    static func userRect(fromShown r: CGRect, in frame: Frame) -> CGRect {
        let a = userPoint(fromShown: CGPoint(x: r.minX, y: r.minY), in: frame)
        let b = userPoint(fromShown: CGPoint(x: r.maxX, y: r.maxY), in: frame)
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    static func shownRect(fromUser r: CGRect, in frame: Frame) -> CGRect {
        let a = shownPoint(fromUser: CGPoint(x: r.minX, y: r.minY), in: frame)
        let b = shownPoint(fromUser: CGPoint(x: r.maxX, y: r.maxY), in: frame)
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    /// The `images.add` matrix that puts a picture upright in a box as
    /// shown: the unit square's bottom row at the box's bottom, as a PDF
    /// draws pictures.
    static func uprightMatrix(in shown: CGRect) -> [Float] {
        [Float(shown.width), 0, 0, Float(-shown.height), Float(shown.minX), Float(shown.maxY)]
    }
}

/// A box in a page's stored space, as the core answers one.
struct StoredRect: Decodable, Equatable, Sendable {
    let x: Float
    let y: Float
    let width: Float
    let height: Float

    var cgRect: CGRect {
        CGRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: CGFloat(height))
    }
}
