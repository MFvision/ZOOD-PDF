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
        // The four text fields, in the page's order, each with the line
        // printed beside it and what it holds; the check boxes are not text.
        XCTAssertEqual(fields.map(\.name), ["الاسم الكامل", "رقم الهوية", "الجنسية", "البريد الإلكتروني"])
        XCTAssertEqual(fields.map(\.label), ["الاسم الكامل:", "رقم الهوية:", "الجنسية:", "البريد الإلكتروني:"])
        XCTAssertEqual(fields.map(\.current), ["محمد عبد الله", "1098765432", "", ""])
        XCTAssertEqual(fields.map(\.page), [0, 0, 0, 0])
        for field in fields {
            XCTAssertGreaterThan(field.rect.width, 0)
        }
        model.close()
    }

    func testTheFakeEngineMapsFieldsToTheProfile() async throws {
        let model = try DocumentModel(url: try copyFixture("acroform-pdflib-arabic-fields"))
        await model.load()
        let fields = await FormAutofill.fields(in: model)
        let text = await model.text(ofPage: 0) ?? ""
        let proposals = try await FormAutofill.propose(fields: fields, profile: profile, documentText: text, engine: FakeEngine())
        // Name, ID and email answered by the profile; nationality by
        // nothing. The two fields that already hold a value are proposed
        // switched off: replacing them is the person's choice.
        XCTAssertEqual(proposals.map(\.field.name), ["الاسم الكامل", "رقم الهوية", "البريد الإلكتروني"])
        XCTAssertEqual(proposals.map(\.value), ["محمد الغماس", "1234567890", "m@example.com"])
        XCTAssertEqual(proposals.map(\.source), [.profile(.nameArabic), .profile(.nationalID), .profile(.email)])
        XCTAssertEqual(proposals.map(\.accepted), [false, false, true])
        model.close()
    }

    func testTheEngineIsHandedKeysNeverValues() async throws {
        let model = try DocumentModel(url: try copyFixture("acroform-pdflib-arabic-fields"))
        await model.load()
        let fields = await FormAutofill.fields(in: model)
        let engine = RecordingEngine()
        await engine.set(answer: [FieldAssignment(field: "البريد الإلكتروني", profileKey: .email, documentQuote: nil)])
        let proposals = try await FormAutofill.propose(fields: fields, profile: profile, documentText: "", engine: engine)
        let handed = await engine.assignments
        XCTAssertEqual(handed, [fields.map(\.description)])
        XCTAssertEqual(proposals.map(\.value), ["m@example.com"])
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
        XCTAssertEqual(proposals.map(\.accepted), [true, true])

        // A field that already says the same is not proposed; one that says
        // something else is proposed switched off.
        let same = FillableField(name: "email", label: "Email", tooltip: "", current: "m@example.com", page: 0, rect: .zero)
        XCTAssertEqual(FormAutofill.check([FieldAssignment(field: "email", profileKey: .email, documentQuote: nil)],
                                          fields: [same], profile: profile, documentText: text), [])
        let other2 = FillableField(name: "email", label: "Email", tooltip: "", current: "old@example.com", page: 0, rect: .zero)
        XCTAssertEqual(FormAutofill.check([FieldAssignment(field: "email", profileKey: .email, documentQuote: nil)],
                                          fields: [other2], profile: profile, documentText: text).map(\.accepted), [false])
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

    func testAFieldsBoxIsComparedWithTheLinesInTheCoresSpace() {
        // A crop box away from the origin: a widget's user-space bounds,
        // into the core's stored space and back through PageSpace.
        let frame = PageSpace.Frame(crop: CGRect(x: 20, y: 30, width: 500, height: 700), rotation: 0)
        let user = CGRect(x: 120, y: 600, width: 200, height: 20)
        let stored = FormAutofill.storedRect(fromUser: user, in: frame)
        XCTAssertEqual(stored, CGRect(x: 100, y: 110, width: 200, height: 20))
        XCTAssertEqual(PageSpace.userRect(fromStored: stored, in: frame), user)
    }

    func testWritesValuesThatReadBackAndLeavesTheFileUntilSave() async throws {
        let url = try copyFixture("acroform-pdflib-arabic-fields")
        let before = try Data(contentsOf: url)
        let model = try DocumentModel(url: url)
        await model.load()
        let fields = await FormAutofill.fields(in: model)
        let text = await model.text(ofPage: 0) ?? ""
        var proposals = try await FormAutofill.propose(fields: fields, profile: profile, documentText: text, engine: FakeEngine())
        // The person turns on the name (it held another), keeps the email,
        // and leaves the ID as it is.
        proposals[0].accepted = true
        XCTAssertEqual(proposals.filter(\.accepted).map(\.field.name), ["الاسم الكامل", "البريد الإلكتروني"])

        let undo = UndoManager()
        let written = try await FormAutofill.write(proposals, into: model, undoManager: undo)
        XCTAssertEqual(written, 2)
        XCTAssertTrue(model.isEdited)
        XCTAssertEqual(try Data(contentsOf: url), before, "nothing written to the file yet")
        XCTAssertEqual(model.bytes.prefix(before.count), before, "an incremental update: the original bytes stand")

        // The core reads the values back from the new bytes, exactly; the
        // field left alone keeps its own.
        struct Inspect: Encodable { let password: String? }
        struct Field: Decodable { let name: String; let value: String? }
        struct Report: Decodable { let fields: [Field] }
        let report: Report = try await Core.callStatic(op: "forms.inspect", args: Inspect(password: nil), blobs: [model.bytes]).decode()
        let values = Dictionary(report.fields.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        XCTAssertEqual(values["الاسم الكامل"], "محمد الغماس")
        XCTAssertEqual(values["البريد الإلكتروني"], "m@example.com")
        XCTAssertEqual(values["رقم الهوية"], "1098765432")
        XCTAssertEqual(values["الجنسية"], "")
        // PDFKit too.
        let reread = try XCTUnwrap(PDFDocument(data: model.bytes))
        let page = try XCTUnwrap(reread.page(at: 0))
        XCTAssertEqual(page.annotations.first { $0.fieldName == "الاسم الكامل" }?.widgetStringValue, "محمد الغماس")
        // The Arabic value is drawn shaped, once, and reads back off the
        // page in logical order.
        let core = try XCTUnwrap(model.engine)
        let lines = try await core.textLines(page: 0).map { $0.text.trimmingCharacters(in: .whitespaces) }
        // (The core reads a field's drawing into the line of its label.)
        XCTAssertEqual(lines, [
            "نموذج طلب تجديد رخصة",
            "الاسم الكامل: محمد الغماس",
            "رقم الهوية: 1098765432",
            "تاريخ الميلاد:",
            "الجنسية:",
            "البريد الإلكتروني: m@example.com",
            "رقم الجوال:",
            "الجنس: ذكر ☐ أنثى ☐",
            "أقرّ بأن جميع البيانات المذكورة أعلاه صحيحة وأتحمل المسؤولية القانونية في حال ثبوت خلاف",
            "ذلك.",
            "التوقيع: ____________ التاريخ: ____/____/______",
        ])

        // Filled now: proposing again offers nothing for those two.
        let again = await FormAutofill.fields(in: model)
        XCTAssertEqual(again.map(\.current), ["محمد الغماس", "1098765432", "", "m@example.com"])
        let more = try await FormAutofill.propose(fields: again, profile: profile, documentText: text, engine: FakeEngine())
        XCTAssertEqual(more.map(\.field.name), ["رقم الهوية"])

        XCTAssertTrue(undo.canUndo)
        undo.undo()
        XCTAssertFalse(model.isEdited)
        undo.redo()
        XCTAssertTrue(model.isEdited)

        try await model.save()
        let saved = try XCTUnwrap(PDFDocument(url: url)?.page(at: 0))
        XCTAssertEqual(saved.annotations.first { $0.fieldName == "الاسم الكامل" }?.widgetStringValue, "محمد الغماس")
        XCTAssertEqual(saved.annotations.first { $0.fieldName == "البريد الإلكتروني" }?.widgetStringValue, "m@example.com")
        XCTAssertEqual(saved.annotations.first { $0.fieldName == "رقم الهوية" }?.widgetStringValue, "1098765432")
        model.close()
    }
}
