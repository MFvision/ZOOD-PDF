@testable import PDFEditor
import PDFKit
import WarraqCore
import XCTest

/// Edit PDF: the text already on a page edited in place, a line added where
/// a finger lands, the pictures and the links — every one through the core
/// on a real corpus file, and the Arabic read back afterwards in logical
/// order from the bytes that were saved.
@MainActor
final class EditTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = try PartB.folder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// Waits for the change the editor started; fails on what it reported.
    private func settle(_ edit: EditModel, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date(timeIntervalSinceNow: 30)
        while edit.working {
            if Date() > deadline { throw XCTSkip("the editor did not settle") }
            try await Task.sleep(for: .milliseconds(30))
        }
        XCTAssertNil(edit.error, "\(String(describing: edit.error))", file: file, line: line)
    }

    // MARK: - Editing the text that is there

    func testAParagraphIsReplacedShapedAndReadsBackAfterSaving() async throws {
        let model = try await PartB.loadedModel("chrome-notonaskh-justified-3pages", in: folder)
        let original = model.bytes
        let edit = EditModel(model: model)
        edit.undoManager = UndoManager()
        await edit.read(page: 0)
        let paragraphs = try XCTUnwrap(edit.paragraphs(onPage: 0))
        XCTAssertFalse(paragraphs.isEmpty, "the core finds paragraphs to edit on the first page")

        // The longest paragraph: replacing a long one with a short one is
        // the change that must not spill over the page.
        let paragraph = try XCTUnwrap(paragraphs.max { $0.text.count < $1.text.count })
        XCTAssertTrue(paragraph.isRightToLeft, "this document's paragraphs read right to left")

        let replacement = "نصٌّ عربيٌّ جديدٌ بالتشكيل"
        edit.begin(editing: paragraph, onPage: 0)
        XCTAssertEqual(edit.draft, paragraph.text, "the field starts from what the core read")
        edit.draft = replacement
        await edit.commit()
        try await settle(edit)
        XCTAssertNil(edit.editing, "the field closes once the change is made")
        XCTAssertEqual(edit.edits, 1)

        XCTAssertTrue(model.bytes.starts(with: original),
                      "an incremental update: the original bytes are still the prefix")

        // Saved, closed and opened again: the core reads the new text from
        // the file itself, in logical order and with its tashkeel.
        try await model.save()
        let reopened = try DocumentModel(url: try XCTUnwrap(model.url))
        await reopened.load()
        XCTAssertEqual(reopened.state, .ready)
        let text = try await PartB.text(of: reopened, page: 0)
        XCTAssertTrue(text.contains(replacement),
                      "the Arabic reads back exactly as it was typed, in logical order: \(text.prefix(200))")
        XCTAssertFalse(text.contains(paragraph.text), "and what it replaced is gone")
    }

    // MARK: - The font an edit is drawn in

    /// The bytes as text, to look for a font's name in them.
    private func latin(_ data: Data) -> String {
        String(decoding: data, as: Unicode.Latin1.self)
    }

    func testAutomaticDrawsNewTextInTheDocumentsOwnFont() async throws {
        // One line, "Meeting Intelligence quarterly", in an embedded subset
        // the file calls Montserrat SemiBold: those letters and no others.
        let model = try await PartB.loadedModel("own-font-subset", in: folder)
        let edit = EditModel(model: model)
        edit.undoManager = UndoManager()
        XCTAssertTrue(edit.automaticFont, "the font control starts on Automatic")
        await edit.read(page: 0)
        let paragraph = try XCTUnwrap(edit.paragraphs(onPage: 0)?.first)
        XCTAssertEqual(paragraph.fontFamily, "Montserrat")
        XCTAssertEqual(paragraph.fontWeight, 600)
        XCTAssertEqual(paragraph.fontClass, "sans")
        XCTAssertEqual(paragraph.ownFont, true)

        edit.begin(editing: paragraph, onPage: 0)
        edit.draft = "Meeting gently"
        await edit.commit()
        try await settle(edit)
        XCTAssertNil(edit.notice, "nothing was substituted, so nothing is said")
        let text = try await PartB.text(of: model, page: 0)
        XCTAssertEqual(text.trimmingCharacters(in: .whitespacesAndNewlines), "Meeting gently")
        // A font embedded by the app is named WARRAQ+…; there is none.
        XCTAssertFalse(latin(model.bytes).contains("WARRAQ+"), "no font was added: the paragraph's own drew it")
    }

    func testAutomaticFallsToTheClosestFaceWhenALetterIsMissingAndSaysSo() async throws {
        let model = try await PartB.loadedModel("own-font-subset", in: folder)
        let edit = EditModel(model: model)
        edit.undoManager = UndoManager()
        await edit.read(page: 0)
        let paragraph = try XCTUnwrap(edit.paragraphs(onPage: 0)?.first)
        edit.begin(editing: paragraph, onPage: 0)
        // No b, o or x in the document's subset.
        edit.draft = "Meeting box"
        XCTAssertEqual(edit.closestFace, .inter, "a Latin sans: Inter, not the Naskh every edit used to come back in")
        await edit.commit()
        try await settle(edit)
        XCTAssertNotNil(edit.notice, "the person is told which font was used")
        let text = try await PartB.text(of: model, page: 0)
        XCTAssertEqual(text.trimmingCharacters(in: .whitespacesAndNewlines), "Meeting box")
        let bytes = latin(model.bytes)
        XCTAssertTrue(bytes.contains("WARRAQ+Inter"), "Inter was embedded for it")
        XCTAssertFalse(bytes.contains("WARRAQ+Amiri"))
    }

    func testAChosenFaceOverridesAutomatic() async throws {
        let model = try await PartB.loadedModel("own-font-subset", in: folder)
        let edit = EditModel(model: model)
        edit.font = .amiri
        XCTAssertFalse(edit.automaticFont, "choosing a face turns Automatic off")
        await edit.read(page: 0)
        let paragraph = try XCTUnwrap(edit.paragraphs(onPage: 0)?.first)
        edit.begin(editing: paragraph, onPage: 0)
        edit.draft = "Meeting gently"
        await edit.commit()
        try await settle(edit)
        XCTAssertTrue(latin(model.bytes).contains("WARRAQ+Amiri"), "the chosen face was embedded")
    }

    func testTheClosestFaceFollowsTheParagraphsFaceAndTheScript() {
        let closest = EditFace.closest
        // Arabic: Amiri for a serif, a Naskh or an unknown face; Cairo for a sans.
        XCTAssertEqual(closest("serif", "نص عربي", true), .amiri)
        XCTAssertEqual(closest("unknown", "نص عربي", true), .amiri)
        XCTAssertEqual(closest(nil, "نص عربي", true), .amiri)
        XCTAssertEqual(closest("sans", "نص عربي", true), .cairo)
        // Latin: Inter for a sans or an unknown face; Amiri for a serif.
        XCTAssertEqual(closest("sans", "Family Budget", false), .inter)
        XCTAssertEqual(closest(nil, "Family Budget", false), .inter)
        XCTAssertEqual(closest("serif", "Family Budget", false), .amiri)
        // Mixed text follows its Arabic, which Inter cannot draw.
        XCTAssertEqual(closest("sans", "Invoice فاتورة 2026", false), .cairo)
        // An emptied paragraph keeps the script it was written in.
        XCTAssertEqual(closest("sans", " ", true), .cairo)
        XCTAssertEqual(closest("sans", "", false), .inter)
    }

    func testAParagraphIsFoundByWhereTheFingerLands() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let edit = EditModel(model: model)
        await edit.read(page: 0)
        let paragraphs = try XCTUnwrap(edit.paragraphs(onPage: 0))
        let first = try XCTUnwrap(paragraphs.first)
        let middle = CGPoint(x: first.storedRect.midX, y: first.storedRect.midY)
        XCTAssertEqual(edit.paragraph(at: middle, onPage: 0)?.index, first.index)
        // Far off the page: nothing, and no crash.
        XCTAssertNil(edit.paragraph(at: CGPoint(x: -50, y: -50), onPage: 0))
    }

    func testTheSameTextIsNotWrittenAgain() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let edit = EditModel(model: model)
        await edit.read(page: 0)
        let paragraph = try XCTUnwrap(edit.paragraphs(onPage: 0)?.first)
        edit.begin(editing: paragraph, onPage: 0)
        await edit.commit()
        try await settle(edit)
        XCTAssertFalse(model.isEdited, "a paragraph closed unchanged writes nothing")
        XCTAssertEqual(edit.edits, 0)
    }

    // MARK: - A line where the finger lands

    func testALineOfArabicIsAddedWhereTheFingerLandsAndReadsBack() async throws {
        let model = try await PartB.loadedModel("raw-amiri-cid-identity-tounicode", in: folder)
        let edit = EditModel(model: model)
        edit.undoManager = UndoManager()
        let size = try await XCTUnwrap(model.engine).pageSize(0)
        let added = "سطرٌ مضافٌ في الهامش"

        edit.placingArmed = true
        edit.beginLine(at: CGPoint(x: CGFloat(size.width) * 0.8, y: CGFloat(size.height) - 40), onPage: 0)
        XCTAssertTrue(edit.draftIsRightToLeft, "an Arabic document types right to left by default")
        edit.draft = added
        edit.color = .red
        edit.font = .amiri
        edit.size = 14
        await edit.addLine()
        try await settle(edit)
        XCTAssertFalse(edit.placingArmed, "the tool is put down once the line is drawn")

        try await model.save()
        let reopened = try DocumentModel(url: try XCTUnwrap(model.url))
        await reopened.load()
        let text = try await PartB.text(of: reopened, page: 0)
        XCTAssertTrue(text.contains(added), "the added Arabic reads back: \(text.suffix(200))")
    }

    func testEachBundledFaceDrawsALineTheCoreReadsBack() async throws {
        for face in EditFace.allCases {
            XCTAssertNotNil(face.bytes, "\(face.name) is in the app's bundle")
            let model = try await PartB.loadedModel("raw-amiri-cid-identity-tounicode",
                                                    in: try PartB.folder())
            let edit = EditModel(model: model)
            edit.font = face
            let added = face == .inter ? "Added line" : "سطر مضاف"
            edit.beginLine(at: CGPoint(x: 80, y: 60), onPage: 0)
            edit.draft = added
            await edit.addLine()
            try await settle(edit)
            let text = try await PartB.text(of: model, page: 0)
            XCTAssertTrue(text.contains(added), "\(face.name): \(text.prefix(120))")
        }
    }

    func testAnEmptyLineWritesNothing() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let edit = EditModel(model: model)
        edit.beginLine(at: CGPoint(x: 40, y: 40), onPage: 0)
        edit.draft = "   "
        await edit.addLine()
        try await settle(edit)
        XCTAssertFalse(model.isEdited)
        XCTAssertNil(edit.placing)
    }

    /// The direction a line runs is the text's, not the interface's: a Latin
    /// line in an Arabic document still grows rightwards.
    func testTheDraftsDirectionFollowsWhatIsTyped() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let edit = EditModel(model: model)
        edit.beginLine(at: .zero, onPage: 0)
        XCTAssertTrue(edit.draftIsRightToLeft, "an empty draft follows the document")
        edit.draft = "Invoice"
        XCTAssertFalse(edit.draftIsRightToLeft)
        edit.draft = "فاتورة"
        XCTAssertTrue(edit.draftIsRightToLeft)
    }

    // MARK: - Undo

    func testAnEditGoesOnTheUndoStackAndComesBack() async throws {
        let model = try await PartB.loadedModel("raw-amiri-cid-identity-tounicode", in: folder)
        let undo = UndoManager()
        let edit = EditModel(model: model)
        edit.undoManager = undo
        edit.beginLine(at: CGPoint(x: 80, y: 60), onPage: 0)
        edit.draft = "سطر"
        await edit.addLine()
        try await settle(edit)
        XCTAssertTrue(model.isEdited)
        XCTAssertTrue(undo.canUndo)
        undo.undo()
        XCTAssertFalse(model.isEdited, "undo puts the bytes back as they were")
        _ = await model.readyEngine()
        let text = try await PartB.text(of: model, page: 0)
        XCTAssertFalse(text.contains("سطر مضاف"))
    }

    // MARK: - Pictures

    func testAPictureIsPlacedMovedCroppedAndDeleted() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let edit = EditModel(model: model)
        edit.undoManager = UndoManager()
        await edit.read(page: 0)
        let before = (edit.pictures(onPage: 0) ?? []).count

        let png = try XCTUnwrap(PartB.picture().pngData())
        await edit.addPicture(png, in: CGRect(x: 60, y: 60, width: 120, height: 60), onPage: 0)
        try await settle(edit)
        await edit.read(page: 0)
        let pictures = try XCTUnwrap(edit.pictures(onPage: 0))
        XCTAssertEqual(pictures.count, before + 1, "the picture is on the page")
        let placed = try XCTUnwrap(pictures.last)
        let box = EditGeometry.bounds(EditGeometry.corners(placed.matrix, clip: placed.clip))
        XCTAssertEqual(box.minX, 60, accuracy: 1)
        XCTAssertEqual(box.width, 120, accuracy: 1)

        // Moved 40 points across.
        await edit.transform(placed, onPage: 0, matrix: EditGeometry.translate(placed.matrix, dx: 40, dy: 0))
        try await settle(edit)
        await edit.read(page: 0)
        let moved = try XCTUnwrap(edit.pictures(onPage: 0)?.first { $0.id == placed.id })
        XCTAssertEqual(EditGeometry.bounds(EditGeometry.corners(moved.matrix, clip: moved.clip)).minX, 100, accuracy: 1)

        // Cropped to the right-hand half of its own square.
        await edit.transform(moved, onPage: 0, matrix: moved.matrix, clip: [0.5, 0, 1, 1])
        try await settle(edit)
        await edit.read(page: 0)
        let cropped = try XCTUnwrap(edit.pictures(onPage: 0)?.first { $0.id == moved.id })
        XCTAssertEqual(EditGeometry.bounds(EditGeometry.corners(cropped.matrix, clip: cropped.clip)).width, 60, accuracy: 1)

        await edit.delete(cropped, onPage: 0)
        try await settle(edit)
        await edit.read(page: 0)
        XCTAssertEqual((edit.pictures(onPage: 0) ?? []).count, before, "and it is off the page again")
    }

    /// With a keyboard, the arrow keys move what is picked a point at a
    /// time and ten with Shift — and do nothing when nothing is picked.
    func testTheArrowKeysMoveWhatIsPicked() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let edit = EditModel(model: model)
        edit.undoManager = UndoManager()
        await edit.read(page: 0)
        XCTAssertFalse(edit.hasSomethingPicked)
        await edit.nudge(dx: 1, dy: 0, far: false)
        XCTAssertFalse(model.isEdited, "nothing picked, nothing moves")

        let png = try XCTUnwrap(PartB.picture().pngData())
        await edit.addPicture(png, in: CGRect(x: 60, y: 60, width: 120, height: 60), onPage: 0)
        try await settle(edit)
        await edit.read(page: 0)
        let placed = try XCTUnwrap(edit.pictures(onPage: 0)?.last)
        edit.selectedPicture = PictureRef(page: 0, id: placed.id)
        XCTAssertTrue(edit.hasSomethingPicked)

        await edit.nudge(dx: 1, dy: 0, far: false)
        try await settle(edit)
        await edit.read(page: 0)
        let once = try XCTUnwrap(edit.pictures(onPage: 0)?.first { $0.id == placed.id })
        XCTAssertEqual(EditGeometry.bounds(EditGeometry.corners(once.matrix, clip: once.clip)).minX, 61, accuracy: 0.5)

        await edit.nudge(dx: 0, dy: 1, far: true)
        try await settle(edit)
        await edit.read(page: 0)
        let twice = try XCTUnwrap(edit.pictures(onPage: 0)?.first { $0.id == placed.id })
        XCTAssertEqual(EditGeometry.bounds(EditGeometry.corners(twice.matrix, clip: twice.clip)).minY, 70, accuracy: 0.5,
                       "Shift moves it ten points")
    }

    func testAPictureIsReplacedInPlace() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let edit = EditModel(model: model)
        await edit.read(page: 0)
        let png = try XCTUnwrap(PartB.picture(color: .black).pngData())
        await edit.addPicture(png, in: CGRect(x: 60, y: 60, width: 120, height: 60), onPage: 0)
        try await settle(edit)
        await edit.read(page: 0)
        let placed = try XCTUnwrap(edit.pictures(onPage: 0)?.last)

        let other = try XCTUnwrap(PartB.picture(width: 60, height: 60, color: .red).pngData())
        await edit.replace(placed, onPage: 0, with: other)
        try await settle(edit)
        await edit.read(page: 0)
        let now = try XCTUnwrap(edit.pictures(onPage: 0)?.last)
        XCTAssertNotEqual(now.pixels, placed.pixels, "the other picture's own pixels")
        XCTAssertEqual(now.aspect, 1, accuracy: 0.01, "and its own proportions")
        XCTAssertNil(edit.selectedPicture, "nothing is left picked over bytes that are gone")
    }

    func testAPictureSharedWithAnotherPlaceIsNotOffered() async throws {
        let model = try await PartB.loadedModel("scan-arial-200dpi-bilevel", in: folder)
        let edit = EditModel(model: model)
        await edit.read(page: 0)
        for picture in edit.pictures(onPage: 0) ?? [] where picture.shared {
            XCTAssertFalse(picture.isEditable, "a shared picture is shown but not edited")
        }
    }

    func testAChosenPictureThatIsNotPNGOrJPEGIsTurnedIntoOne() throws {
        let png = try XCTUnwrap(PartB.picture().pngData())
        XCTAssertTrue(PendingPicture.isPNGOrJPEG(png))
        let pending = try XCTUnwrap(PendingPicture.of(png, page: 0))
        XCTAssertEqual(pending.bytes, png, "a PNG goes to the core as it is")
        XCTAssertEqual(pending.aspect, 2, accuracy: 0.01)
        XCTAssertNil(PendingPicture.of(Data("not a picture".utf8), page: nil))
    }

    // MARK: - Links

    func testALinkIsAddedRepointedMovedAndRemoved() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let edit = EditModel(model: model)
        edit.undoManager = UndoManager()
        await edit.read(page: 0)
        let before = (edit.links(onPage: 0) ?? []).count

        await edit.addLink(rect: CGRect(x: 40, y: 40, width: 120, height: 20),
                           to: LinkTo(uri: "https://example.org/فاتورة", page: nil), onPage: 0)
        try await settle(edit)
        await edit.read(page: 0)
        let links = try XCTUnwrap(edit.links(onPage: 0))
        XCTAssertEqual(links.count, before + 1)
        let added = try XCTUnwrap(links.last)
        // A PDF's `/URI` is ASCII, so the core percent-encodes the Arabic; it
        // reads back as what was typed.
        XCTAssertEqual(added.to.uri?.removingPercentEncoding, "https://example.org/فاتورة")
        XCTAssertEqual(added.shownRect.minX, 40, accuracy: 1)

        await edit.update(added, onPage: 0, rect: CGRect(x: 60, y: 40, width: 120, height: 20), to: nil)
        try await settle(edit)
        await edit.read(page: 0)
        let moved = try XCTUnwrap(edit.links(onPage: 0)?.first { $0.id == added.id })
        XCTAssertEqual(moved.shownRect.minX, 60, accuracy: 1)
        XCTAssertEqual(moved.to.uri, added.to.uri, "moving it leaves where it goes alone")

        await edit.update(moved, onPage: 0, rect: nil, to: LinkTo(uri: nil, page: 0))
        try await settle(edit)
        await edit.read(page: 0)
        let repointed = try XCTUnwrap(edit.links(onPage: 0)?.first { $0.id == moved.id })
        XCTAssertEqual(repointed.to.page, 0)
        XCTAssertNil(repointed.to.uri)

        await edit.remove(repointed, onPage: 0)
        try await settle(edit)
        await edit.read(page: 0)
        XCTAssertEqual((edit.links(onPage: 0) ?? []).count, before)
    }

    func testAnAddressTheCoreRefusesIsSaidToBeRefused() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let edit = EditModel(model: model)
        await edit.read(page: 0)
        // A scheme that runs something, and an address that hides itself.
        for uri in ["javascript:alert(1)", "https://example.org/\u{202E}gnp.exe"] {
            edit.error = nil
            await edit.addLink(rect: CGRect(x: 10, y: 10, width: 40, height: 10),
                               to: LinkTo(uri: uri, page: nil), onPage: 0)
            try? await Task.sleep(for: .milliseconds(50))
            XCTAssertNotNil(edit.error, "\(uri) must be refused, not written")
            edit.error = nil
        }
    }
}
