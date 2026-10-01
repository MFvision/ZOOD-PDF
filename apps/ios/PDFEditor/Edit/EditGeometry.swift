import CoreGraphics

/// Edit PDF's geometry, the same arithmetic the desktop does
/// (`packages/ui/src/edit/matrix.ts`): where a picture lands, as the core
/// reports it — the matrix that takes its unit square onto the page as
/// shown, in points from the top-left corner, y down (`images.list`) — and
/// what a drag does to it.
///
/// A matrix is PDF's `[a b c d e f]` applied to a row vector: a point
/// (x, y) lands at (a·x + c·y + e, b·x + d·y + f). `compose(m, n)` is m
/// first, then n. Handles work in the picture's own unit square, so a
/// turned or slanted picture resizes along its own sides, as in a drawing
/// program.
enum EditGeometry {
    /// `[a, b, c, d, e, f]`, as the core answers and takes one.
    typealias Matrix = [Float]
    /// The part of the unit square that shows: `[u0, v0, u1, v1]`.
    typealias Clip = [Float]

    static let full: Clip = [0, 0, 1, 1]

    static func apply(_ m: Matrix, _ x: CGFloat, _ y: CGFloat) -> CGPoint {
        guard m.count == 6 else { return CGPoint(x: x, y: y) }
        let a = CGFloat(m[0]), b = CGFloat(m[1]), c = CGFloat(m[2])
        let d = CGFloat(m[3]), e = CGFloat(m[4]), f = CGFloat(m[5])
        return CGPoint(x: a * x + c * y + e, y: b * x + d * y + f)
    }

    /// `m` first, then `n`.
    static func compose(_ m: Matrix, _ n: Matrix) -> Matrix {
        guard m.count == 6, n.count == 6 else { return m }
        return [
            m[0] * n[0] + m[1] * n[2],
            m[0] * n[1] + m[1] * n[3],
            m[2] * n[0] + m[3] * n[2],
            m[2] * n[1] + m[3] * n[3],
            m[4] * n[0] + m[5] * n[2] + n[4],
            m[4] * n[1] + m[5] * n[3] + n[5],
        ]
    }

    /// Nil for a matrix that flattens the square to a line: nothing a drag
    /// does to it can be worked out, so nothing is done.
    static func invert(_ m: Matrix) -> Matrix? {
        guard m.count == 6 else { return nil }
        let det = m[0] * m[3] - m[1] * m[2]
        guard abs(det) > 1e-9 else { return nil }
        return [
            m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
            (m[2] * m[5] - m[3] * m[4]) / det,
            (m[1] * m[4] - m[0] * m[5]) / det,
        ]
    }

    /// The corners of the part that shows, on the page.
    static func corners(_ m: Matrix, clip: Clip = full) -> [CGPoint] {
        let c = clip.count == 4 ? clip : full
        let u0 = CGFloat(c[0]), v0 = CGFloat(c[1]), u1 = CGFloat(c[2]), v1 = CGFloat(c[3])
        return [
            apply(m, u0, v0), apply(m, u1, v0), apply(m, u1, v1), apply(m, u0, v1),
        ]
    }

    static func bounds(_ points: [CGPoint]) -> CGRect {
        guard let first = points.first else { return .zero }
        var minX = first.x, maxX = first.x, minY = first.y, maxY = first.y
        for p in points.dropFirst() {
            minX = min(minX, p.x); maxX = max(maxX, p.x)
            minY = min(minY, p.y); maxY = max(maxY, p.y)
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    static func translate(_ m: Matrix, dx: CGFloat, dy: CGFloat) -> Matrix {
        guard m.count == 6 else { return m }
        return [m[0], m[1], m[2], m[3], m[4] + Float(dx), m[5] + Float(dy)]
    }

    /// A picture upright in `rect`: its bottom row at the bottom, as PDF
    /// draws one.
    static func upright(in rect: CGRect) -> Matrix {
        [Float(rect.width), 0, 0, Float(-rect.height), Float(rect.minX), Float(rect.maxY)]
    }

    /// The largest rectangle of `aspect` (width / height) inside `rect`,
    /// centred: where a picture goes when it is dropped on a page.
    static func fit(_ rect: CGRect, aspect: CGFloat) -> CGRect {
        guard aspect > 0 else { return rect }
        let width = min(rect.width, rect.height * aspect)
        let height = width / aspect
        return CGRect(x: rect.minX + (rect.width - width) / 2,
                      y: rect.minY + (rect.height - height) / 2,
                      width: width, height: height)
    }

    /// Turned a quarter clockwise as it looks on screen, about the centre of
    /// the part that shows.
    static func quarterTurn(_ m: Matrix, clip: Clip = full) -> Matrix {
        let box = bounds(corners(m, clip: clip))
        let cx = Float(box.midX), cy = Float(box.midY)
        // y grows down, so (x, y) → (−y, x) turns clockwise.
        return compose(compose(compose(m, [1, 0, 0, 1, -cx, -cy]), [0, 1, -1, 0, 0, 0]),
                       [1, 0, 0, 1, cx, cy])
    }

    /// A handle of the part that shows, at `handle` — 0, ½ or 1 on each side
    /// of its own box — dragged to `pointer` on the page. The opposite side
    /// stays where it is; `keepAspect` scales both sides alike.
    static func resize(_ m: Matrix, clip: Clip, handle: CGPoint, pointer: CGPoint, keepAspect: Bool) -> Matrix {
        guard let inverse = invert(m) else { return m }
        let c = clip.count == 4 ? clip : full
        let u0 = CGFloat(c[0]), v0 = CGFloat(c[1]), u1 = CGFloat(c[2]), v1 = CGFloat(c[3])
        let hu = u0 + (u1 - u0) * handle.x
        let hv = v0 + (v1 - v0) * handle.y
        let fu = handle.x == 0 ? u1 : u0
        let fv = handle.y == 0 ? v1 : v0
        let p = apply(inverse, pointer.x, pointer.y)
        let movesU = handle.x != 0.5
        let movesV = handle.y != 0.5
        let minimum: CGFloat = 0.05
        var sx = movesU ? (p.x - fu) / (hu - fu) : 1
        var sy = movesV ? (p.y - fv) / (hv - fv) : 1
        if keepAspect {
            let s = movesU && movesV ? max(sx, sy) : (movesU ? sx : sy)
            sx = s
            sy = s
        }
        sx = max(minimum, sx)
        sy = max(minimum, sy)
        // Scale the unit square about the fixed side, then place it as before.
        let cu = movesU || keepAspect ? fu : 0
        let cv = movesV || keepAspect ? fv : 0
        return compose([Float(sx), 0, 0, Float(sy), Float(cu * (1 - sx)), Float(cv * (1 - sy))], m)
    }

    /// A crop handle dragged to `pointer`: that side of the part that shows
    /// moves, and the picture stays where it is.
    static func crop(_ m: Matrix, clip: Clip, handle: CGPoint, pointer: CGPoint) -> Clip {
        guard let inverse = invert(m), clip.count == 4 else { return clip }
        let p = apply(inverse, pointer.x, pointer.y)
        let minimum: Float = 0.02
        var u0 = clip[0], v0 = clip[1], u1 = clip[2], v1 = clip[3]
        let clamp = { (v: CGFloat) -> Float in Float(min(1, max(0, v))) }
        if handle.x == 0 { u0 = min(clamp(p.x), u1 - minimum) }
        if handle.x == 1 { u1 = max(clamp(p.x), u0 + minimum) }
        if handle.y == 0 { v0 = min(clamp(p.y), v1 - minimum) }
        if handle.y == 1 { v1 = max(clamp(p.y), v0 + minimum) }
        return [u0, v0, u1, v1]
    }

    /// A link's rectangle moved, or with one edge or corner dragged.
    static func drag(_ rect: CGRect, handle: CGPoint?, dx: CGFloat, dy: CGFloat) -> CGRect {
        guard let handle else { return rect.offsetBy(dx: dx, dy: dy) }
        var x = rect.minX, y = rect.minY, width = rect.width, height = rect.height
        let minimum: CGFloat = 4
        if handle.x == 0 {
            let right = x + width
            x = min(x + dx, right - minimum)
            width = right - x
        } else if handle.x == 1 {
            width = max(minimum, width + dx)
        }
        if handle.y == 0 {
            let bottom = y + height
            y = min(y + dy, bottom - minimum)
            height = bottom - y
        } else if handle.y == 1 {
            height = max(minimum, height + dy)
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    /// The rectangle between two points, however they were dragged.
    static func between(_ a: CGPoint, _ b: CGPoint) -> CGRect {
        CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    /// The eight handles of a box, as fractions of it: the corners and the
    /// middle of each side.
    static let handles: [CGPoint] = [
        CGPoint(x: 0, y: 0), CGPoint(x: 0.5, y: 0), CGPoint(x: 1, y: 0), CGPoint(x: 1, y: 0.5),
        CGPoint(x: 1, y: 1), CGPoint(x: 0.5, y: 1), CGPoint(x: 0, y: 1), CGPoint(x: 0, y: 0.5),
    ]

    /// The handle a touch landed on, within `tolerance` points of it, or nil
    /// for a touch inside the box (a move) or outside it.
    static func handle(at point: CGPoint, of box: CGRect, tolerance: CGFloat) -> CGPoint? {
        handles.first { handle in
            let at = CGPoint(x: box.minX + box.width * handle.x, y: box.minY + box.height * handle.y)
            return abs(at.x - point.x) <= tolerance && abs(at.y - point.y) <= tolerance
        }
    }
}
