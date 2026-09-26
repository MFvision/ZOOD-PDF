/// Geometry for Scan to PDF, kept free of CoreGraphics so it is tested on Linux.
/// Image coordinates: origin top-left, y grows downwards, units = pixels or points.
public struct Point2: Codable, Sendable, Equatable, Hashable {
    public var x: Double
    public var y: Double
    public init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }
}

public struct Size2: Codable, Sendable, Equatable {
    public var width: Double
    public var height: Double
    public init(_ width: Double, _ height: Double) {
        self.width = width
        self.height = height
    }
}

public struct Rect2: Codable, Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// The four corner handles of a detected page.
public struct Quad: Codable, Sendable, Equatable {
    public var topLeft: Point2
    public var topRight: Point2
    public var bottomRight: Point2
    public var bottomLeft: Point2

    public init(topLeft: Point2, topRight: Point2, bottomRight: Point2, bottomLeft: Point2) {
        self.topLeft = topLeft
        self.topRight = topRight
        self.bottomRight = bottomRight
        self.bottomLeft = bottomLeft
    }

    public var points: [Point2] { [topLeft, topRight, bottomRight, bottomLeft] }

    /// The whole image with an inset, used when nothing was detected.
    public static func inset(_ size: Size2, by fraction: Double = 0.08) -> Quad {
        let dx = size.width * fraction
        let dy = size.height * fraction
        return Quad(
            topLeft: Point2(dx, dy), topRight: Point2(size.width - dx, dy),
            bottomRight: Point2(size.width - dx, size.height - dy), bottomLeft: Point2(dx, size.height - dy))
    }

    /// Order four arbitrary corners (e.g. after the user dragged handles across each other).
    /// Returns nil when the points do not form a proper convex quadrilateral.
    public static func ordered(_ pts: [Point2]) -> Quad? {
        guard pts.count == 4, Set(pts).count == 4 else { return nil }
        // Sort by angle around the centroid → a simple (non-self-intersecting) polygon.
        let cx = pts.map(\.x).reduce(0, +) / 4
        let cy = pts.map(\.y).reduce(0, +) / 4
        let ring = pts.sorted { atan2Approx($0.y - cy, $0.x - cx) < atan2Approx($1.y - cy, $1.x - cx) }
        // In y-down coordinates increasing angle runs clockwise on screen: TL → TR → BR → BL.
        // Start at the point nearest the top-left (smallest x + y).
        guard let start = ring.indices.min(by: { ring[$0].x + ring[$0].y < ring[$1].x + ring[$1].y }) else {
            return nil
        }
        let r = (0..<4).map { ring[(start + $0) % 4] }
        let q = Quad(topLeft: r[0], topRight: r[1], bottomRight: r[2], bottomLeft: r[3])
        return q.isConvex && q.area > 1 ? q : nil
    }

    /// Shoelace area.
    public var area: Double {
        let p = points
        var s = 0.0
        for i in 0..<4 {
            let a = p[i]
            let b = p[(i + 1) % 4]
            s += a.x * b.y - b.x * a.y
        }
        return abs(s) / 2
    }

    public var isConvex: Bool {
        let p = points
        var sign = 0.0
        for i in 0..<4 {
            let a = p[i]
            let b = p[(i + 1) % 4]
            let c = p[(i + 2) % 4]
            let cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
            if cross == 0 { return false }
            if sign == 0 {
                sign = cross
            } else if (cross > 0) != (sign > 0) {
                return false
            }
        }
        return true
    }

    /// Clamp every corner into the image.
    public func clamped(to size: Size2) -> Quad {
        func c(_ p: Point2) -> Point2 {
            Point2(min(max(p.x, 0), size.width), min(max(p.y, 0), size.height))
        }
        return Quad(topLeft: c(topLeft), topRight: c(topRight), bottomRight: c(bottomRight), bottomLeft: c(bottomLeft))
    }

    /// Output size after perspective correction: the longer of each pair of opposite edges.
    public var correctedSize: Size2 {
        func d(_ a: Point2, _ b: Point2) -> Double { ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot() }
        return Size2(
            max(d(topLeft, topRight), d(bottomLeft, bottomRight)),
            max(d(topLeft, bottomLeft), d(topRight, bottomRight)))
    }

    /// Vision reports normalised corners with the origin at the bottom-left; convert to pixels,
    /// y-down.
    public static func fromVision(
        topLeft: Point2, topRight: Point2, bottomRight: Point2, bottomLeft: Point2, imageSize s: Size2
    ) -> Quad {
        func p(_ v: Point2) -> Point2 { Point2(v.x * s.width, (1 - v.y) * s.height) }
        return Quad(topLeft: p(topLeft), topRight: p(topRight), bottomRight: p(bottomRight), bottomLeft: p(bottomLeft))
    }
}

/// atan2 without Foundation (keeps this file dependency-free); monotonic, which is all sorting needs.
func atan2Approx(_ y: Double, _ x: Double) -> Double {
    // Pseudo-angle in [0, 4): same ordering as atan2 over (-π, π] shifted.
    let p = x == 0 && y == 0 ? 0 : y / (abs(x) + abs(y))
    return x < 0 ? 2 - p : (y < 0 ? 4 + p : p)
}

/// Layouts for the custom scan modes.
public enum ScanLayout {
    /// A4 portrait in PDF points.
    public static let a4 = Size2(595.276, 841.89)
    /// ISO/IEC 7810 ID-1 (85.60 × 53.98 mm) in points, so the printout is real size.
    public static let idCard = Size2(85.60 / 25.4 * 72, 53.98 / 25.4 * 72)

    /// ID Card mode: front above back, both at real size, centred on one A4 page.
    public static func idCardFrames(page: Size2 = a4, card: Size2 = idCard, gap: Double = 36) -> (front: Rect2, back: Rect2) {
        let x = (page.width - card.width) / 2
        let total = card.height * 2 + gap
        let top = (page.height - total) / 2
        return (
            Rect2(x: x, y: top, width: card.width, height: card.height),
            Rect2(x: x, y: top + card.height + gap, width: card.width, height: card.height)
        )
    }

    /// Book mode: split a corrected spread into two pages at the gutter (default: the middle).
    /// Returns the halves in reading order: right page first for right-to-left books (Arabic).
    public static func bookPages(spread: Size2, gutter: Double? = nil, rightToLeft: Bool) -> [Rect2] {
        let g = min(max(gutter ?? spread.width / 2, 1), spread.width - 1)
        let left = Rect2(x: 0, y: 0, width: g, height: spread.height)
        let right = Rect2(x: g, y: 0, width: spread.width - g, height: spread.height)
        return rightToLeft ? [right, left] : [left, right]
    }

    /// Fit `content` inside `box` keeping the aspect ratio, centred.
    public static func aspectFit(_ content: Size2, in box: Rect2) -> Rect2 {
        guard content.width > 0, content.height > 0 else { return box }
        let s = min(box.width / content.width, box.height / content.height)
        let w = content.width * s
        let h = content.height * s
        return Rect2(x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h)
    }
}
