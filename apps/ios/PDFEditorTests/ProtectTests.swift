@testable import PDFEditor
import WarraqCore
import XCTest

/// Protecting: a password set through PDFKit, kept by the core on what it
/// appends, asked for on reopening, and removed again.
@MainActor
final class ProtectTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = try PartB.folder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testSetPasswordKeepItThroughAnEditAndRemoveIt() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let undo = UndoManager()
        try await ProtectSheet.setPassword("سر-1234", on: model, undoManager: undo)
        XCTAssertTrue(model.isEdited)
        XCTAssertEqual(model.password, "سر-1234")
        XCTAssertEqual(model.metadata?.encrypted, true)
        XCTAssertEqual(model.pdf?.isLocked, false, "PDFKit is unlocked in the app")

        // Without the password the core refuses; with it, it reads.
        do {
            _ = try await Core.open(bytes: model.bytes)
            XCTFail("opened without a password")
        } catch let error as CoreError {
            XCTAssertEqual(error, .password)
        }
        let withPassword = try await Core.open(bytes: model.bytes, password: "سر-1234")
        let text = try await withPassword.extractText(page: 0)
        XCTAssertTrue(text.contains("فاتورة"), "still readable: \(text.prefix(40))")

        // An edit the core appends keeps the protection.
        let protectedBytes = model.bytes
        struct Rotate: Encodable { let pages: [Int]; let quarterTurns: Int }
        try await model.apply("pages.rotate", args: Rotate(pages: [0], quarterTurns: 1), undoManager: undo)
        XCTAssertTrue(model.bytes.starts(with: protectedBytes), "an incremental update on the protected file")
        do {
            _ = try await Core.open(bytes: model.bytes)
            XCTFail("the edit dropped the protection")
        } catch let error as CoreError {
            XCTAssertEqual(error, .password)
        }

        // Saved, it asks for its password when opened again.
        try await model.save()
        let reopened = try DocumentModel(url: try XCTUnwrap(model.url))
        await reopened.load()
        XCTAssertEqual(reopened.state, .needsPassword(wrong: false))
        await reopened.load(password: "سر-1234")
        XCTAssertEqual(reopened.state, .ready)
        XCTAssertEqual(reopened.pdf?.page(at: 0)?.rotation, 90)

        // Removed, it opens without one.
        try await ProtectSheet.removePassword(from: reopened, undoManager: undo)
        XCTAssertNil(reopened.password)
        let open = try await Core.open(bytes: reopened.bytes)
        let meta = try await open.metadata()
        XCTAssertFalse(meta.encrypted)
        XCTAssertEqual(reopened.pdf?.isLocked, false)
        reopened.close()
        model.close()
    }

    func testUndoBringsTheOldProtectionBack() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let undo = UndoManager()
        try await ProtectSheet.setPassword("abc", on: model, undoManager: undo)
        XCTAssertEqual(model.password, "abc")
        undo.undo()
        XCTAssertNil(model.password)
        XCTAssertFalse(model.isEdited)
        undo.redo()
        XCTAssertEqual(model.password, "abc")
        XCTAssertTrue(model.isEdited)
        model.close()
    }
}
