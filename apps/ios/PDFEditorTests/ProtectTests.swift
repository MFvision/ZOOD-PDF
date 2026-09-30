@testable import PDFEditor
import WarraqCore
import XCTest

/// Protecting: the core's AES-256 written over the document, kept by the core
/// on what it appends afterwards, asked for on reopening, and removed again —
/// with a password in Arabic, which is the reason this is no longer PDFKit's
/// RC4.
@MainActor
final class ProtectTests: XCTestCase {
    private var folder: URL!

    /// A password in Arabic, with Arabic-Indic digits: PDFKit's writer dropped
    /// every one of these bytes.
    private let arabicPassword = "كلمة السر ١٢٣"

    override func setUp() async throws {
        folder = try PartB.folder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testSetPasswordKeepItThroughAnEditAndRemoveIt() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let undo = UndoManager()
        try await Protect.setPassword("s3cret-1234", on: model, undoManager: undo)
        XCTAssertTrue(model.isEdited)
        XCTAssertEqual(model.password, "s3cret-1234")
        XCTAssertEqual(model.metadata?.encrypted, true)
        XCTAssertEqual(model.pdf?.isLocked, false, "PDFKit is unlocked in the app")

        // It is AES-256, not the RC4 PDFKit used to write.
        let status = await Protect.status(of: model.bytes)
        XCTAssertTrue(status.protected)
        XCTAssertEqual(status.method, "aes-256")
        XCTAssertEqual(status.keyBits, 256)
        XCTAssertFalse(status.isWeak, "AES-256 is not a weak protection")
        XCTAssertFalse(status.opensWithoutPassword, "the password is really needed")

        // Without the password the core refuses; with it, it reads.
        do {
            _ = try await Core.open(bytes: model.bytes)
            XCTFail("opened without a password")
        } catch let error as CoreError {
            XCTAssertEqual(error, .password)
        }
        let withPassword = try await Core.open(bytes: model.bytes, password: "s3cret-1234")
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
        await reopened.load(password: "s3cret-1234")
        XCTAssertEqual(reopened.state, .ready)
        XCTAssertEqual(reopened.pdf?.page(at: 0)?.rotation, 90)

        // Removed, it opens without one.
        try await Protect.removePassword(from: reopened, undoManager: undo)
        XCTAssertNil(reopened.password)
        let open = try await Core.open(bytes: reopened.bytes)
        let meta = try await open.metadata()
        XCTAssertFalse(meta.encrypted)
        XCTAssertFalse(await Protect.status(of: reopened.bytes).protected)
        XCTAssertEqual(reopened.pdf?.isLocked, false)
        reopened.close()
        model.close()
    }

    /// The whole point of the change: an Arabic password is written as typed
    /// and opens the file, and nothing near it does.
    func testAnArabicPasswordWorksAndOnlyThatPassword() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        XCTAssertTrue(Protect.isUsable(arabicPassword))
        try await Protect.setPassword(arabicPassword, on: model, undoManager: nil)
        XCTAssertEqual(model.password, arabicPassword)

        let opened = try await Core.open(bytes: model.bytes, password: arabicPassword)
        let text = try await opened.extractText(page: 0)
        XCTAssertTrue(text.contains("فاتورة"), "readable with the Arabic password")

        // A password one letter, one digit or one diacritic away is refused.
        for wrong in ["كلمة السر ١٢٤", "كلمة السر", "كَلمة السر ١٢٣", "كلمة السر 123", ""] {
            do {
                _ = try await Core.open(bytes: model.bytes, password: wrong)
                XCTFail("\(wrong) opened the document")
            } catch let error as CoreError {
                XCTAssertEqual(error, .password, "\(wrong) must be refused")
            }
        }
        model.close()
    }

    /// A document protected on this device opens on the desktop and the other
    /// way round, because both run the same core: the file the core writes
    /// here it reads there, and a file it wrote elsewhere — the corpus's
    /// AES-256 variant, written by another program altogether — opens here,
    /// is re-protected with an Arabic password, and still reads.
    func testAFileProtectedElsewhereOpensHereAndTheOtherWayRound() async throws {
        // Written by qpdf, not by us: AES-256, password "warraq".
        let elsewhere = try PartB.fixture("variant-encrypted-aes256")
        let status = await Protect.status(of: elsewhere)
        XCTAssertTrue(status.protected)
        XCTAssertEqual(status.method, "aes-256")

        let url = folder.appending(path: "from-elsewhere.pdf")
        try elsewhere.write(to: url)
        let model = try DocumentModel(url: url)
        await model.load(password: "warraq")
        XCTAssertEqual(model.state, .ready, "a file protected by another program opens")

        // Re-protected here with an Arabic password, it is still a file every
        // host can open — the core is the same on all of them.
        try await Protect.setPassword(arabicPassword, on: model, undoManager: nil)
        let reopened = try await Core.open(bytes: model.bytes, password: arabicPassword)
        XCTAssertGreaterThan(await reopened.pageCount, 0)
        do {
            _ = try await Core.open(bytes: model.bytes, password: "warraq")
            XCTFail("the old password still opens it")
        } catch let error as CoreError {
            XCTAssertEqual(error, .password)
        }
        model.close()
    }

    /// The old protections other programs wrote are named for what they are,
    /// so a person can be told their file is weakly protected — and replacing
    /// it makes it AES-256.
    func testAWeakProtectionIsNamedAndCanBeReplaced() async throws {
        let weak = try PartB.fixture("variant-encrypted-rc4-40")
        let status = await Protect.status(of: weak)
        XCTAssertTrue(status.protected)
        XCTAssertEqual(status.method, "rc4-40")
        XCTAssertEqual(status.keyBits, 40)
        XCTAssertTrue(status.isWeak, "40-bit RC4 is weak")
        XCTAssertEqual(status.methodName, "RC4 40-bit")

        let url = folder.appending(path: "weak.pdf")
        try weak.write(to: url)
        let model = try DocumentModel(url: url)
        await model.load(password: "warraq")
        XCTAssertEqual(model.state, .ready)
        try await Protect.setPassword(arabicPassword, on: model, undoManager: nil)
        let now = await Protect.status(of: model.bytes)
        XCTAssertEqual(now.method, "aes-256")
        XCTAssertFalse(now.isWeak)
        model.close()
    }

    /// The permissions a person chooses are written into the file and read
    /// back from it.
    func testThePermissionsAreWrittenAndReadBack() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        try await Protect.setPassword(
            "s3cret-1234",
            permissions: Protect.Permissions(print: true, copy: false, change: false),
            on: model,
            undoManager: nil
        )
        let permissions = try XCTUnwrap(await Protect.status(of: model.bytes).permissions)
        XCTAssertTrue(permissions.print, "printing was allowed")
        XCTAssertFalse(permissions.copy, "copying was not")
        XCTAssertFalse(permissions.change, "changing was not")
        model.close()
    }

    /// A password we cannot store is refused, and nothing changes.
    func testAPasswordWeCannotStoreIsRefused() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        XCTAssertFalse(Protect.isUsable(""), "an empty password is not a password")
        // 64 Arabic letters are 128 bytes: one past what the format holds.
        XCTAssertFalse(Protect.isUsable(String(repeating: "ك", count: 64)))
        XCTAssertTrue(Protect.isUsable(String(repeating: "ك", count: 63)), "63 letters fit")

        for bad in ["", String(repeating: "ك", count: 64)] {
            do {
                try await Protect.setPassword(bad, on: model, undoManager: nil)
                XCTFail("a password of \(bad.utf8.count) bytes was accepted")
            } catch {
                XCTAssertFalse(model.isEdited, "nothing changed")
                XCTAssertNil(model.password)
            }
        }
        model.close()
    }

    /// Taking protection off a document that has none says so rather than
    /// quietly rewriting the file.
    func testRemovingProtectionThatIsNotThereIsRefused() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        do {
            try await Protect.removePassword(from: model, undoManager: nil)
            XCTFail("removed protection that was not there")
        } catch {
            XCTAssertFalse(model.isEdited, "nothing changed")
        }
        model.close()
    }

    func testUndoBringsTheOldProtectionBack() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let undo = UndoManager()
        try await Protect.setPassword("abc", on: model, undoManager: undo)
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
