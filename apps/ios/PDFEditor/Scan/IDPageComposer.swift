import CoreGraphics
import Foundation

/// ID mode: the front and the back of a card on one A4 page at the card's
/// real size (ID-1, 85.60 × 53.98 mm — a national ID, a driving licence, a
/// bank card), one under the other; or a passport's page (ID-3, 125 × 88 mm)
/// alone or with a second one. The page is drawn at 300 dots per inch, so
/// a print of it is the card's size.
enum IDPageComposer {
    enum Kind: Equatable, Sendable {
        case card
        case passport

        /// ISO/IEC 7810 sizes, in millimetres.
        var millimetres: CGSize {
            switch self {
            case .card: CGSize(width: 85.60, height: 53.98)
            case .passport: CGSize(width: 125, height: 88)
            }
        }

        var points: CGSize {
            CGSize(width: millimetres.width / 25.4 * 72, height: millimetres.height / 25.4 * 72)
        }

        /// How many sides the mode expects: a card has two, a passport's data page one.
        var sides: Int {
            switch self {
            case .card: 2
            case .passport: 1
            }
        }
    }

    static let dpi: CGFloat = 300
    /// A4 in points and, at 300 dpi, in pixels.
    static let pagePoints = CGSize(width: 595.276, height: 841.89)
    static var pagePixels: CGSize {
        CGSize(width: (pagePoints.width / 72 * dpi).rounded(), height: (pagePoints.height / 72 * dpi).rounded())
    }
    /// Between the two sides, in points (14 mm).
    static let gap: CGFloat = 40
    /// The card's rounded corners (ISO 7810: 3.18 mm).
    static let cornerRadius: CGFloat = 3.18 / 25.4 * 72

    /// Where each side sits on the page, in points from the page's top-left
    /// corner, the group centred on the page.
    static func slots(kind: Kind, sides: Int) -> [CGRect] {
        let size = kind.points
        let count = max(1, sides)
        let total = size.height * CGFloat(count) + gap * CGFloat(count - 1)
        let top = (pagePoints.height - total) / 2
        let left = (pagePoints.width - size.width) / 2
        return (0..<count).map { k in
            CGRect(x: left, y: top + CGFloat(k) * (size.height + gap), width: size.width, height: size.height)
        }
    }

    /// The page as a picture: white paper, each side filling its slot (the
    /// crop is the card, so it fills — a hair of it clipped by the rounded
    /// corners rather than a band of white around it), a hairline round each.
    static func compose(sides: [CGImage], kind: Kind) -> CGImage? {
        guard !sides.isEmpty else { return nil }
        let pixels = pagePixels
        let width = Int(pixels.width), height = Int(pixels.height)
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let scale = dpi / 72
        context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        // Points from the top-left, as the slots are, onto the bitmap's
        // bottom-up pixels.
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: scale, y: -scale)
        for (side, slot) in zip(sides, slots(kind: kind, sides: sides.count)) {
            let path = CGPath(roundedRect: slot, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
            context.saveGState()
            context.addPath(path)
            context.clip()
            // Aspect-fill the slot.
            let imageAspect = CGFloat(side.width) / CGFloat(side.height)
            let slotAspect = slot.width / slot.height
            var drawRect = slot
            if imageAspect > slotAspect {
                drawRect.size.width = slot.height * imageAspect
                drawRect.origin.x = slot.midX - drawRect.width / 2
            } else {
                drawRect.size.height = slot.width / imageAspect
                drawRect.origin.y = slot.midY - drawRect.height / 2
            }
            // `draw` paints upright in a y-up space; this space is y-down.
            context.saveGState()
            context.translateBy(x: 0, y: drawRect.maxY + drawRect.minY)
            context.scaleBy(x: 1, y: -1)
            context.interpolationQuality = .high
            context.draw(side, in: drawRect)
            context.restoreGState()
            context.restoreGState()
            context.addPath(path)
            context.setStrokeColor(red: 0.72, green: 0.72, blue: 0.72, alpha: 1)
            context.setLineWidth(0.6)
            context.strokePath()
        }
        return context.makeImage()
    }
}
