@testable import PDFEditor
import PDFKit
import PencilKit
import WarraqCore
import XCTest

/// Marking up: every kind of mark reaches the file as an incremental
/// update the core rebased, reads back through PDFKit (and, for text and
/// stamps and the signature, through the core), and undoes.
@MainActor
final class AnnotateTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = try PartB.folder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func annotations(in bytes: Data, page: Int = 0) throws -> [PDFAnnotation] {
        let pdf = try XCTUnwrap(PDFDocument(data: bytes))
        return try XCTUnwrap(pdf.page(at: page)).annotations.filter(\.isMarkup)
    }

    func testHighlightIsRebasedOntoTheOriginalAndUndoes() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let original = model.bytes
        let undo = UndoManager()
        let editor = AnnotationEditor(model: model)
        editor.undoManager = undo
        editor.color = .green
        let page = try XCTUnwrap(model.pdf?.page(at: 0))
        let box = page.bounds(for: .cropBox)
        let selection = try XCTUnwrap(page.selection(for: CGRect(x: box.minX, y: box.midY - 60, width: box.width, height: 120)))
        XCTAssertFalse(selection.string?.isEmpty ?? true, "words in the middle of the page")
        editor.markup(selection, as: .highlight)
        await editor.settle()
        XCTAssertNil(editor.error)
        XCTAssertEqual(editor.commits, 1)
        XCTAssertTrue(model.isEdited)
        XCTAssertTrue(model.bytes.starts(with: original), "the core kept PDFKit's rewrite as an incremental update")
        let marks = try annotations(in: model.bytes)
        XCTAssertGreaterThan(marks.count, 0)
        XCTAssertTrue(marks.allSatisfy { $0.type == "Highlight" }, marks.map { $0.type ?? "" }.joined(separator: ","))
        XCTAssertEqual(editor.annotations.count, marks.count)

        undo.undo()
        XCTAssertFalse(model.isEdited)
        XCTAssertEqual(try annotations(in: model.bytes).count, 0)
        undo.redo()
        XCTAssertEqual(try annotations(in: model.bytes).count, marks.count)

        // Saved, it reopens with the marks.
        try await model.save()
        let reopened = try DocumentModel(url: try XCTUnwrap(model.url))
        await reopened.load()
        XCTAssertEqual(try annotations(in: reopened.bytes).count, marks.count)
        reopened.close()
        model.close()
    }

    func testShapesArrowAndNote() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let editor = AnnotationEditor(model: model)
        editor.addShape(.rectangle, in: CGRect(x: 100, y: 100, width: 120, height: 60), on: 0)
        editor.addShape(.ellipse, in: CGRect(x: 100, y: 200, width: 80, height: 80), on: 0)
        editor.addArrow(from: CGPoint(x: 50, y: 50), to: CGPoint(x: 200, y: 120), on: 0)
        editor.addNote("راجع هذه الفقرة", at: PendingPlacement(tool: .note, pageIndex: 0, rect: CGRect(x: 300, y: 500, width: 0, height: 0)))
        await editor.settle()
        XCTAssertNil(editor.error)
        let marks = try annotations(in: model.bytes)
        XCTAssertEqual(Set(marks.compactMap(\.type)), ["Square", "Circle", "Line", "Text"])
        let note = try XCTUnwrap(marks.first { $0.type == "Text" })
        XCTAssertEqual(note.contents, "راجع هذه الفقرة")
        let arrow = try XCTUnwrap(marks.first { $0.type == "Line" })
        XCTAssertEqual(arrow.endLineStyle, .closedArrow)
        model.close()
    }

    func testFreeTextArabicIsShapedByTheCoreAndReadsBack() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let editor = AnnotationEditor(model: model)
        editor.color = .blue
        let words = "ملاحظة عربية مكتوبة"
        editor.addFreeText(words, at: PendingPlacement(tool: .freeText, pageIndex: 0, rect: CGRect(x: 60, y: 60, width: 220, height: 30)), size: 14, rightToLeft: true)
        await editor.settle()
        XCTAssertNil(editor.error)
        let marks = try annotations(in: model.bytes)
        let text = try XCTUnwrap(marks.first { $0.type == "FreeText" })
        XCTAssertEqual(text.contents, words, "the words are stored")
        XCTAssertNotNil(model.bytes.range(of: Data("WarraqAr".utf8)), "the core redrew the appearance with its shaped Arabic face")
        // The appearance is a subset of the bundled face, embedded.
        XCTAssertNotNil(model.bytes.range(of: Data("FontFile".utf8)))
        model.close()
    }

    func testInkStrokesBecomeInkAnnotations() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let editor = AnnotationEditor(model: model)
        let path = UIBezierPath()
        path.move(to: CGPoint(x: 100, y: 400))
        path.addLine(to: CGPoint(x: 160, y: 440))
        path.addLine(to: CGPoint(x: 220, y: 400))
        editor.inkPaths[0] = [InkPath(path: path, color: .red, width: 4), InkPath(path: path, color: .blue, width: 2)]
        XCTAssertTrue(editor.hasUncommittedInk)
        editor.commitInk()
        await editor.settle()
        XCTAssertFalse(editor.hasUncommittedInk)
        let marks = try annotations(in: model.bytes)
        XCTAssertEqual(marks.filter { $0.type == "Ink" }.count, 2)
        let ink = try XCTUnwrap(marks.first { $0.type == "Ink" })
        XCTAssertEqual(ink.paths?.count, 1)
        XCTAssertEqual(ink.border?.lineWidth, 4)
        XCTAssertTrue(ink.bounds.contains(CGPoint(x: 160, y: 440)))
        model.close()
    }

    func testStampIsWrittenByTheCoreAsShapedText() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let original = model.bytes
        let undo = UndoManager()
        try await StampSheet.add(text: "معتمد", position: .topRight, color: .red, pages: [0], to: model, undoManager: undo)
        XCTAssertTrue(model.isEdited)
        XCTAssertTrue(model.bytes.starts(with: original), "an incremental update")
        struct Args: Encodable { let password: String? }
        let listed = try await Core.callStatic(op: "marks.list", args: Args(password: nil), blobs: [model.bytes])
        let marks = try XCTUnwrap(listed.object["marks"] as? [[String: Any]])
        XCTAssertEqual(marks.count, 1)
        XCTAssertEqual(marks[0]["kind"] as? String, "watermark")
        XCTAssertEqual((marks[0]["spec"] as? [String: Any])?["text"] as? String, "معتمد")
        struct TextArgs: Encodable { let password: String?; let page: Int }
        let text = try await Core.callStatic(op: "marks.text", args: TextArgs(password: nil, page: 0), blobs: [model.bytes])
        let markText = (text.object["marks"] as? String) ?? String(describing: text.object["marks"] ?? "")
        XCTAssertTrue(markText.contains("معتمد"), "the stamp reads back as text: \(markText)")
        undo.undo()
        XCTAssertFalse(model.isEdited)
        model.close()
    }

    func testSignatureIsPlacedAsAPictureThroughTheCore() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let original = model.bytes
        let undo = UndoManager()
        let image = PartB.picture()
        try await SignaturePlacer.place(image: image, in: CGRect(x: 300, y: 600, width: 150, height: 75), on: 0, of: model, undoManager: undo)
        XCTAssertTrue(model.isEdited)
        XCTAssertTrue(model.bytes.starts(with: original))
        struct Args: Encodable { let page: Int }
        let core = try XCTUnwrap(model.engine)
        let listed = try await core.call(op: "images.list", args: Args(page: 0))
        let images = try XCTUnwrap(listed.object["images"] as? [[String: Any]])
        XCTAssertEqual(images.count, 1, "the signature is the page's one picture")
        let matrix = try XCTUnwrap(images[0]["matrix"] as? [Double])
        XCTAssertEqual(matrix[4], 300, accuracy: 1)
        XCTAssertEqual(abs(matrix[0]), 150, accuracy: 1)
        XCTAssertTrue(undo.canUndo)
        model.close()
    }

    func testRemovingAMark() async throws {
        let model = try await PartB.loadedModel("variant-arabic-metadata-outlines-annots", in: folder)
        let editor = AnnotationEditor(model: model)
        let before = editor.annotations.count
        XCTAssertEqual(before, 2, "the corpus file carries a note and a highlight")
        editor.remove(editor.annotations[0].annotation)
        await editor.settle()
        XCTAssertNil(editor.error)
        XCTAssertEqual(editor.annotations.count, 1)
        XCTAssertEqual(try annotations(in: model.bytes).count, 1)
        model.close()
    }
}
