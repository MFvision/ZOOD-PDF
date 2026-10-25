@testable import PDFEditor
import XCTest

/// The iPhone's catch-up with the desktop: the command book, the deck
/// reader, Sort's rules, numbers for Excel, the Office files' zips and the
/// model's lenient JSON. All of it runs without a model or a network.
@MainActor
final class ParityTests: XCTestCase {
    func testCommandBookRunsToolsAndLeavesQuestionsToTheModel() {
        XCTAssertEqual(CommandBook.match("merge my scans"), .tool(.combine))
        XCTAssertEqual(CommandBook.match("ادمج الملفات"), .tool(.combine))
        XCTAssertEqual(CommandBook.match("رتب ملفاتي"), .tool(.sort))
        XCTAssertEqual(CommandBook.match("convert to excel"), .tool(.quickTools))
        XCTAssertEqual(CommandBook.match("open the lease"), .open("the lease"))
        XCTAssertEqual(CommandBook.match("ابحث عن عقد"), .search("عقد"))
        XCTAssertEqual(CommandBook.match("make me a presentation about our new service"), .presentation)
        XCTAssertEqual(CommandBook.match("summarize the last file"), .summarizeLast)
        XCTAssertNil(CommandBook.match("how do I compress a file?"))
        XCTAssertNil(CommandBook.match("what is the total on this invoice"))
    }

    func testDeckIsAskedAndReadLeniently() {
        XCTAssertTrue(DeckMaker.asked("سوي لي عرض تقديمي عن المبيعات"))
        XCTAssertFalse(DeckMaker.asked("convert this PDF to PowerPoint"))
        XCTAssertEqual(DeckMaker.topic("make a presentation about our Q3 sales."), "our Q3 sales")
        let deck = DeckMaker.parse("""
        Sure! Here it is.
        # **Q3 sales**
        > Where we stand
        ## Why it matters
        - Sales grew
        * Costs fell
        ## Empty slide
        ## Next steps
        1. Hire two people
        """, fallbackTitle: "x")
        XCTAssertEqual(deck.title, "Q3 sales")
        XCTAssertEqual(deck.subtitle, "Where we stand")
        XCTAssertEqual(deck.slides.map(\.title), ["Why it matters", "Next steps"])
        XCTAssertEqual(deck.slides[0].points, ["Sales grew", "Costs fell"])
        let file = DeckMaker.pptx(deck)
        XCTAssertEqual(file.prefix(2), Data("PK".utf8))
    }

    func testSortRules() {
        XCTAssertTrue(SortPlan.saysNothing("IMG_2034"))
        XCTAssertTrue(SortPlan.saysNothing("scan0001"))
        XCTAssertTrue(SortPlan.saysNothing("Document (3)"))
        XCTAssertFalse(SortPlan.saysNothing("Lease Riyadh flat"))
        XCTAssertEqual(SortPlan.topic(of: "tax invoice no. 44"), .invoices)
        XCTAssertEqual(SortPlan.topic(of: "عقد إيجار"), .contracts)
        XCTAssertNil(SortPlan.topic(of: "holiday notes"))
        XCTAssertEqual(SortPlan.series("Report 2024").numbered, false)
        XCTAssertEqual(SortPlan.series("scan 2").base, "scan")
        XCTAssertEqual(SortPlan.series("scan 2").number, 2)
        XCTAssertEqual(SortPlan.documentStarts(["a", "Page 1 of 2", "b", "صفحة 1 من 3"]), [0, 1, 3])
        XCTAssertEqual(SortPlan.namingLine("12/03\nTenancy Agreement\nmore"), "Tenancy Agreement")

        let files = [
            SortPlan.File(url: URL(filePath: "/tmp/scan 1.pdf")),
            SortPlan.File(url: URL(filePath: "/tmp/scan 2.pdf")),
            SortPlan.File(url: URL(filePath: "/tmp/IMG_1.pdf"), pages: ["TAX INVOICE\nTotal 100"]),
        ]
        let suggestions = SortPlan.suggestions(for: files)
        XCTAssertTrue(suggestions.contains(.merge(files: [files[0].url, files[1].url], name: "scan")))
        XCTAssertTrue(suggestions.contains(.folder(file: files[2].url, folder: SortPlan.Topic.invoices.folder)))
        XCTAssertTrue(suggestions.contains { if case .rename(files[2].url, _) = $0 { true } else { false } })
    }

    func testNumbersForExcel() {
        XCTAssertEqual(OfficeExport.number("1,250.50")?.value, 1250.5)
        XCTAssertEqual(OfficeExport.number("١٢٣")?.value, 123)
        XCTAssertEqual(OfficeExport.number("15%")?.percent, true)
        XCTAssertNil(OfficeExport.number("0551234567"))
        XCTAssertNil(OfficeExport.number("12 boxes"))
        let book = OfficeExport.xlsx([OfficeExport.Sheet(name: "Page 1", rows: [[OfficeExport.Cell(text: "Total"), OfficeExport.Cell(text: "100")]])])
        XCTAssertEqual(book.prefix(2), Data("PK".utf8))
    }

    func testModelAssignmentsAreReadLeniently() {
        let answer = "Here you go:\n```json\n[{\"field\":\"name\",\"profileKey\":\"nope\",\"documentQuote\":\" Ali \"}]\n```"
        XCTAssertEqual(ZoodModelEngine.assignments(from: answer), [FieldAssignment(field: "name", profileKey: nil, documentQuote: "Ali")])
        XCTAssertEqual(ZoodModelEngine.assignments(from: "no json"), [])
    }

    func testKeySentencesWithoutAModel() {
        let text = "The rent is 5,000 riyals a month. The lease runs for one year from March. Pets are not allowed in the flat. The tenant pays for water."
        let picked = KeySentences.pick(from: text, count: 2)
        XCTAssertEqual(picked.count, 2)
        XCTAssertTrue(picked.allSatisfy { text.contains($0.trimmingCharacters(in: .whitespaces)) })
    }
}
