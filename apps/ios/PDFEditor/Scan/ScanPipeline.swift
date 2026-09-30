import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

// The scanner's picture pipeline, on any photo: where the page is (Vision's
// document segmentation), the page cut out and straightened (Core Image's
// perspective correction), the slant of its lines taken out, the paper's
// shadows and stains divided away, folds smoothed, ink sharpened, colour or
// grey or black and white, ink stretched to black and paper to white. Every
// step is a pure function of its picture: the same photo gives the same
// page every time, which is what the unit tests hold it to.

/// The four corners of a page in a picture, in pixels from the picture's
/// top-left corner, clockwise from the top-left.
struct Quad: Equatable, Sendable, Codable {
    var topLeft: CGPoint
    var topRight: CGPoint
    var bottomRight: CGPoint
    var bottomLeft: CGPoint

    /// The whole picture.
    static func whole(_ size: CGSize) -> Quad {
        Quad(topLeft: .zero, topRight: CGPoint(x: size.width, y: 0),
             bottomRight: CGPoint(x: size.width, y: size.height), bottomLeft: CGPoint(x: 0, y: size.height))
    }

    /// The corners by index: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left.
    var points: [CGPoint] {
        get { [topLeft, topRight, bottomRight, bottomLeft] }
        set {
            guard newValue.count == 4 else { return }
            topLeft = newValue[0]
            topRight = newValue[1]
            bottomRight = newValue[2]
            bottomLeft = newValue[3]
        }
    }

    subscript(index: Int) -> CGPoint {
        get { points[index] }
        set {
            var all = points
            all[index] = newValue
            points = all
        }
    }

    /// Every corner kept inside the picture.
    func clamped(to size: CGSize) -> Quad {
        var out = self
        out.points = points.map {
            CGPoint(x: min(max($0.x, 0), size.width), y: min(max($0.y, 0), size.height))
        }
        return out
    }

    /// The page's size in pixels, as the longer of each pair of opposite edges.
    /// This is how big the page is on the photo, not what shape it really is:
    /// a page photographed at an angle has one edge nearer the lens and so
    /// longer than the one opposite. `ScanPipeline.pageAspect(of:in:)` is what
    /// answers the shape.
    var pageSize: CGSize {
        let top = hypot(topRight.x - topLeft.x, topRight.y - topLeft.y)
        let bottom = hypot(bottomRight.x - bottomLeft.x, bottomRight.y - bottomLeft.y)
        let left = hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y)
        let right = hypot(bottomRight.x - topRight.x, bottomRight.y - topRight.y)
        return CGSize(width: max(top, bottom).rounded(), height: max(left, right).rounded())
    }

    /// The box around the corners.
    var bounds: CGRect {
        let xs = points.map(\.x), ys = points.map(\.y)
        return CGRect(x: xs.min() ?? 0, y: ys.min() ?? 0, width: (xs.max() ?? 0) - (xs.min() ?? 0), height: (ys.max() ?? 0) - (ys.min() ?? 0))
    }

    /// How much of the picture the quad covers, 0 to 1.
    func coverage(of size: CGSize) -> CGFloat {
        guard size.width > 0, size.height > 0 else { return 0 }
        let p = points
        var area: CGFloat = 0
        for i in 0..<4 {
            let a = p[i], b = p[(i + 1) % 4]
            area += a.x * b.y - b.x * a.y
        }
        return abs(area) / 2 / (size.width * size.height)
    }

    /// Whether the corners still make a convex page (no edge crossing another).
    var isConvex: Bool {
        let p = points
        var sign = 0
        for i in 0..<4 {
            let a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4]
            let cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
            if abs(cross) < 1e-6 { return false }
            let s = cross > 0 ? 1 : -1
            if sign == 0 { sign = s } else if sign != s { return false }
        }
        return true
    }
}

/// A point of the picture with a third coordinate, so that the lines through
/// pairs of them and the points where those lines meet — a vanishing point —
/// are cross products and dot products. Only `ScanPipeline.pageAspect` uses it.
struct Homogeneous {
    var x: CGFloat
    var y: CGFloat
    var z: CGFloat

    init(_ point: CGPoint) {
        x = point.x
        y = point.y
        z = 1
    }

    init(x: CGFloat, y: CGFloat, z: CGFloat) {
        self.x = x
        self.y = y
        self.z = z
    }

    func cross(_ other: Homogeneous) -> Homogeneous {
        Homogeneous(x: y * other.z - z * other.y, y: z * other.x - x * other.z, z: x * other.y - y * other.x)
    }

    func dot(_ other: Homogeneous) -> CGFloat {
        x * other.x + y * other.y + z * other.z
    }

    func scaled(by k: CGFloat) -> Homogeneous {
        Homogeneous(x: k * x, y: k * y, z: k * z)
    }

    func minus(_ other: Homogeneous) -> Homogeneous {
        Homogeneous(x: x - other.x, y: y - other.y, z: z - other.z)
    }
}

/// Colour, grey, or black and white.
enum ScanColorMode: String, CaseIterable, Identifiable, Codable, Sendable {
    case color
    case grey
    case blackAndWhite

    var id: String { rawValue }
}

/// What the pipeline does to a page, each step a choice of the person's.
struct Enhancement: Equatable, Codable, Sendable {
    var mode: ScanColorMode = .color
    /// Turn the page level by the slant of its lines of text.
    var deskew = true
    /// Divide the paper's shadows, stains and uneven light away.
    var flattenLighting = true
    /// Smooth the faint dark bands a fold or a crease leaves.
    var smoothCreases = true
    var sharpen = true
    /// Stretch the ink to black and the paper to white.
    var autoContrast = true
    /// Book mode only: straighten lines bowed by the page's curve.
    var flattenCurvature = false
    /// Whiteboard mode: glare and shadow evened out, the board pushed to
    /// white, the markers' colours kept and deepened.
    var whiteboard = false

    /// The photo exactly as it is.
    static let none = Enhancement(mode: .color, deskew: false, flattenLighting: false, smoothCreases: false,
                                  sharpen: false, autoContrast: false, flattenCurvature: false, whiteboard: false)

    var isNone: Bool { self == .none }
}

/// A page after the pipeline, and what the pipeline measured on the way.
struct EnhancedPage: Sendable {
    let image: CGImage
    /// Degrees counter-clockwise the page was turned by, taken out.
    let skew: Double
    /// Book mode: how many pixels the lines were bowed by, when measured.
    let bow: Double?
}

enum ScanPipeline {
    /// One context for every render: it is thread-safe and holds the GPU's
    /// resources, so making one per page would be waste.
    static let context = CIContext(options: [.cacheIntermediates: false, .name: "scan"])

    /// The longest side a page is worked on at: a phone's photo is far
    /// larger than any recognition needs, and every step's cost is per pixel.
    static let maxSide: CGFloat = 3000

    // MARK: - Finding the page

    /// Where the page is in a photo: Vision's document segmentation when
    /// it answers something page-shaped, else its rectangle detector's
    /// best rectangle, else nil (the caller takes the whole picture). On
    /// the simulator the segmentation model has answered a band along the
    /// bottom of a photo with 0.97 confidence (`ScanPipelineTests` logs
    /// what both detectors say); `plausible` is what keeps that out.
    static func detectPage(in image: CGImage) -> Quad? {
        let size = CGSize(width: image.width, height: image.height)
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        if let quad = segmentedPage(handler, in: size), plausible(quad, in: size) {
            return quad
        }
        return rectangles(handler, in: size, count: 1).first { plausible($0, in: size) }
    }

    /// An open book: the whole spread. Segmentation when it answers
    /// something plausible; else the two largest rectangles side by side —
    /// the two pages, which the rectangle detector sees one at a time —
    /// joined into one quad; else the one rectangle; else nil.
    static func detectSpread(in image: CGImage) -> Quad? {
        let size = CGSize(width: image.width, height: image.height)
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        if let quad = segmentedPage(handler, in: size), plausible(quad, in: size), quad.coverage(of: size) > 0.4 {
            return quad
        }
        let found = rectangles(handler, in: size, count: 4)
            .filter { plausible($0, in: size) }
            .sorted { $0.coverage(of: size) > $1.coverage(of: size) }
        if found.count >= 2 {
            let (left, right) = found[0].bounds.midX < found[1].bounds.midX ? (found[0], found[1]) : (found[1], found[0])
            let leftEdge = max(left.topRight.x, left.bottomRight.x)
            let rightEdge = min(right.topLeft.x, right.bottomLeft.x)
            let overlap = min(left.bounds.maxY, right.bounds.maxY) - max(left.bounds.minY, right.bounds.minY)
            // Side by side: hardly overlapping across, mostly overlapping down.
            if rightEdge >= leftEdge - size.width * 0.05, overlap > 0.6 * min(left.bounds.height, right.bounds.height) {
                return Quad(topLeft: left.topLeft, topRight: right.topRight, bottomRight: right.bottomRight, bottomLeft: left.bottomLeft)
            }
        }
        return found.first
    }

    private static func segmentedPage(_ handler: VNImageRequestHandler, in size: CGSize) -> Quad? {
        let request = VNDetectDocumentSegmentationRequest()
        guard (try? handler.perform([request])) != nil, let found = request.results?.first, found.confidence > 0.3 else {
            return nil
        }
        return quad(from: found, in: size)
    }

    /// The rectangle detector's best `count` rectangles, most confident first.
    private static func rectangles(_ handler: VNImageRequestHandler, in size: CGSize, count: Int) -> [Quad] {
        let request = VNDetectRectanglesRequest()
        request.minimumAspectRatio = 0.2
        request.maximumAspectRatio = 1.0
        request.quadratureTolerance = 35
        request.minimumSize = 0.15
        request.minimumConfidence = 0.5
        request.maximumObservations = count
        guard (try? handler.perform([request])) != nil, let found = request.results else { return [] }
        return found.map { quad(from: $0, in: size) }
    }

    /// A page, a card or a spread: convex, at least a tenth of the photo,
    /// no more than four times as wide as tall or tall as wide, and not a
    /// band along an edge — a small quad touching three of the photo's
    /// borders is a detector's mistake, not a page.
    static func plausible(_ quad: Quad, in size: CGSize) -> Bool {
        guard quad.isConvex else { return false }
        let coverage = quad.coverage(of: size)
        guard coverage > 0.1 else { return false }
        let page = quad.pageSize
        guard page.width > 0, page.height > 0 else { return false }
        let aspect = page.width / page.height
        guard aspect > 0.25, aspect < 4 else { return false }
        let bounds = quad.bounds
        let margin: CGFloat = 0.02
        var touched = 0
        if bounds.minX <= size.width * margin { touched += 1 }
        if bounds.maxX >= size.width * (1 - margin) { touched += 1 }
        if bounds.minY <= size.height * margin { touched += 1 }
        if bounds.maxY >= size.height * (1 - margin) { touched += 1 }
        return !(touched >= 3 && coverage < 0.5)
    }

    /// What Vision's two detectors answer for a picture, raw, for the tests'
    /// log: the segmentation's confidence, box and corners, and the
    /// rectangle detector's.
    static func printDetections(in image: CGImage, name: String) {
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        let segmentation = VNDetectDocumentSegmentationRequest()
        try? handler.perform([segmentation])
        for (k, found) in (segmentation.results ?? []).enumerated() {
            print("SCAN-DETECT \(name) segmentation[\(k)] confidence \(found.confidence) box \(found.boundingBox) tl \(found.topLeft) tr \(found.topRight) br \(found.bottomRight) bl \(found.bottomLeft) mask \(found.globalSegmentationMask.map { "\(CVPixelBufferGetWidth($0.pixelBuffer))x\(CVPixelBufferGetHeight($0.pixelBuffer))" } ?? "none")")
        }
        let rectangles = VNDetectRectanglesRequest()
        rectangles.minimumAspectRatio = 0.2
        rectangles.maximumAspectRatio = 1.0
        rectangles.quadratureTolerance = 35
        rectangles.minimumSize = 0.15
        rectangles.minimumConfidence = 0.5
        rectangles.maximumObservations = 3
        try? handler.perform([rectangles])
        for (k, found) in (rectangles.results ?? []).enumerated() {
            print("SCAN-DETECT \(name) rectangle[\(k)] confidence \(found.confidence) box \(found.boundingBox) tl \(found.topLeft) tr \(found.topRight) br \(found.bottomRight) bl \(found.bottomLeft)")
        }
        print("SCAN-DETECT \(name) image \(image.width)x\(image.height) bits \(image.bitsPerPixel) alpha \(image.alphaInfo.rawValue) space \(image.colorSpace?.name.map { String($0) } ?? "none")")
    }

    /// Vision's corners (normalized, from the bottom-left) as pixels from
    /// the top-left.
    private static func quad(from observation: VNRectangleObservation, in size: CGSize) -> Quad {
        func pixel(_ p: CGPoint) -> CGPoint {
            CGPoint(x: p.x * size.width, y: (1 - p.y) * size.height)
        }
        return Quad(topLeft: pixel(observation.topLeft), topRight: pixel(observation.topRight),
                    bottomRight: pixel(observation.bottomRight), bottomLeft: pixel(observation.bottomLeft))
            .clamped(to: size)
    }

    // MARK: - How big the page really is

    /// A camera's focal length in pixels is about this many times the longer
    /// side of the picture it takes: a phone's main lens sees roughly 70°
    /// across. It stands in where the corners cannot say what the lens was.
    static let assumedFocalLength: CGFloat = 1.1

    /// A solved focal length is believed only inside this band of the
    /// picture's longer side — from an ultra-wide to a modest telephoto.
    /// Anything outside it is arithmetic, not a camera.
    static let focalLengthBand: ClosedRange<CGFloat> = 0.5...4.0

    /// Each pair of the page's edges must be at least this far from parallel
    /// before their meeting point is worth solving the lens from. Below it the
    /// two lines are so nearly parallel that a pixel of noise on a corner
    /// throws the answer off by tens of percent (measured: ±8 px of noise on a
    /// page tilted on one axis only gave errors up to 73 %).
    static let minimumConvergence: CGFloat = 0.03

    /// The width ÷ height of the rectangle the quad is a photograph of.
    ///
    /// The quad's own edges do not say it: a page tilted away from the lens
    /// has its far edge shorter than its near one, so `Quad.pageSize` makes an
    /// A4 page look 14 % narrower turned 22° sideways and 31 % wider tilted 28°
    /// back (measured in `ScanGeometryTests`). A rectangle seen by a pinhole
    /// camera does say it, though: each pair of its edges meets at a vanishing
    /// point, the two vanishing points give the lens's focal length, and the
    /// focal length gives the rectangle's proportions (Zhang and He, *Whiteboard
    /// scanning and image enhancement*, 2007). Where only one pair converges the
    /// focal length cannot be solved and `assumedFocalLength` stands in; where
    /// neither does (the page was square to the lens) the edges are already
    /// right and the answer comes out as their ratio.
    ///
    /// nil when the corners are degenerate — three in a line, or two the same.
    static func pageAspect(of quad: Quad, in size: CGSize) -> CGFloat? {
        let u0 = size.width / 2, v0 = size.height / 2
        // The corners as homogeneous points, named as the construction names
        // them: 1 top-left, 2 top-right, 3 bottom-left, 4 bottom-right.
        let m1 = Homogeneous(quad.topLeft), m2 = Homogeneous(quad.topRight)
        let m3 = Homogeneous(quad.bottomLeft), m4 = Homogeneous(quad.bottomRight)
        let d2 = m2.cross(m4).dot(m3), d3 = m3.cross(m4).dot(m2)
        guard abs(d2) > 1e-9, abs(d3) > 1e-9 else { return nil }
        let k2 = m1.cross(m4).dot(m3) / d2
        let k3 = m1.cross(m4).dot(m2) / d3
        let n2 = m2.scaled(by: k2).minus(m1)
        let n3 = m3.scaled(by: k3).minus(m1)

        /// The squared length the vector would have on the sensor of a camera
        /// with this focal length and its centre in the middle of the picture.
        func squaredLength(_ n: Homogeneous, focal f: CGFloat) -> CGFloat {
            let x = (n.x - u0 * n.z) / f, y = (n.y - v0 * n.z) / f
            return x * x + y * y + n.z * n.z
        }

        let longest = max(size.width, size.height)
        var focal = assumedFocalLength * longest
        // n2.z and n3.z are how far each pair of edges is from parallel.
        if abs(n2.z) > minimumConvergence, abs(n3.z) > minimumConvergence {
            let alongX = n2.x * n3.x - (n2.x * n3.z + n2.z * n3.x) * u0 + n2.z * n3.z * u0 * u0
            let alongY = n2.y * n3.y - (n2.y * n3.z + n2.z * n3.y) * v0 + n2.z * n3.z * v0 * v0
            let squared = -(alongX + alongY) / (n2.z * n3.z)
            if squared > 0, squared.isFinite {
                let solved = sqrt(squared)
                if focalLengthBand.contains(solved / longest) { focal = solved }
            }
        }
        let squared = squaredLength(n2, focal: focal) / squaredLength(n3, focal: focal)
        guard squared > 0, squared.isFinite else { return nil }
        let aspect = sqrt(squared)
        // A page four times as wide as tall, or as tall as wide, is not a page:
        // the corners were nonsense, so say nothing rather than a wrong shape.
        guard aspect > 0.2, aspect < 5 else { return nil }
        return aspect
    }

    /// How many pixels the page is drawn at once it is cut out: its true
    /// proportions (`pageAspect`), at the density of whichever of its edges
    /// the photo caught at the most pixels, and never above `maxSide`.
    static func correctedSize(of quad: Quad, in size: CGSize) -> CGSize {
        let edges = quad.pageSize
        guard let aspect = pageAspect(of: quad, in: size), edges.width >= 1, edges.height >= 1 else { return edges }
        // Whichever way the page was stretched on the photo, keep the detail:
        // take the larger of the two sizes the aspect allows.
        var width = max(edges.width, edges.height * aspect)
        var height = width / aspect
        let longest = max(width, height)
        if longest > maxSide {
            width *= maxSide / longest
            height *= maxSide / longest
        }
        return CGSize(width: max(8, width.rounded()), height: max(8, height.rounded()))
    }

    // MARK: - Cutting the page out

    /// The page inside `quad`, cut out and made rectangular — and drawn at the
    /// page's own proportions. Core Image's perspective correction undoes the
    /// projection exactly, but it sizes its answer from the quad's own
    /// extremes, which is not the page's shape; so the answer is scaled to
    /// `correctedSize(of:in:)`.
    static func corrected(_ image: CGImage, quad: Quad) -> CGImage {
        let size = CGSize(width: image.width, height: image.height)
        let whole = Quad.whole(size)
        if quad == whole { return image }
        guard quad.isConvex else { return image }
        let input = CIImage(cgImage: image)
        // Core Image's y goes up.
        func ci(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x, y: size.height - p.y) }
        let filter = CIFilter.perspectiveCorrection()
        filter.inputImage = input
        filter.topLeft = ci(quad.topLeft)
        filter.topRight = ci(quad.topRight)
        filter.bottomRight = ci(quad.bottomRight)
        filter.bottomLeft = ci(quad.bottomLeft)
        guard let output = filter.outputImage, output.extent.width >= 8, output.extent.height >= 8,
              output.extent.width.isFinite, output.extent.height.isFinite else {
            return image
        }
        let target = correctedSize(of: quad, in: size)
        let shaped = output.transformed(by: CGAffineTransform(scaleX: target.width / output.extent.width,
                                                             y: target.height / output.extent.height))
        return render(shaped) ?? render(output) ?? image
    }

    // MARK: - The enhancement

    /// The page through every step the enhancement asks for, in the order
    /// that makes each step's job easiest: level first, then the paper
    /// evened out, folds smoothed, contrast stretched, ink sharpened, and
    /// last the colour mode.
    static func enhance(_ image: CGImage, with enhancement: Enhancement) -> EnhancedPage {
        var source = downsized(image)
        var bow: Double?
        // A book page's curve first: it takes the bend out of every line
        // and leaves them all tilted alike, which the deskew then measures
        // sharply and takes out.
        if enhancement.flattenCurvature {
            let flat = BookFlattener.flattened(source)
            bow = flat.bow
            if flat.bow != nil {
                source = flat.image
            }
        }
        var skew = 0.0
        var working = CIImage(cgImage: source)
        if enhancement.deskew {
            skew = skewAngle(of: source)
            if skew != 0 {
                working = rotated(working, counterClockwiseDegrees: -skew)
            }
        }
        if enhancement.flattenLighting || enhancement.whiteboard {
            working = flattenedLighting(working)
        }
        if enhancement.whiteboard {
            working = whiteboard(working)
        }
        if enhancement.smoothCreases {
            working = smoothedCreases(working)
        }
        if enhancement.autoContrast {
            working = autoContrast(working)
        }
        if enhancement.sharpen {
            working = sharpened(working)
        }
        working = colored(working, mode: enhancement.mode)
        return EnhancedPage(image: render(working) ?? source, skew: skew, bow: bow)
    }

    /// The picture at no more than `maxSide` on its longer side.
    static func downsized(_ image: CGImage) -> CGImage {
        let longest = CGFloat(max(image.width, image.height))
        guard longest > maxSide else { return image }
        let scale = maxSide / longest
        let output = CIImage(cgImage: image).transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return render(output) ?? image
    }

    // MARK: - Deskew

    /// How far the lines of text are turned, in degrees counter-clockwise as
    /// the page is shown: 0 when they are level, or when there is too
    /// little ink to tell. The rows of ink are most uneven — the peaks of
    /// the lines sharpest — when counted along the lines' own slant.
    static func skewAngle(of image: CGImage) -> Double {
        guard let grey = GreyBitmap(image, maxSide: 900) else { return 0 }
        let threshold = grey.otsu()
        var ink: [(x: Int, y: Int)] = []
        ink.reserveCapacity(grey.width * grey.height / 20)
        for y in 0..<grey.height {
            for x in 0..<grey.width where grey[x, y] < threshold {
                ink.append((x, y))
            }
        }
        let share = Double(ink.count) / Double(grey.width * grey.height)
        guard share > 0.002, share < 0.4 else { return 0 }
        let cx = Double(grey.width) / 2
        let margin = Int(Double(grey.width) * tan(16 * Double.pi / 180)) + 2
        var counts = [Double](repeating: 0, count: grey.height + 2 * margin)

        func unevenness(_ degrees: Double) -> Double {
            let slope = tan(degrees * Double.pi / 180)
            for i in counts.indices { counts[i] = 0 }
            for p in ink {
                let row = Double(p.y) + (Double(p.x) - cx) * slope
                let r = Int(row.rounded()) + margin
                if r >= 0, r < counts.count { counts[r] += 1 }
            }
            let mean = Double(ink.count) / Double(counts.count)
            var variance = 0.0
            for c in counts { variance += (c - mean) * (c - mean) }
            return variance
        }

        let level = unevenness(0)
        var best = 0.0
        var bestScore = level
        for step in stride(from: -15.0, through: 15.0, by: 1.0) {
            let score = unevenness(step)
            if score > bestScore { bestScore = score; best = step }
        }
        let coarse = best
        for step in stride(from: coarse - 0.9, through: coarse + 0.9, by: 0.1) {
            let score = unevenness(step)
            if score > bestScore { bestScore = score; best = step }
        }
        best = (best * 10).rounded() / 10
        // A slant must make the rows clearly more uneven than none, or it is noise.
        guard abs(best) >= 0.4, bestScore > level * 1.05 else { return 0 }
        return best
    }

    /// The picture turned about its centre, the same size, corners filled
    /// with white paper. Positive is counter-clockwise as shown.
    static func rotated(_ image: CIImage, counterClockwiseDegrees degrees: Double) -> CIImage {
        let extent = image.extent
        let centre = CGPoint(x: extent.midX, y: extent.midY)
        let transform = CGAffineTransform(translationX: -centre.x, y: -centre.y)
            .concatenating(CGAffineTransform(rotationAngle: degrees * .pi / 180))
            .concatenating(CGAffineTransform(translationX: centre.x, y: centre.y))
        let paper = CIImage(color: .white).cropped(to: extent)
        return image.transformed(by: transform).composited(over: paper).cropped(to: extent)
    }

    // MARK: - Lighting

    /// The paper's own brightness estimated over the page — the bright end
    /// of each neighbourhood, at a scale where letters vanish, smoothed —
    /// and every pixel divided by it: a shadow or a stain becomes white
    /// paper again, ink stays ink.
    static func flattenedLighting(_ image: CIImage) -> CIImage {
        let extent = image.extent
        let short = min(extent.width, extent.height)
        guard short > 16 else { return image }
        let scale = min(1, 240 / short)
        let small = image.clampedToExtent()
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let smallExtent = extent.applying(CGAffineTransform(scaleX: scale, y: scale)).integral
        let brightest = CIFilter.morphologyMaximum()
        brightest.inputImage = small.clampedToExtent()
        brightest.radius = 5
        let blur = CIFilter.gaussianBlur()
        blur.inputImage = brightest.outputImage?.clampedToExtent()
        blur.radius = 7
        guard let smoothed = blur.outputImage?.cropped(to: smallExtent) else { return image }
        let background = smoothed
            .transformed(by: CGAffineTransform(scaleX: 1 / scale, y: 1 / scale))
            .clampedToExtent()
            .cropped(to: extent)
        // Never divide by black: the darkest paper counts as 8 % grey.
        let floor = CIFilter.colorClamp()
        floor.inputImage = background
        floor.minComponents = CIVector(x: 0.08, y: 0.08, z: 0.08, w: 1)
        floor.maxComponents = CIVector(x: 1, y: 1, z: 1, w: 1)
        let divide = CIFilter.divideBlendMode()
        // Photoshop's Divide, which Core Image copies: background ÷ blend,
        // the blend layer being the filter's input image.
        divide.inputImage = floor.outputImage
        divide.backgroundImage = image
        guard let divided = divide.outputImage else { return image }
        return clamped(divided).cropped(to: extent)
    }

    // MARK: - Creases, contrast, sharpening, colour

    /// A whiteboard once its glare and shadow are divided away: the board
    /// (anything lighter than 78 % grey) pushed to white, the markers'
    /// strokes kept — their colours deepened by half again so a faint blue
    /// or red marker stays blue or red rather than going grey.
    static func whiteboard(_ image: CIImage) -> CIImage {
        let colour = CIFilter.colorControls()
        colour.inputImage = image
        colour.saturation = 1.6
        colour.contrast = 1.15
        let curve = CIFilter.toneCurve()
        curve.inputImage = colour.outputImage
        curve.point0 = CGPoint(x: 0, y: 0)
        curve.point1 = CGPoint(x: 0.25, y: 0.2)
        curve.point2 = CGPoint(x: 0.5, y: 0.5)
        curve.point3 = CGPoint(x: 0.78, y: 1)
        curve.point4 = CGPoint(x: 1, y: 1)
        return clamped(curve.outputImage ?? image).cropped(to: image.extent)
    }

    /// Dust and noise taken out by the median of each pixel's neighbours,
    /// then paper lighter than 82 % grey — the faint band a fold leaves once
    /// its shadow is divided away — lifted to white; ink is far darker and
    /// stays. A fold that hides the ink itself is not brought back.
    static func smoothedCreases(_ image: CIImage) -> CIImage {
        let median = CIFilter.median()
        median.inputImage = image.clampedToExtent()
        let denoise = CIFilter.noiseReduction()
        denoise.inputImage = median.outputImage
        denoise.noiseLevel = 0.03
        denoise.sharpness = 0.5
        let curve = CIFilter.toneCurve()
        curve.inputImage = denoise.outputImage
        curve.point0 = CGPoint(x: 0, y: 0)
        curve.point1 = CGPoint(x: 0.3, y: 0.27)
        curve.point2 = CGPoint(x: 0.6, y: 0.62)
        curve.point3 = CGPoint(x: 0.82, y: 1)
        curve.point4 = CGPoint(x: 1, y: 1)
        return (curve.outputImage ?? image).cropped(to: image.extent)
    }

    /// The darkest half-percent of the page stretched to black and its
    /// brightest one percent — the paper — to white, from a histogram of
    /// its grey.
    static func autoContrast(_ image: CIImage) -> CIImage {
        guard let (low, high) = greyRange(of: image), high - low > 0.08, high - low < 0.98 else {
            return image
        }
        let scale = 1 / (high - low)
        let bias = -low * scale
        let matrix = CIFilter.colorMatrix()
        matrix.inputImage = image
        matrix.rVector = CIVector(x: scale, y: 0, z: 0, w: 0)
        matrix.gVector = CIVector(x: 0, y: scale, z: 0, w: 0)
        matrix.bVector = CIVector(x: 0, y: 0, z: scale, w: 0)
        matrix.aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
        matrix.biasVector = CIVector(x: bias, y: bias, z: bias, w: 0)
        guard let output = matrix.outputImage else { return image }
        return clamped(output).cropped(to: image.extent)
    }

    /// The grey levels the darkest 0.5 % and the darkest 99 % of the page's
    /// pixels fall under, 0 to 1.
    static func greyRange(of image: CIImage) -> (low: CGFloat, high: CGFloat)? {
        let grey = CIFilter.colorControls()
        grey.inputImage = image
        grey.saturation = 0
        let histogram = CIFilter.areaHistogram()
        histogram.inputImage = grey.outputImage
        histogram.extent = image.extent
        histogram.count = 256
        histogram.scale = 1
        guard let output = histogram.outputImage else { return nil }
        var bins = [Float](repeating: 0, count: 256 * 4)
        bins.withUnsafeMutableBytes { buffer in
            context.render(output, toBitmap: buffer.baseAddress!, rowBytes: 256 * 16,
                           bounds: CGRect(x: 0, y: 0, width: 256, height: 1), format: .RGBAf, colorSpace: nil)
        }
        var total: Float = 0
        for i in 0..<256 { total += bins[i * 4] }
        guard total > 0 else { return nil }
        var low = 0, high = 255
        var sum: Float = 0
        for i in 0..<256 {
            sum += bins[i * 4]
            if sum >= total * 0.005 { low = i; break }
        }
        sum = 0
        for i in 0..<256 {
            sum += bins[i * 4]
            if sum >= total * 0.99 { high = i; break }
        }
        return (CGFloat(low) / 255, CGFloat(high) / 255)
    }

    static func sharpened(_ image: CIImage) -> CIImage {
        let sharpen = CIFilter.unsharpMask()
        sharpen.inputImage = image.clampedToExtent()
        sharpen.radius = 1.6
        sharpen.intensity = 0.55
        return (sharpen.outputImage ?? image).cropped(to: image.extent)
    }

    /// The colour mode: the colours as they are, grey, or black and white
    /// by one threshold (right once the paper has been evened out).
    static func colored(_ image: CIImage, mode: ScanColorMode) -> CIImage {
        switch mode {
        case .color:
            return image
        case .grey:
            let grey = CIFilter.colorControls()
            grey.inputImage = image
            grey.saturation = 0
            return grey.outputImage ?? image
        case .blackAndWhite:
            let grey = CIFilter.colorControls()
            grey.inputImage = image
            grey.saturation = 0
            let threshold = CIFilter.colorThreshold()
            threshold.inputImage = grey.outputImage
            threshold.threshold = 0.55
            return threshold.outputImage ?? image
        }
    }

    // MARK: - Rendering

    /// Every channel kept between 0 and 1.
    static func clamped(_ image: CIImage) -> CIImage {
        let clamp = CIFilter.colorClamp()
        clamp.inputImage = image
        clamp.minComponents = CIVector(x: 0, y: 0, z: 0, w: 0)
        clamp.maxComponents = CIVector(x: 1, y: 1, z: 1, w: 1)
        return clamp.outputImage ?? image
    }

    /// The picture drawn to pixels (sRGB, 8 bits), or nil when its extent is
    /// not a picture's.
    static func render(_ image: CIImage) -> CGImage? {
        let extent = image.extent.integral
        guard extent.width >= 1, extent.height >= 1, extent.width.isFinite, extent.height.isFinite,
              extent.width * extent.height < 60_000_000 else { return nil }
        return context.createCGImage(image, from: extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
    }

    /// The picture as a JPEG, for the PDF and for sharing.
    static func jpegData(_ image: CGImage, quality: CGFloat = 0.86) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    /// A picture read from a file (JPEG, PNG, HEIC, TIFF…), turned upright
    /// by its EXIF orientation, or nil for what is not a picture.
    static func loadImage(from url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return loadImage(from: source)
    }

    static func loadImage(from data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return loadImage(from: source)
    }

    private static func loadImage(from source: CGImageSource) -> CGImage? {
        guard CGImageSourceGetCount(source) > 0,
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            return nil
        }
        // Bounded: a hostile picture claiming a huge size is refused before
        // any pixel is drawn.
        guard image.width >= 16, image.height >= 16, image.width <= 12_000, image.height <= 12_000 else { return nil }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let orientation = (properties?[kCGImagePropertyOrientation] as? UInt32).flatMap(CGImagePropertyOrientation.init) ?? .up
        guard orientation != .up else { return image }
        let upright = CIImage(cgImage: image).oriented(orientation)
        return render(upright) ?? image
    }
}

/// A picture in shades of grey, row 0 at the top, for the measurements the
/// pipeline makes on the CPU: the slant of the lines, where a book's gutter
/// is, how bowed its lines are.
struct GreyBitmap {
    let width: Int
    let height: Int
    let data: [UInt8]
    /// How many source pixels one of these is across.
    let scale: CGFloat

    init?(_ image: CGImage, maxSide: CGFloat) {
        let longest = CGFloat(max(image.width, image.height))
        let scale = min(1, maxSide / longest)
        let width = max(1, Int((CGFloat(image.width) * scale).rounded()))
        let height = max(1, Int((CGFloat(image.height) * scale).rounded()))
        var data = [UInt8](repeating: 255, count: width * height)
        let ok = data.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                                          bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.interpolationQuality = .medium
            // A bitmap context's rows are stored top first, as the picture
            // is shown: row 0 is the top of the image.
            context.setFillColor(gray: 1, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard ok else { return nil }
        self.width = width
        self.height = height
        self.data = data
        self.scale = 1 / scale
    }

    init(width: Int, height: Int, data: [UInt8], scale: CGFloat = 1) {
        self.width = width
        self.height = height
        self.data = data
        self.scale = scale
    }

    subscript(x: Int, y: Int) -> UInt8 {
        data[y * width + x]
    }

    /// The grey level that best splits the page into ink and paper (Otsu).
    func otsu() -> UInt8 {
        var histogram = [Int](repeating: 0, count: 256)
        for v in data { histogram[Int(v)] += 1 }
        let total = data.count
        var sum = 0.0
        for level in 0..<256 { sum += Double(level * histogram[level]) }
        var below = 0
        var sumBelow = 0.0
        var best = 128
        var bestSpread = -1.0
        for level in 0..<256 {
            below += histogram[level]
            if below == 0 || below == total { continue }
            sumBelow += Double(level * histogram[level])
            let above = total - below
            let meanBelow = sumBelow / Double(below)
            let meanAbove = (sum - sumBelow) / Double(above)
            let spread = Double(below) * Double(above) * (meanBelow - meanAbove) * (meanBelow - meanAbove)
            if spread > bestSpread {
                bestSpread = spread
                best = level
            }
        }
        return UInt8(best)
    }

    /// The mean grey of each column.
    func columnMeans() -> [Double] {
        var means = [Double](repeating: 0, count: width)
        for y in 0..<height {
            let row = y * width
            for x in 0..<width { means[x] += Double(data[row + x]) }
        }
        return means.map { $0 / Double(height) }
    }
}
