import PDFKit
@testable import PDFEditor
import WarraqCore
import XCTest

/// Form autofill over PDFKit's fields: the fields of an Arabic AcroForm
/// with their labels, the never-invent check, the fake engine's mapping,
/// and the values written and read back — with the file untouched until
/// Save.
@MainActor
final class FormAutofillTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "FormAutofillTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func copyFixture(_ name: String) throws -> URL {
        let source = try XCTUnwrap(Bundle(for: FormAutofillTests.self).url(forResource: name, withExtension: "pdf"))
        let destination = folder.appending(path: "\(name).pdf")
        try FileManager.default.copyItem(at: source, to: destination)
        return destination
    }

    private var profile: Profile {
        var profile = Profile()
        profile.nameArabic = "محمد الغماس"
        profile.nameEnglish = "Mohammed Alghammas"
        profile.nationalID = "1234567890"
        profile.email = "m@example.com"
        profile.phone = "0500000000"
        return profile
    }

    func testListsTheArabicFormsTextFieldsWithTheirLabels() async throws {
        let model = try DocumentModel(url: try copyFixture("acroform-pdflib-arabic-fields"))
        await model.load()
        XCTAssertEqual(model.state, .ready)
        let fields = await FormAutofill.fields(in: model)
        let names = fields.map(\.name)
        XCTAssertTrue(names.contains("الاسم الكامل"), "\(names)")
        XCTAssertTrue(names.contains("رقم الهوية"), "\(names)")
        XCTAssertTrue(names.contains("البريد الإلكتروني"), "\(names)")
        XCTAssertFalse(names.contains { $0.hasPrefix("الجنس") }, "check boxes are not text fields: \(names)")
        for field in fields {
            XCTAssertGreaterThan(field.rect.width, 0)
            XCTAssertEqual(field.page, 0)
        }
        model.close()
    }

    func testTheFakeEngineMapsFieldsToTheProfile() async throws {
        let model = try DocumentModel(url: try copyFixture("acroform-pdflib-arabic-fields"))
        await model.load()
        let fields = await FormAutofill.fields(in: model)
        let text = await model.text(ofPage: 0) ?? ""
        let proposals = try await FormAutofill.propose(fields: fields, profile: profile, documentText: text, engine: FakeEngine())
        let byField = Dictionary(uniqueKeysWithValues: proposals.map { ($0.field.name, $0) })
        XCTAssertEqual(byField["الاسم الكامل"]?.value, "محمد الغماس")
        XCTAssertEqual(byField["الاسم الكامل"]?.source, .profile(.nameArabic))
        XCTAssertEqual(byField["رقم الهوية"]?.value, "1234567890")
        XCTAssertEqual(byField["البريد الإلكتروني"]?.value, "m@example.com")
        XCTAssertNil(byField["الجنسية"], "nothing in the profile answers nationality")
        model.close()
    }

    func testNothingInventedReachesAField() {
        let field = FillableField(name: "email", label: "Email", tooltip: "", current: "", page: 0, rect: .zero)
        let other = FillableField(name: "city", label: "City", tooltip: "", current: "", page: 0, rect: .zero)
        var profile = Profile()
        profile.email = "m@example.com"
        let text = "The city is Riyadh."
        let proposals = FormAutofill.check([
            FieldAssignment(field: "email", profileKey: .email, documentQuote: nil),
            FieldAssignment(field: "email", profileKey: .phone, documentQuote: nil),            // second answer for a field: ignored
            FieldAssignment(field: "city", profileKey: .phone, documentQuote: nil),             // an empty detail: dropped
            FieldAssignment(field: "city", profileKey: nil, documentQuote: "Jeddah"),           // not in the document: dropped
            FieldAssignment(field: "nowhere", profileKey: .email, documentQuote: nil),          // no such field: dropped
            FieldAssignment(field: "city", profileKey: nil, documentQuote: "Riyadh"),           // quoted from the document: kept
        ], fields: [field, other], profile: profile, documentText: text)
        XCTAssertEqual(proposals.map(\.value), ["m@example.com", "Riyadh"])
        XCTAssertEqual(proposals.map(\.source), [.profile(.email), .document])
    }

    func testLabelsComeFromTheLineBesideTheField() {
        func line(_ text: String, x: Float, y: Float, width: Float, rtl: Bool) -> TextLine {
            TestLines.line(text, x: x, y: y, width: width, height: 12, rtl: rtl)
        }
        // An Arabic label sits to the right of its field.
        let arabicLines = [line("الاسم:", x: 400, y: 100, width: 60, rtl: true), line("عنوان", x: 400, y: 160, width: 60, rtl: true)]
        XCTAssertEqual(FormAutofill.labelFor(rect: CGRect(x: 200, y: 98, width: 180, height: 16), lines: arabicLines), "الاسم:")
        // An English label to its left, or just above it.
        let englishLines = [line("Email", x: 40, y: 100, width: 40, rtl: false), line("Phone", x: 200, y: 140, width: 40, rtl: false)]
        XCTAssertEqual(FormAutofill.labelFor(rect: CGRect(x: 100, y: 98, width: 180, height: 16), lines: englishLines), "Email")
        XCTAssertEqual(FormAutofill.labelFor(rect: CGRect(x: 200, y: 156, width: 180, height: 16), lines: englishLines), "Phone")
        // Nothing near: no label.
        XCTAssertEqual(FormAutofill.labelFor(rect: CGRect(x: 100, y: 500, width: 180, height: 16), lines: englishLines), "")
    }

    func testPageSpaceMapsBothWays() {
        let plain = PageSpace(crop: CGRect(x: 0, y: 0, width: 595, height: 842), rotation: 0)
        let user = plain.userRect(fromDisplay: CGRect(x: 100, y: 50, width: 200, height: 20))
        XCTAssertEqual(user, CGRect(x: 100, y: 772, width: 200, height: 20))
        XCTAssertEqual(plain.displayRect(fromUser: user), CGRect(x: 100, y: 50, width: 200, height: 20))

        // Rotated 90° clockwise: the page shows 842 wide; the user-space
        // left edge is the displayed top.
        let turned = PageSpace(crop: CGRect(x: 0, y: 0, width: 595, height: 842), rotation: 90)
        let top = turned.userRect(fromDisplay: CGRect(x: 0, y: 0, width: 842, height: 10))
        XCTAssertEqual(top, CGRect(x: 0, y: 0, width: 10, height: 842))
        XCTAssertEqual(turned.displayRect(fromUser: top), CGRect(x: 0, y: 0, width: 842, height: 10))

        // A crop box away from the origin.
        let offset = PageSpace(crop: CGRect(x: 20, y: 30, width: 500, height: 700), rotation: 0)
        XCTAssertEqual(offset.userPoint(fromDisplay: .zero), CGPoint(x: 20, y: 730))
        XCTAssertEqual(offset.displayPoint(fromUser: CGPoint(x: 20, y: 730)), .zero)
    }

    func testWritesValuesThatReadBackAndLeavesTheFileUntilSave() async throws {
        let url = try copyFixture("acroform-pdflib-arabic-fields")
        let before = try Data(contentsOf: url)
        let model = try DocumentModel(url: url)
        await model.load()
        let fields = await FormAutofill.fields(in: model)
        let text = await model.text(ofPage: 0) ?? ""
        let proposals = try await FormAutofill.propose(fields: fields, profile: profile, documentText: text, engine: FakeEngine())
        XCTAssertGreaterThanOrEqual(proposals.count, 3)

        let undo = UndoManager()
        let written = try await FormAutofill.write(proposals, into: model, undoManager: undo)
        XCTAssertEqual(written, proposals.count)
        XCTAssertTrue(model.isEdited)
        XCTAssertEqual(try Data(contentsOf: url), before, "nothing written to the file yet")

        // PDFKit reads the values back from the new bytes…
        let reread = try XCTUnwrap(PDFDocument(data: model.bytes))
        let page = try XCTUnwrap(reread.page(at: 0))
        let name = page.annotations.first { $0.fieldName == "الاسم الكامل" }
        XCTAssertEqual(name?.widgetStringValue, "محمد الغماس")
        let id = page.annotations.first { $0.fieldName == "رقم الهوية" }
        XCTAssertEqual(id?.widgetStringValue, "1234567890")
        // …and so does the core: the fields' values, and the Arabic drawn
        // on the page shaped, read back in logical order.
        struct Inspect: Encodable { let password: String? }
        struct Field: Decodable { let name: String; let value: String }
        struct Report: Decodable { let fields: [Field] }
        let report: Report = try await Core.callStatic(op: "forms.inspect", args: Inspect(password: nil), blobs: [model.bytes]).decode()
        XCTAssertEqual(report.fields.first { $0.name == "الاسم الكامل" }?.value, "محمد الغماس")
        XCTAssertEqual(report.fields.first { $0.name == "رقم الهوية" }?.value, "1234567890")
        let pageText = await model.text(ofPage: 0) ?? ""
        XCTAssertTrue(pageText.contains("محمد الغماس"), "the value is drawn, shaped, and reads back: \(pageText)")

        // Already-filled fields are not proposed again.
        let again = await FormAutofill.fields(in: model)
        XCTAssertEqual(again.first { $0.name == "الاسم الكامل" }?.current, "محمد الغماس")
        let more = try await FormAutofill.propose(fields: again, profile: profile, documentText: pageText, engine: FakeEngine())
        XCTAssertFalse(more.contains { $0.field.name == "الاسم الكامل" })

        XCTAssertTrue(undo.canUndo)
        undo.undo()
        XCTAssertFalse(model.isEdited)
        undo.redo()
        XCTAssertTrue(model.isEdited)

        try await model.save()
        XCTAssertNotEqual(try Data(contentsOf: url), before)
        XCTAssertEqual(PDFDocument(url: url)?.page(at: 0)?.annotations.first { $0.fieldName == "رقم الهوية" }?.widgetStringValue, "1234567890")
        model.close()
    }
}
