@testable import PDFEditor
import PDFKit
import WarraqCore
import XCTest

/// Prepare form and Fill form on iPhone and iPad, through the model the
/// screen drives: the core's detection on a flat Arabic invoice proposing
/// exactly the fields a person marked on it, drafts of every kind made into
/// real fields as an update and read back by the core, then filled — Arabic
/// values stored and drawn — saved, and read back from the file.
@MainActor
final class FormTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = try PartB.folder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func settle(_ form: FormModel) async throws {
        let deadline = Date(timeIntervalSinceNow: 30)
        while form.working {
            if Date() > deadline { XCTFail("the form did not settle"); return }
            try await Task.sleep(for: .milliseconds(30))
        }
    }

    /// The names a person gave the invoice's fields (tests/fixtures/forms/truth.json).
    private static let invoiceTruth: Set<String> = [
        "اسم العميل", "الصنف 1", "الكمية 1", "سعر الوحدة 1", "الإجمالي 1",
        "الصنف 2", "الكمية 2", "سعر الوحدة 2", "الإجمالي 2",
        "الصنف 3", "الكمية 3", "سعر الوحدة 3", "الإجمالي 3", "المجموع",
    ]

    func testDetectionProposesExactlyTheInvoicesFieldsAndCreateMakesThem() async throws {
        let model = try await PartB.loadedModel("ar-invoice", in: folder)
        let original = model.bytes
        let form = FormModel(model: model)
        form.undoManager = UndoManager()
        await form.readFields()
        XCTAssertTrue(form.fields.isEmpty, "a flat form")
        await form.detect()
        try await settle(form)
        XCTAssertEqual(Set(form.drafts.map(\.name)), Self.invoiceTruth)
        XCTAssertTrue(form.drafts.allSatisfy { $0.kind == .text && $0.rtl }, "text fields, right to left")
        // Detected twice: nothing proposed again over what is already there.
        await form.detect()
        XCTAssertEqual(form.drafts.count, Self.invoiceTruth.count)

        await form.create()
        try await settle(form)
        XCTAssertNil(form.error)
        XCTAssertTrue(form.drafts.isEmpty)
        XCTAssertTrue(model.bytes.starts(with: original), "an incremental update: the original is the prefix")
        XCTAssertEqual(Set(form.fields.map(\.name)), Self.invoiceTruth)
        XCTAssertTrue(form.fields.allSatisfy { $0.type == "text" })
    }

    func testDraftsOfEveryKindAreMovedRenamedMadeAndReadBack() async throws {
        let model = try await PartB.loadedModel("ar-invoice", in: folder)
        let form = FormModel(model: model)
        let undo = UndoManager()
        form.undoManager = undo
        form.add(kind: .text, rect: CGRect(x: 300, y: 300, width: 200, height: 22), onPage: 0)
        var name = try XCTUnwrap(form.picked)
        name.name = "الاسم الكامل"
        form.update(name)
        form.move(name.id, to: CGRect(x: 310, y: 320, width: 210, height: 24))
        form.add(kind: .date, rect: CGRect(x: 300, y: 350, width: 120, height: 22), onPage: 0)
        form.add(kind: .checkbox, rect: CGRect(x: 480, y: 380, width: 14, height: 14), onPage: 0)
        form.add(kind: .radio, rect: CGRect(x: 480, y: 400, width: 14, height: 14), onPage: 0)
        var first = try XCTUnwrap(form.picked)
        first.name = "الدفع"
        first.label = "نقدًا"
        form.update(first)
        // The next radio button joins the group the last one is in.
        form.add(kind: .radio, rect: CGRect(x: 440, y: 400, width: 14, height: 14), onPage: 0)
        var second = try XCTUnwrap(form.picked)
        XCTAssertEqual(second.name, "الدفع")
        second.label = "بطاقة"
        form.update(second)
        form.add(kind: .choice, rect: CGRect(x: 300, y: 430, width: 150, height: 22), onPage: 0)
        var list = try XCTUnwrap(form.picked)
        XCTAssertNotNil(form.problem, "a list with no options cannot be made")
        list.name = "المدينة"
        list.options = "الرياض\nجدة\n\n"
        form.update(list)
        XCTAssertNil(form.problem)
        form.add(kind: .signature, rect: CGRect(x: 300, y: 470, width: 200, height: 40), onPage: 0)

        await form.create()
        try await settle(form)
        XCTAssertNil(form.error)
        let byName = Dictionary(uniqueKeysWithValues: form.fields.map { ($0.name, $0) })
        XCTAssertEqual(byName["الاسم الكامل"]?.type, "text")
        let rect = try XCTUnwrap(byName["الاسم الكامل"]?.widgets.first?.shownRect)
        XCTAssertEqual(rect.minX, 310, accuracy: 0.01)
        XCTAssertEqual(rect.minY, 320, accuracy: 0.01)
        XCTAssertEqual(rect.width, 210, accuracy: 0.01)
        XCTAssertEqual(byName["الدفع"]?.type, "radio")
        XCTAssertEqual(byName["الدفع"]?.options, ["نقدًا", "بطاقة"])
        XCTAssertEqual(byName["الدفع"]?.widgets.count, 2)
        XCTAssertEqual(byName["المدينة"]?.options, ["الرياض", "جدة"])
        XCTAssertEqual(byName.values.filter { $0.type == "checkbox" }.count, 1)
        XCTAssertEqual(byName.values.filter { $0.type == "signature" }.count, 1)

        // Undo takes every field back in one step.
        undo.undo()
        _ = await model.readyEngine()
        await form.readFields()
        XCTAssertTrue(form.fields.isEmpty)
    }

    func testFillingWritesArabicValuesThatSurviveSavingAndReopening() async throws {
        let model = try await PartB.loadedModel("ar-invoice", in: folder)
        let form = FormModel(model: model)
        form.undoManager = UndoManager()
        form.add(kind: .text, rect: CGRect(x: 300, y: 300, width: 200, height: 22), onPage: 0)
        var text = try XCTUnwrap(form.picked)
        text.name = "الاسم"
        form.update(text)
        form.add(kind: .checkbox, rect: CGRect(x: 480, y: 380, width: 14, height: 14), onPage: 0)
        var check = try XCTUnwrap(form.picked)
        check.name = "موافق"
        form.update(check)
        form.add(kind: .choice, rect: CGRect(x: 300, y: 430, width: 150, height: 22), onPage: 0)
        var list = try XCTUnwrap(form.picked)
        list.name = "المدينة"
        list.options = "الرياض\nجدة"
        form.update(list)
        await form.create()
        try await settle(form)

        let filled = await form.fill(["الاسم": "عبدالرحمن الشمري", "موافق": "Yes", "المدينة": "جدة"])
        XCTAssertTrue(filled, "\(String(describing: form.error))")
        try await model.save()
        let saved = try Data(contentsOf: try XCTUnwrap(model.url))
        let reply = try await Core.callStatic(op: "forms.inspect", args: PasswordArgs(password: nil), blobs: [saved])
        struct Answer: Decodable { let fields: [FormModel.Field] }
        let values = Dictionary(uniqueKeysWithValues: try reply.decode(Answer.self).fields.map { ($0.name, $0.value) })
        XCTAssertEqual(values["الاسم"], "عبدالرحمن الشمري")
        XCTAssertEqual(values["موافق"], "Yes")
        XCTAssertEqual(values["المدينة"], "جدة")
        // PDFKit reads the same values off the saved file.
        let pdf = try XCTUnwrap(PDFDocument(data: saved))
        let widgets = pdf.page(at: 0)?.annotations.filter { $0.type == "Widget" } ?? []
        XCTAssertEqual(widgets.first { $0.fieldName == "الاسم" }?.widgetStringValue, "عبدالرحمن الشمري")

        // A value a list does not have is refused, and nothing changes.
        let before = model.bytes
        let refused = await form.fill(["المدينة": "مكة"])
        XCTAssertFalse(refused)
        XCTAssertNotNil(form.error)
        XCTAssertEqual(model.bytes, before)
    }
}
