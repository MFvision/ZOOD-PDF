import CoreGraphics
import CoreImage
@testable import PDFEditor
import UIKit
import XCTest

/// The scanner's geometry, on pictures whose truth is known exactly: a page of
/// a known shape, photographed by a pinhole camera at a known angle, and every
/// pixel of the photograph laid down by this file's own projective mapping —
/// nothing of the pipeline's is used to make the picture it is then measured
/// on. Two things are held to: a page cut out of such a photograph comes back
/// **square**, with its corners still where they were, and it comes back at the
/// **page's own proportions**. Both were wrong on the owner's TestFlight scans.
final class ScanGeometryTests: XCTestCase {
    /// How far from a right angle a corrected page's corners may be. A
    /// perspective correction is exact arithmetic; what is left is the
    /// rasterizing of the synthetic photograph and the finding of the discs.
    private let squareTolerance = 1.5
    /// How far the corrected page's proportions may be from the page's own
    /// where the lens can be **solved for** — where both pairs of the page's
    /// edges converge, which is every photograph taken by hand. Core Image's
    /// own sizing of the corrected page is 3 % to 5 % out on the same
    /// photographs (measured, `docs/STATUS.md`), so this is the assertion the
    /// fix has to earn.
    private let solvedAspectTolerance = 0.02
    /// And where it cannot be solved for — a page tilted on one axis alone,
    /// its two vanishing points nearly the same — an ordinary phone lens is
    /// assumed and the answer is looser.
    private let assumedAspectTolerance = 0.15

    // MARK: - A page cut out of an angled photograph

    func testAnAngledPageComesBackSquareAndAtItsOwnProportions() throws {
        let page = PageArt(width: 1240, height: 1754)          // A4 at 150 dpi
        let photograph = CGSize(width: 1512, height: 2016)
        let camera = Camera(focal: 1700, image: photograph)
        let angles: [(name: String, tilt: Double, turn: Double, roll: Double)] = [
            ("square to the lens", 0, 0, 0),
            ("tilted 12° back", 12, 0, 0),
            ("tilted 28° back", 28, 0, 0),
            ("turned 22° sideways", 0, 22, 0),
            ("tilted 25° and turned 15°", 25, 15, 0),
            ("tilted 30°, turned 18°, rolled 7°", 30, 18, 7),
        ]
        for angle in angles {
            // Both axes turned: the corners give the lens away, and the page's
            // shape with it. One axis only: the lens has to be assumed.
            let solvable = angle.tilt != 0 && angle.turn != 0
            let tolerance = solvable ? solvedAspectTolerance : assumedAspectTolerance
            let quad = camera.shoot(page: page.millimetres, distance: 420, tiltX: angle.tilt, tiltY: angle.turn, roll: angle.roll)
            for corner in quad.points {
                XCTAssertTrue(CGRect(origin: .zero, size: photograph).insetBy(dx: 8, dy: 8).contains(corner),
                              "\(angle.name): the whole page is inside the photograph — \(corner)")
            }
            let shot = try XCTUnwrap(page.photographed(as: quad, on: photograph), "\(angle.name): the photograph is made")
            let cut = ScanPipeline.corrected(shot, quad: quad)
            let marks = try XCTUnwrap(PageArt.discs(in: cut), "\(angle.name): the page's four marks are found in the cut-out page")

            let worstCorner = marks.angles.map { abs($0 - 90) }.max() ?? 0
            let aspect = marks.width / marks.height
            let edges = quad.pageSize.width / quad.pageSize.height
            print("SCAN-GEOMETRY \(angle.name): corrected \(cut.width)x\(cut.height), corners off square by \(String(format: "%.2f", worstCorner))°, "
                  + "marks \(String(format: "%.4f", aspect)) against \(String(format: "%.4f", page.markAspect)) "
                  + "(\(String(format: "%+.1f", (aspect / page.markAspect - 1) * 100)) %), "
                  + "the edges alone would say \(String(format: "%+.1f", (edges / page.aspect - 1) * 100)) %")

            XCTAssertLessThan(worstCorner, squareTolerance,
                              "\(angle.name): the page's corners are square; the owner's scans had the top-left one high")
            XCTAssertEqual(aspect, page.markAspect, accuracy: page.markAspect * tolerance,
                           "\(angle.name): the page keeps its own proportions"
                           + (solvable ? " — the lens is solved for here, so this is exact" : ""))
            XCTAssertEqual(Double(cut.width) / Double(cut.height), page.aspect, accuracy: page.aspect * tolerance,
                           "\(angle.name): so does the picture it is drawn into")
            XCTAssertTrue(marks.topLeftIsLargest,
                          "\(angle.name): the mark that was in the page's top-left corner is still in the top-left corner")
        }
    }

    /// A card and a landscape page, so the method is not one tuned to A4.
    func testOtherShapesKeepTheirProportionsToo() throws {
        let photograph = CGSize(width: 1512, height: 2016)
        let camera = Camera(focal: 1700, image: photograph)
        for page in [PageArt(width: 1712, height: 1080), PageArt(width: 1754, height: 1240)] {
            let quad = camera.shoot(page: page.millimetres, distance: 420, tiltX: 26, tiltY: 16, roll: 4)
            let shot = try XCTUnwrap(page.photographed(as: quad, on: photograph))
            let cut = ScanPipeline.corrected(shot, quad: quad)
            let marks = try XCTUnwrap(PageArt.discs(in: cut))
            print("SCAN-GEOMETRY \(page.width)x\(page.height): corrected \(cut.width)x\(cut.height), "
                  + "marks \(String(format: "%.4f", marks.width / marks.height)) against \(String(format: "%.4f", page.markAspect))")
            XCTAssertEqual(marks.width / marks.height, page.markAspect, accuracy: page.markAspect * solvedAspectTolerance)
            XCTAssertLessThan(marks.angles.map { abs($0 - 90) }.max() ?? 0, squareTolerance)
        }
    }

    // MARK: - The proportions themselves

    /// What the corners can and cannot say about a page's shape, and why the
    /// edges' own lengths are not the answer.
    func testPageAspectReadsTheShapeTheEdgeLengthsCannot() {
        let photograph = CGSize(width: 1512, height: 2016)
        let camera = Camera(focal: 1700, image: photograph)
        let a4 = CGSize(width: 210, height: 297)
        let truth = 210.0 / 297.0
        for (name, tilt, turn) in [("square to the lens", 0.0, 0.0), ("tilted 12°", 12.0, 0.0), ("tilted 28°", 28.0, 0.0),
                                   ("turned 22°", 0.0, 22.0), ("tilted 25° turned 15°", 25.0, 15.0)] {
            let quad = camera.shoot(page: a4, distance: 420, tiltX: tilt, tiltY: turn, roll: 0)
            let edges = Double(quad.pageSize.width / quad.pageSize.height)
            guard let recovered = ScanPipeline.pageAspect(of: quad, in: photograph) else {
                return XCTFail("\(name): the corners say nothing about the page's shape")
            }
            print("SCAN-ASPECT \(name): edges \(String(format: "%.4f", edges)) (\(String(format: "%+.1f", (edges / truth - 1) * 100)) %), "
                  + "recovered \(String(format: "%.4f", Double(recovered))) (\(String(format: "%+.1f", (Double(recovered) / truth - 1) * 100)) %)")
            XCTAssertEqual(Double(recovered), truth, accuracy: truth * assumedAspectTolerance, "\(name)")
            if tilt != 0 || turn != 0 {
                XCTAssertLessThan(abs(Double(recovered) / truth - 1), abs(edges / truth - 1),
                                  "\(name): nearer the page's real shape than the edges' own lengths are")
            }
        }
    }

    /// Vision's corners are a few pixels out. Where a page is tilted on one
    /// axis only, its two vanishing points are nearly the same and the lens
    /// cannot be solved for from them — `minimumConvergence` is what keeps a
    /// pixel of noise from being read as a page of another shape.
    func testNoisyCornersDoNotThrowTheShapeOff() {
        let photograph = CGSize(width: 1512, height: 2016)
        let camera = Camera(focal: 1700, image: photograph)
        let a4 = CGSize(width: 210, height: 297)
        let truth = 210.0 / 297.0
        var generator = SeededGenerator(seed: 0x5CA7)
        for (name, tilt, turn) in [("tilted 25° turned 15°", 25.0, 15.0), ("tilted 25° only", 25.0, 0.0), ("square to the lens", 0.0, 0.0)] {
            var worst = 0.0
            var worstEdges = 0.0
            for _ in 0..<200 {
                var quad = camera.shoot(page: a4, distance: 420, tiltX: tilt, tiltY: turn, roll: 0)
                for corner in 0..<4 {
                    quad[corner].x += CGFloat(generator.next(in: -4...4))
                    quad[corner].y += CGFloat(generator.next(in: -4...4))
                }
                guard let recovered = ScanPipeline.pageAspect(of: quad, in: photograph) else { continue }
                worst = max(worst, abs(Double(recovered) / truth - 1))
                worstEdges = max(worstEdges, abs(Double(quad.pageSize.width / quad.pageSize.height) / truth - 1))
            }
            print("SCAN-ASPECT noise, \(name): worst \(String(format: "%.1f", worst * 100)) % against the edges' \(String(format: "%.1f", worstEdges * 100)) %")
            XCTAssertLessThan(worst, 0.25, "\(name): ±4 px on every corner never moves the shape by a quarter")
        }
    }

    /// Corners that are not a page: nothing is guessed from them, and nothing
    /// in the pipeline divides by their zero.
    func testCornersThatAreNotAPageAreRefused() {
        let size = CGSize(width: 1000, height: 1000)
        // Three corners in a line. `corrected` never sees such a quad — the
        // handles refuse it and so does the pipeline — and this is why.
        let flattened = Quad(topLeft: CGPoint(x: 100, y: 100), topRight: CGPoint(x: 500, y: 100),
                             bottomRight: CGPoint(x: 900, y: 100), bottomLeft: CGPoint(x: 100, y: 900))
        XCTAssertFalse(flattened.isConvex, "a quad with three corners in a line is not a page")
        XCTAssertEqual(ScanPipeline.corrected(PageArt(width: 200, height: 200).image()!, quad: flattened).width, 200,
                       "and the picture comes back as it was")
        // A sliver, 49 times as wide as it is tall: convex, but not a page's
        // shape, so nothing is said about its proportions.
        let sliver = Quad(topLeft: CGPoint(x: 10, y: 490), topRight: CGPoint(x: 990, y: 490),
                          bottomRight: CGPoint(x: 990, y: 510), bottomLeft: CGPoint(x: 10, y: 510))
        XCTAssertTrue(sliver.isConvex)
        XCTAssertNil(ScanPipeline.pageAspect(of: sliver, in: size))
        XCTAssertEqual(ScanPipeline.correctedSize(of: sliver, in: size), sliver.pageSize,
                       "without proportions, the edges' own lengths stand")
        // Two corners in the same place: nothing at all.
        let pinched = Quad(topLeft: CGPoint(x: 100, y: 100), topRight: CGPoint(x: 100, y: 100),
                           bottomRight: CGPoint(x: 900, y: 900), bottomLeft: CGPoint(x: 100, y: 900))
        XCTAssertNil(ScanPipeline.pageAspect(of: pinched, in: size))
        // And a page with no corners taken off it keeps its own size.
        XCTAssertEqual(ScanPipeline.correctedSize(of: .whole(size), in: size).width, 1000, accuracy: 1)
    }

    // MARK: - A page the camera has already cut out

    /// VisionKit's document camera hands back the page, not the photograph. The
    /// session must leave it alone: the pixels it saves are the pixels the
    /// camera gave it, and its corners are the picture's own.
    func testAPageFromTheDocumentCameraIsNotCutOutAgain() async throws {
        let page = PageArt(width: 1240, height: 1754)
        let alreadyCut = try XCTUnwrap(page.image())
        let session = await ScanSession(mode: .document)
        await session.add(images: [alreadyCut], origin: .documentCamera)
        let first = await MainActor.run { session.pages.first }
        let taken = try XCTUnwrap(first)
        XCTAssertEqual(taken.origin, .documentCamera)
        XCTAssertEqual(taken.quad, .whole(CGSize(width: 1240, height: 1754)), "the corners are the picture's own")
        let cut = ScanPipeline.corrected(taken.original, quad: taken.quad)
        XCTAssertEqual(cut.width, 1240, "not one pixel of it was moved")
        XCTAssertEqual(cut.height, 1754)
        let marks = try XCTUnwrap(PageArt.discs(in: cut))
        XCTAssertLessThan(marks.angles.map { abs($0 - 90) }.max() ?? 0, squareTolerance)
        XCTAssertEqual(marks.width / marks.height, page.markAspect, accuracy: page.markAspect * 0.02)

        // "Auto" asks again; on a camera's page there is nothing to ask.
        await session.findQuad(for: taken.id)
        let asked = await MainActor.run { session.pages.first }
        let after = try XCTUnwrap(asked)
        XCTAssertEqual(after.quad, .whole(CGSize(width: 1240, height: 1754)))
    }

    /// The detector is the thing that must not run. On `page-crooked.jpg` —
    /// a page on a desk — Vision finds the page on this simulator, so the two
    /// paths are told apart by the same picture: as a photograph it is cut out,
    /// as a page from the camera it is left alone.
    func testTheDetectorIsNotRunOnAPageFromTheCamera() async throws {
        let url = try XCTUnwrap(Bundle(for: ScanGeometryTests.self).url(forResource: "page-crooked", withExtension: "jpg"),
                                "page-crooked.jpg is in the test bundle")
        let photograph = try XCTUnwrap(ScanPipeline.loadImage(from: url))
        let whole = Quad.whole(CGSize(width: photograph.width, height: photograph.height))

        let fromPhotos = await ScanSession(mode: .document)
        await fromPhotos.add(images: [photograph], origin: .picture)
        let detected = await MainActor.run { fromPhotos.pages.first }
        let found = try XCTUnwrap(detected)
        XCTAssertNotEqual(found.quad, whole, "the page was found in the photograph: \(ScanGeometry.describe(found.quad))")

        let fromCamera = await ScanSession(mode: .document)
        await fromCamera.add(images: [photograph], origin: .documentCamera)
        let untouched = await MainActor.run { fromCamera.pages.first }
        let taken = try XCTUnwrap(untouched)
        XCTAssertEqual(taken.quad, whole,
                       "the same picture from the document camera is left as it is, because VisionKit has already cut it out: "
                       + ScanGeometry.describe(taken.quad))
        XCTAssertEqual(ScanPipeline.corrected(taken.original, quad: taken.quad).width, photograph.width)
    }

    /// Why that matters, in numbers. A page that has already been cut out has
    /// no surroundings for a detector to measure it against; the corners the
    /// document-segmentation model answered for the owner's scans were nothing
    /// like the page's, and correcting by them bends a page that was straight.
    /// This is the shape of the bug the test above prevents.
    func testCorrectingAnAlreadyCutPageByADetectorsCornersBendsIt() throws {
        let page = PageArt(width: 1240, height: 1754)
        let alreadyCut = try XCTUnwrap(page.image())
        // What `VNDetectDocumentSegmentationRequest` answered (confidence 0.67)
        // for a picture that was already the page, recorded from a run of the
        // detector on this fixture.
        let asDetected = Quad(topLeft: CGPoint(x: 180, y: 630), topRight: CGPoint(x: 1240, y: 20),
                              bottomRight: CGPoint(x: 1231, y: 1754), bottomLeft: CGPoint(x: 8, y: 1747))
        let bent = ScanPipeline.corrected(alreadyCut, quad: asDetected)
        let marks = PageArt.discs(in: bent)
        let square = marks.map { ($0.angles.map { abs($0 - 90) }.max() ?? 0) < squareTolerance } ?? false
        let shaped = marks.map { abs(($0.width / $0.height) / page.markAspect - 1) < assumedAspectTolerance } ?? false
        print("SCAN-GEOMETRY an already-cut page corrected again by a detector's corners: \(bent.width)x\(bent.height) "
              + "(the page was \(page.width)x\(page.height)); "
              + (marks.map { "corners off square by \(String(format: "%.2f", $0.angles.map { abs($0 - 90) }.max() ?? 0))°, "
                             + "marks \(String(format: "%.4f", $0.width / $0.height)) against \(String(format: "%.4f", page.markAspect))" }
                 ?? "one of the page's four marks was cut away altogether"))
        XCTAssertFalse(square && shaped,
                       "this is what the owner saw: a page that was already straight comes back bent, or with part of it gone")
    }
}

// MARK: - The pictures, made here

/// A page with four round marks at known places — the top-left one twice the
/// size of the others, so the page cannot be read upside down or mirrored —
/// and rules across its middle, like lines of text.
struct PageArt {
    let width: Int
    let height: Int

    /// Where the marks' centres are, as fractions of the page, clockwise from
    /// the top-left, and how big each is as a fraction of the shorter side.
    static let markPlaces: [(u: CGFloat, v: CGFloat, r: CGFloat)] = [
        (0.25, 0.20, 0.055), (0.75, 0.20, 0.032), (0.75, 0.80, 0.032), (0.25, 0.80, 0.032),
    ]

    var aspect: Double { Double(width) / Double(height) }
    /// The rectangle the four marks make: half the page across, three fifths down.
    var markAspect: Double { 0.50 * Double(width) / (0.60 * Double(height)) }
    /// The page in millimetres, for the camera: the same shape, at the size of
    /// real paper, so a photograph of it from half a metre away holds it all.
    var millimetres: CGSize {
        let scale = 297 / Double(max(width, height))
        return CGSize(width: Double(width) * scale, height: Double(height) * scale)
    }

    /// The page's own pixels, grey, row 0 at the top.
    func pixels() -> [UInt8] {
        var data = [UInt8](repeating: 255, count: width * height)
        let thickness = max(2, min(width, height) / 200)
        var y = Int(Double(height) * 0.36)
        while y < Int(Double(height) * 0.64) {
            for row in 0..<thickness {
                for x in Int(Double(width) * 0.15)..<Int(Double(width) * 0.85) where y + row < height {
                    data[(y + row) * width + x] = 0
                }
            }
            y += Int(Double(height) * 0.03)
        }
        for place in Self.markPlaces {
            let cx = CGFloat(width) * place.u, cy = CGFloat(height) * place.v
            let radius = CGFloat(min(width, height)) * place.r
            let box = Int(radius) + 2
            for y in max(0, Int(cy) - box)..<min(height, Int(cy) + box) {
                for x in max(0, Int(cx) - box)..<min(width, Int(cx) + box)
                where hypot(CGFloat(x) - cx, CGFloat(y) - cy) < radius {
                    data[y * width + x] = 0
                }
            }
        }
        return data
    }

    func image() -> CGImage? {
        Self.greyImage(pixels(), width: width, height: height)
    }

    /// A photograph in which the page lies inside `quad`: every pixel of it
    /// mapped back through the projection by this file's own arithmetic, so
    /// nothing of the pipeline's took part in making what the pipeline is
    /// measured on.
    func photographed(as quad: Quad, on size: CGSize, desk: UInt8 = 140) -> CGImage? {
        let art = pixels()
        let across = Int(size.width), down = Int(size.height)
        let corners = [CGPoint(x: 0, y: 0), CGPoint(x: width, y: 0), CGPoint(x: width, y: height), CGPoint(x: 0, y: height)]
        guard let backwards = Projection(from: quad.points, to: corners) else { return nil }
        var data = [UInt8](repeating: desk, count: across * down)
        for y in 0..<down {
            for x in 0..<across {
                let p = backwards.map(CGPoint(x: CGFloat(x) + 0.5, y: CGFloat(y) + 0.5))
                let sx = Int(p.x.rounded(.down)), sy = Int(p.y.rounded(.down))
                guard sx >= 0, sy >= 0, sx < width, sy < height else { continue }
                data[y * across + x] = art[sy * width + sx]
            }
        }
        return Self.greyImage(data, width: across, height: down)
    }

    static func greyImage(_ data: [UInt8], width: Int, height: Int) -> CGImage? {
        guard let provider = CGDataProvider(data: Data(data) as CFData) else { return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
                       space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    /// The four marks found again in a picture: the four largest round blobs of
    /// ink, clockwise from the top-left.
    struct Marks {
        let centres: [CGPoint]
        let areas: [Int]

        /// The angle at each corner of the rectangle they make, in degrees.
        var angles: [Double] {
            (0..<4).map { index in
                let before = centres[(index + 3) % 4], here = centres[index], after = centres[(index + 1) % 4]
                let a = CGVector(dx: before.x - here.x, dy: before.y - here.y)
                let b = CGVector(dx: after.x - here.x, dy: after.y - here.y)
                let cosine = Double((a.dx * b.dx + a.dy * b.dy) / (hypot(a.dx, a.dy) * hypot(b.dx, b.dy)))
                return acos(min(max(cosine, -1), 1)) * 180 / .pi
            }
        }

        var width: Double {
            Double((hypot(centres[1].x - centres[0].x, centres[1].y - centres[0].y)
                    + hypot(centres[2].x - centres[3].x, centres[2].y - centres[3].y)) / 2)
        }

        var height: Double {
            Double((hypot(centres[3].x - centres[0].x, centres[3].y - centres[0].y)
                    + hypot(centres[2].x - centres[1].x, centres[2].y - centres[1].y)) / 2)
        }

        /// The page's top-left mark is the big one; if it is still the big one
        /// in the top-left, the corners were not shuffled or flipped.
        var topLeftIsLargest: Bool { areas[0] == areas.max() }
    }

    static func discs(in image: CGImage) -> Marks? {
        guard let grey = GreyBitmap(image, maxSide: 4000) else { return nil }
        var seen = [Bool](repeating: false, count: grey.width * grey.height)
        var blobs: [(centre: CGPoint, area: Int, across: Int, down: Int)] = []
        for start in 0..<(grey.width * grey.height) where !seen[start] && grey.data[start] < 100 {
            var stack = [start]
            seen[start] = true
            var sumX = 0, sumY = 0, count = 0
            var minX = grey.width, maxX = 0, minY = grey.height, maxY = 0
            while let here = stack.popLast() {
                let x = here % grey.width, y = here / grey.width
                sumX += x; sumY += y; count += 1
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let nx = x + dx, ny = y + dy
                    guard nx >= 0, ny >= 0, nx < grey.width, ny < grey.height else { continue }
                    let neighbour = ny * grey.width + nx
                    if !seen[neighbour], grey.data[neighbour] < 100 {
                        seen[neighbour] = true
                        stack.append(neighbour)
                    }
                }
            }
            blobs.append((CGPoint(x: CGFloat(sumX) / CGFloat(count), y: CGFloat(sumY) / CGFloat(count)),
                          count, maxX - minX + 1, maxY - minY + 1))
        }
        // The marks are round; the rules are wide and thin.
        let round = blobs.filter { $0.area > 40 && Double($0.across) / Double($0.down) > 0.6 && Double($0.across) / Double($0.down) < 1.6 }
        let four = Array(round.sorted { $0.area > $1.area }.prefix(4))
        guard four.count == 4 else { return nil }
        let topLeft = four.min { $0.centre.x + $0.centre.y < $1.centre.x + $1.centre.y }!
        let bottomRight = four.max { $0.centre.x + $0.centre.y < $1.centre.x + $1.centre.y }!
        let rest = four.filter { $0.centre != topLeft.centre && $0.centre != bottomRight.centre }
        guard rest.count == 2 else { return nil }
        let topRight = rest.max { $0.centre.x - $0.centre.y < $1.centre.x - $1.centre.y }!
        let bottomLeft = rest.min { $0.centre.x - $0.centre.y < $1.centre.x - $1.centre.y }!
        let ordered = [topLeft, topRight, bottomRight, bottomLeft]
        return Marks(centres: ordered.map(\.centre), areas: ordered.map(\.area))
    }
}

/// A pinhole camera: its focal length in pixels, its centre in the middle of
/// the picture. `shoot` answers where the four corners of a page land when the
/// page is turned in its own plane and tilted away from the lens.
struct Camera {
    let focal: Double
    let image: CGSize

    func shoot(page: CGSize, distance: Double, tiltX: Double, tiltY: Double, roll: Double) -> Quad {
        let halfWidth = Double(page.width) / 2, halfHeight = Double(page.height) / 2
        let corners = [(-halfWidth, -halfHeight), (halfWidth, -halfHeight), (halfWidth, halfHeight), (-halfWidth, halfHeight)]
        let aroundZ = roll * .pi / 180, aroundX = tiltX * .pi / 180, aroundY = tiltY * .pi / 180
        let u0 = Double(image.width) / 2, v0 = Double(image.height) / 2
        let placed = corners.map { corner -> CGPoint in
            var (x, y, z) = (corner.0, corner.1, 0.0)
            (x, y) = (x * cos(aroundZ) - y * sin(aroundZ), x * sin(aroundZ) + y * cos(aroundZ))
            (y, z) = (y * cos(aroundX) - z * sin(aroundX), y * sin(aroundX) + z * cos(aroundX))
            (x, z) = (x * cos(aroundY) + z * sin(aroundY), -x * sin(aroundY) + z * cos(aroundY))
            let away = z + distance
            return CGPoint(x: focal * x / away + u0, y: focal * y / away + v0)
        }
        return Quad(topLeft: placed[0], topRight: placed[1], bottomRight: placed[2], bottomLeft: placed[3])
    }
}

/// The projective mapping taking four points to four others, solved by
/// elimination — the test's own arithmetic, owing nothing to Core Image.
struct Projection {
    private let m: [Double]

    init?(from: [CGPoint], to: [CGPoint]) {
        guard from.count == 4, to.count == 4 else { return nil }
        var rows = [[Double]](repeating: [Double](repeating: 0, count: 9), count: 8)
        for i in 0..<4 {
            let x = Double(from[i].x), y = Double(from[i].y)
            let u = Double(to[i].x), v = Double(to[i].y)
            rows[2 * i] = [x, y, 1, 0, 0, 0, -u * x, -u * y, u]
            rows[2 * i + 1] = [0, 0, 0, x, y, 1, -v * x, -v * y, v]
        }
        for column in 0..<8 {
            var pivot = column
            for row in column..<8 where abs(rows[row][column]) > abs(rows[pivot][column]) { pivot = row }
            guard abs(rows[pivot][column]) > 1e-12 else { return nil }
            rows.swapAt(column, pivot)
            let leading = rows[column][column]
            for c in column...8 { rows[column][c] /= leading }
            for row in 0..<8 where row != column {
                let factor = rows[row][column]
                if factor == 0 { continue }
                for c in column...8 { rows[row][c] -= factor * rows[column][c] }
            }
        }
        m = (0..<8).map { rows[$0][8] } + [1]
    }

    func map(_ point: CGPoint) -> CGPoint {
        let x = Double(point.x), y = Double(point.y)
        let w = m[6] * x + m[7] * y + m[8]
        return CGPoint(x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w)
    }
}

/// The same noise every run, so a failure is one anyone can look at again.
struct SeededGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
    }

    mutating func next(in range: ClosedRange<Double>) -> Double {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        let unit = Double(state >> 11) / Double(UInt64(1) << 53)
        return range.lowerBound + unit * (range.upperBound - range.lowerBound)
    }
}
