@testable import PDFEditor
import XCTest

/// The arithmetic Edit PDF's overlays do before they ask the core for
/// anything: where a picture's unit square lands, what a handle dragged
/// does to it, and what a crop leaves showing. The same cases the desktop
/// proves (`packages/ui/src/edit/matrix.test.ts`), so the two hosts agree
/// about a file they can both open.
final class EditGeometryTests: XCTestCase {
    /// A picture 100 by 50 points at (10, 20) on the page as shown.
    private let upright: EditGeometry.Matrix = [100, 0, 0, -50, 10, 70]

    func testTheUnitSquareLandsWhereTheMatrixSays() {
        let corners = EditGeometry.corners(upright)
        XCTAssertEqual(corners[0].x, 10, accuracy: 0.001)
        XCTAssertEqual(corners[0].y, 70, accuracy: 0.001, "the bottom-left of the square is the bottom of the box")
        let box = EditGeometry.bounds(corners)
        XCTAssertEqual(box, CGRect(x: 10, y: 20, width: 100, height: 50))
    }

    func testUprightInABoxIsTheBoxAgain() {
        let rect = CGRect(x: 12, y: 34, width: 56, height: 78)
        XCTAssertEqual(EditGeometry.bounds(EditGeometry.corners(EditGeometry.upright(in: rect))), rect)
    }

    func testComposeAndInvertAreEachOthersUndoing() {
        let m: EditGeometry.Matrix = [2, 0.5, -0.25, 3, 7, 11]
        let inverse = try? XCTUnwrap(EditGeometry.invert(m))
        let back = EditGeometry.compose(m, inverse ?? m)
        XCTAssertEqual(back[0], 1, accuracy: 0.0001)
        XCTAssertEqual(back[3], 1, accuracy: 0.0001)
        XCTAssertEqual(back[4], 0, accuracy: 0.0001)
        XCTAssertEqual(back[5], 0, accuracy: 0.0001)
        XCTAssertNil(EditGeometry.invert([1, 2, 2, 4, 0, 0]), "a square flattened to a line cannot be dragged")
    }

    func testAHandleDraggedMovesItsOwnSideAndLeavesTheOpposite() {
        // The right-hand middle handle out to x = 210: twice as wide, same left.
        let wider = EditGeometry.resize(upright, clip: EditGeometry.full,
                                        handle: CGPoint(x: 1, y: 0.5), pointer: CGPoint(x: 210, y: 45),
                                        keepAspect: false)
        let box = EditGeometry.bounds(EditGeometry.corners(wider))
        XCTAssertEqual(box.minX, 10, accuracy: 0.001, "the far side stays")
        XCTAssertEqual(box.width, 200, accuracy: 0.001)
        XCTAssertEqual(box.height, 50, accuracy: 0.001, "and the other side is untouched")
    }

    func testAHandleDraggedWithProportionsKeptScalesBothSides() {
        let square = EditGeometry.resize(upright, clip: EditGeometry.full,
                                         handle: CGPoint(x: 1, y: 1), pointer: CGPoint(x: 210, y: 120),
                                         keepAspect: true)
        let box = EditGeometry.bounds(EditGeometry.corners(square))
        XCTAssertEqual(box.width / box.height, 2, accuracy: 0.001, "the picture's own proportions")
    }

    func testAHandleDraggedPastTheOppositeSideStopsAtAMinimum() {
        let squashed = EditGeometry.resize(upright, clip: EditGeometry.full,
                                           handle: CGPoint(x: 1, y: 0.5), pointer: CGPoint(x: -400, y: 45),
                                           keepAspect: false)
        let box = EditGeometry.bounds(EditGeometry.corners(squashed))
        XCTAssertGreaterThan(box.width, 0, "never inside out, never nothing")
        XCTAssertLessThan(box.width, 10)
    }

    func testCroppingTrimsTheSideThatWasDraggedAndLeavesThePictureWhereItIs() {
        let clip = EditGeometry.crop(upright, clip: EditGeometry.full,
                                     handle: CGPoint(x: 0, y: 0.5), pointer: CGPoint(x: 60, y: 45))
        XCTAssertEqual(clip[0], 0.5, accuracy: 0.001, "half the square is trimmed off the left")
        XCTAssertEqual(clip[2], 1, accuracy: 0.001)
        let box = EditGeometry.bounds(EditGeometry.corners(upright, clip: clip))
        XCTAssertEqual(box.minX, 60, accuracy: 0.001)
        XCTAssertEqual(box.width, 50, accuracy: 0.001)
    }

    func testCroppingNeverGoesOutsideThePictureOrInsideOut() {
        let clip = EditGeometry.crop(upright, clip: EditGeometry.full,
                                     handle: CGPoint(x: 0, y: 0.5), pointer: CGPoint(x: 900, y: 45))
        XCTAssertLessThan(clip[0], clip[2])
        XCTAssertGreaterThanOrEqual(clip[0], 0)
        XCTAssertLessThanOrEqual(clip[2], 1)
    }

    func testAQuarterTurnKeepsTheCentreAndSwapsTheSides() {
        let turned = EditGeometry.quarterTurn(upright)
        let before = EditGeometry.bounds(EditGeometry.corners(upright))
        let after = EditGeometry.bounds(EditGeometry.corners(turned))
        XCTAssertEqual(after.midX, before.midX, accuracy: 0.001)
        XCTAssertEqual(after.midY, before.midY, accuracy: 0.001)
        XCTAssertEqual(after.width, before.height, accuracy: 0.001)
        XCTAssertEqual(after.height, before.width, accuracy: 0.001)
        // Four turns are no turn at all.
        var round = upright
        for _ in 0..<4 { round = EditGeometry.quarterTurn(round) }
        XCTAssertEqual(EditGeometry.bounds(EditGeometry.corners(round)), before)
    }

    func testAPictureFitsInsideTheBoxItWasDraggedOutIn() {
        let box = CGRect(x: 0, y: 0, width: 200, height: 200)
        let wide = EditGeometry.fit(box, aspect: 2)
        XCTAssertEqual(wide, CGRect(x: 0, y: 50, width: 200, height: 100))
        let tall = EditGeometry.fit(box, aspect: 0.5)
        XCTAssertEqual(tall, CGRect(x: 50, y: 0, width: 100, height: 200))
    }

    func testALinkBoxIsMovedOrOneEdgeDragged() {
        let rect = CGRect(x: 10, y: 10, width: 100, height: 20)
        XCTAssertEqual(EditGeometry.drag(rect, handle: nil, dx: 5, dy: -3),
                       CGRect(x: 15, y: 7, width: 100, height: 20))
        XCTAssertEqual(EditGeometry.drag(rect, handle: CGPoint(x: 1, y: 0.5), dx: 20, dy: 0),
                       CGRect(x: 10, y: 10, width: 120, height: 20))
        XCTAssertEqual(EditGeometry.drag(rect, handle: CGPoint(x: 0, y: 0.5), dx: 20, dy: 0),
                       CGRect(x: 30, y: 10, width: 80, height: 20))
        // Dragged past the far edge: it stops, never inside out.
        let squashed = EditGeometry.drag(rect, handle: CGPoint(x: 0, y: 0.5), dx: 500, dy: 0)
        XCTAssertGreaterThanOrEqual(squashed.width, 4)
    }

    func testAHandleIsFoundOnlyNearItself() {
        let box = CGRect(x: 100, y: 100, width: 80, height: 40)
        XCTAssertEqual(EditGeometry.handle(at: CGPoint(x: 102, y: 98), of: box, tolerance: 10), CGPoint(x: 0, y: 0))
        XCTAssertEqual(EditGeometry.handle(at: CGPoint(x: 180, y: 140), of: box, tolerance: 10), CGPoint(x: 1, y: 1))
        XCTAssertNil(EditGeometry.handle(at: CGPoint(x: 140, y: 120), of: box, tolerance: 10), "the middle is a move")
    }

    func testTheRectangleBetweenTwoPointsIsTheSameEitherWayRound() {
        let a = CGPoint(x: 30, y: 10)
        let b = CGPoint(x: 10, y: 40)
        XCTAssertEqual(EditGeometry.between(a, b), CGRect(x: 10, y: 10, width: 20, height: 30))
        XCTAssertEqual(EditGeometry.between(b, a), EditGeometry.between(a, b))
    }

    func testNonsenseMatricesAreLeftAloneRatherThanCrashing() {
        XCTAssertEqual(EditGeometry.compose([1, 2], [3, 4]), [1, 2])
        XCTAssertNil(EditGeometry.invert([1, 2, 3]))
        XCTAssertEqual(EditGeometry.apply([], 4, 5), CGPoint(x: 4, y: 5))
        XCTAssertEqual(EditGeometry.bounds([]), .zero)
    }
}
