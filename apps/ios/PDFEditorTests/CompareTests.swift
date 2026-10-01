@testable import PDFEditor
import WarraqCore
import XCTest

/// Compare through the core (`compare.text`, `compare.visual`) and the
/// screen's model: an edited copy of a corpus file read back change by
/// change, exactly; the counts the summary shows checked against the changes
/// themselves; a protected other version unlocked; Swap.
@MainActor
final class CompareTests: XCTestCase {
    private let line = "سطر جديد للمقارنة"

    /// The three-page Naskh file, and a copy with one Arabic line drawn on
    /// its second page by the core.
    private func versions() async throws -> (older: Data, newer: Data) {
        let older = try PartB.fixture("chrome-notonaskh-justified-3pages")
        let core = try await Core.open(bytes: older)
        let font = try XCTUnwrap(EditFace.amiri.bytes)
        try await core.addText(page: 1, x: 300, y: 760, size: 14, text: line, font: font)
        let newer = try await core.save()
        await core.close()
        return (older, newer)
    }

    func testAnInsertedLineIsReadBackExactlyAndOutlinedOnItsPage() async throws {
        let (older, newer) = try await versions()
        let text = try await Comparer.text(older: CompareSide(name: "a", bytes: older), newer: CompareSide(name: "b", bytes: newer),
                                           ignoreMarks: false, unifyLetters: false)
        XCTAssertEqual(text.olderPages, 3)
        XCTAssertEqual(text.newerPages, 3)
        XCTAssertEqual(text.changes.count, 1)
        let change = try XCTUnwrap(text.changes.first)
        XCTAssertEqual(change.kind, .inserted)
        XCTAssertEqual(change.added, line, "the words, exactly, in logical order")
        XCTAssertEqual(change.removed, "")
        XCTAssertEqual(change.page, 2)
        XCTAssertEqual(change.addedWords, 3)
        XCTAssertEqual([text.inserted, text.deleted, text.replaced], [1, 0, 0])
        XCTAssertEqual([text.added, text.removed], [3, 0])
        XCTAssertEqual(text.newerWords - text.olderWords, 3)
        // The passage holds the change as an added part, and the words round it.
        let passage = try XCTUnwrap(text.passage(of: change))
        XCTAssertEqual(passage.parts.filter { $0.kind == "added" }.map(\.text), [line])
        XCTAssertEqual(passage.parts.first { $0.kind == "added" }?.change, 0)

        let looks = try await Comparer.looks(older: CompareSide(name: "a", bytes: older), newer: CompareSide(name: "b", bytes: newer), pages: [0, 1, 2])
        XCTAssertEqual(looks.map(\.page), [1, 2, 3])
        XCTAssertEqual(looks.map(\.boxes.isEmpty), [true, false, true], "only page 2 looks different")
        let box = try XCTUnwrap(looks[1].boxes.first)
        XCTAssertGreaterThan(box.y, 0.8, "low on the page, where the line was drawn")
    }

    func testTheSummaryCountsAreTheChangesThemselves() async throws {
        // Two different invoices: many changes of every kind.
        let older = try PartB.fixture("coretext-sfarabic-mixed-invoice")
        let newer = try PartB.fixture("chrome-cairo-mixed-invoice")
        let text = try await Comparer.text(older: CompareSide(name: "a", bytes: older), newer: CompareSide(name: "b", bytes: newer),
                                           ignoreMarks: false, unifyLetters: false)
        XCTAssertFalse(text.changes.isEmpty)
        XCTAssertEqual(text.inserted, text.changes.filter { $0.kind == .inserted }.count)
        XCTAssertEqual(text.deleted, text.changes.filter { $0.kind == .deleted }.count)
        XCTAssertEqual(text.replaced, text.changes.filter { $0.kind == .replaced }.count)
        XCTAssertEqual(text.added, text.changes.map(\.addedWords).reduce(0, +))
        XCTAssertEqual(text.removed, text.changes.map(\.removedWords).reduce(0, +))
        for change in text.changes {
            XCTAssertEqual(change.added.split(separator: " ").count, change.addedWords)
            XCTAssertEqual(change.removed.split(separator: " ").count, change.removedWords)
            switch change.kind {
            case .inserted: XCTAssertTrue(change.removed.isEmpty && !change.added.isEmpty)
            case .deleted: XCTAssertTrue(!change.removed.isEmpty && change.added.isEmpty)
            case .replaced: XCTAssertTrue(!change.removed.isEmpty && !change.added.isEmpty)
            }
        }
        XCTAssertEqual(text.pages.map(\.added).reduce(0, +), text.added)
    }

    func testAFileAgainstItselfHasNoDifference() async throws {
        let bytes = try PartB.fixture("coretext-albayan-tashkeel")
        let side = CompareSide(name: "a", bytes: bytes)
        let text = try await Comparer.text(older: side, newer: side, ignoreMarks: false, unifyLetters: false)
        XCTAssertTrue(text.changes.isEmpty)
        XCTAssertGreaterThan(text.olderWords, 0)
        let looks = try await Comparer.looks(older: side, newer: side, pages: [0])
        XCTAssertEqual(looks.first?.boxes, [])
    }

    func testTheModelUnlocksAProtectedVersionComparesAndSwaps() async throws {
        let (older, newer) = try await versions()
        _ = newer
        let model = CompareModel(this: CompareSide(name: "this", bytes: older))
        // Not a PDF: said, not chosen.
        await model.choose(name: "broken", bytes: Data("%PDF-1.7\nnot really".utf8))
        XCTAssertTrue(model.otherUnreadable)
        XCTAssertNil(model.other)
        // A protected file: asked for, a wrong password refused, the right one taken.
        let locked = try PartB.fixture("variant-encrypted-aes256")
        await model.choose(name: "locked", bytes: locked)
        XCTAssertTrue(model.otherNeedsPassword)
        await model.unlockOther(password: "wrong")
        XCTAssertTrue(model.otherPasswordWrong)
        XCTAssertNil(model.other)
        await model.unlockOther(password: "warraq")
        XCTAssertEqual(model.other?.password, "warraq")
        XCTAssertEqual(model.chosenName, "locked")

        // The edited copy, newer; then swapped, so the line reads as deleted.
        await model.choose(name: "edited", bytes: try await versions().newer)
        XCTAssertNotNil(model.other)
        model.compare()
        try await waitUntilCompared(model)
        XCTAssertEqual(model.text?.changes.map(\.kind), [.inserted])
        XCTAssertEqual(model.text?.changes.first?.added, line)
        XCTAssertTrue(model.looksComplete)
        XCTAssertEqual(model.changedLooks.map(\.page), [2])
        XCTAssertEqual(model.currentPage, 2, "it opens at the first change")

        model.again()
        model.thisIsOlder = false
        model.compare()
        try await waitUntilCompared(model)
        XCTAssertEqual(model.text?.changes.map(\.kind), [.deleted])
        XCTAssertEqual(model.text?.changes.first?.removed, line)

        // The pictures are the core's drawings of each version's page.
        let picture = await model.picture(of: .newer, page: 2, width: 300)
        XCTAssertEqual(picture.map { Int($0.size.width) }, 300)
        let none = await model.picture(of: .older, page: 9, width: 300)
        XCTAssertNil(none, "no page 9")
        model.close()
    }

    func testNextAndPreviousStepThroughChangesAndPages() async throws {
        let older = try PartB.fixture("coretext-sfarabic-mixed-invoice")
        let model = CompareModel(this: CompareSide(name: "this", bytes: older))
        await model.choose(name: "other", bytes: try PartB.fixture("chrome-cairo-mixed-invoice"))
        model.compare()
        try await waitUntilCompared(model)
        let count = model.changeCount
        XCTAssertGreaterThan(count, 1)
        XCTAssertEqual(model.currentChange, 0)
        model.previousChange()
        XCTAssertEqual(model.currentChange, 0, "not before the first")
        for _ in 0..<(count + 2) { model.nextChange() }
        XCTAssertEqual(model.currentChange, count - 1, "not past the last")
        model.showPage(of: 0)
        XCTAssertEqual(model.mode, .pages)
        XCTAssertEqual(model.currentPage, model.text?.changes[0].page)
        model.close()
    }

    private func waitUntilCompared(_ model: CompareModel, timeout: TimeInterval = 120) async throws {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            switch model.phase {
            case .compared: return
            case let .failed(message): XCTFail("the comparison failed: \(message)"); return
            default: try await Task.sleep(for: .milliseconds(100))
            }
        }
        XCTFail("the comparison never finished")
    }
}
