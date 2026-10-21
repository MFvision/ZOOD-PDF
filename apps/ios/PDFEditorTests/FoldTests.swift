@testable import PDFEditor
import XCTest

/// iPhone Duo: what a document's screen has open outlives the copy of the
/// screen a fold or an unfold replaces, and is let go with the document;
/// the book layout joins the layouts without moving the stored ones.
@MainActor
final class FoldTests: XCTestCase {
    func testTheCopyAfterAFoldFindsWhatTheFirstHadOpen() {
        let model = DocumentModel(bytes: Data("%PDF-1.7".utf8), name: "fold")
        // The first copy of the screen (the outer screen's stack).
        let outer = model.screen
        outer.editing = true
        outer.showingExport = true
        // The copy the unfolded screen's split view makes.
        let inner = model.screen
        XCTAssertTrue(inner === outer, "both copies share one screen state")
        XCTAssertTrue(inner.editing, "Edit PDF stays open across the fold")
        XCTAssertTrue(inner.showingExport, "the sheet that was up comes back up")
    }

    func testAClosedDocumentsScreenIsLetGo() {
        let model = DocumentModel(bytes: Data("%PDF-1.7".utf8), name: "closed")
        var held: DocumentScreen? = model.screen
        weak var gone = held
        held?.markup = true
        held = nil
        XCTAssertNil(gone, "the model does not keep a screen no view holds")
        XCTAssertFalse(model.screen.markup, "a document opened again starts clean")
    }

    func testTheBookLayoutKeepsTheStoredLayouts() {
        XCTAssertEqual(PageLayout.allCases.map(\.rawValue), ["continuous", "single", "book"])
        XCTAssertEqual(PageLayout(rawValue: "continuous"), .continuous, "what an earlier version stored still reads")
        XCTAssertEqual(PageLayout(rawValue: "single"), .single)
    }
}
