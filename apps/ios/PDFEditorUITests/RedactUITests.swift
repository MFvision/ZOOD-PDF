import WarraqCore
import XCTest

/// Redact through the interface: words found and marked, a word tapped on
/// the page, applied after the warning, saved — and the saved file read by
/// the core in the test runner: each line exactly what is left of it, the
/// marked words nowhere in its text or its bytes. Hidden information
/// checked and removed the same way.
@MainActor
final class RedactUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    static let contract = "contract"

    /// Opens Redact from the More menu and waits for its bar.
    private func openRedact(_ ui: PartBApp) {
        ui.more("document.redact")
        XCTAssertTrue(ui.app.descendants(matching: .any).matching(identifier: "redact.bar").firstMatch.waitForExistence(timeout: 20),
                      "the redact bar: \(ui.tree)")
    }

    /// A button of the redact bar, brought into the window first.
    private func tapBar(_ ui: PartBApp, _ identifier: String) {
        let button = ui.app.buttons[identifier]
        let bar = ui.app.descendants(matching: .any).matching(identifier: "redact.bar").firstMatch
        XCTAssertTrue(ui.poll(timeout: 20) { button.exists }, "redact button \(identifier): \(ui.tree)")
        // The bar's tools scroll inside it (Apply and Done stay beside
        // it): the button is brought inside the bar's own frame, not just
        // the window's.
        var tries = 0
        while bar.exists, !bar.frame.insetBy(dx: 2, dy: 0).contains(button.frame), tries < 8 {
            if button.frame.minX < bar.frame.minX + 2 { bar.swipeRight() } else { bar.swipeLeft() }
            tries += 1
        }
        XCTAssertTrue(ui.poll(timeout: 10) { button.exists && button.isHittable }, "redact button \(identifier): \(ui.tree)")
        button.tap()
    }

    /// The marks' labels as the list shows them — beside the pages on iPad,
    /// in a sheet on a phone (closed again afterwards).
    private func markLabels(_ ui: PartBApp, count: Int) -> [String] {
        let sheet = !ui.isPad
        if sheet { tapBar(ui, "redact.marks") }
        var labels: [String] = []
        for index in 0..<count {
            let row = ui.app.buttons["redact.mark.\(index)"]
            XCTAssertTrue(row.waitForExistence(timeout: 20), "mark \(index) is listed: \(ui.tree)")
            // The label is what the core read under the mark; it arrives a
            // moment after the mark does.
            _ = ui.poll(timeout: 10) { row.label != "—" }
            labels.append(row.label)
        }
        XCTAssertFalse(ui.app.buttons["redact.mark.\(count)"].exists, "no more marks than \(count)")
        if sheet {
            ui.app.buttons["sheet.done"].tap()
            _ = ui.poll(timeout: 10) { !ui.app.buttons["sheet.done"].exists }
        }
        return labels
    }

    /// Apply, the warning answered, the summary dismissed.
    private func applyMarks(_ ui: PartBApp) {
        tapBar(ui, "redact.apply")
        let alert = ui.app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 20), "the warning before applying: \(ui.tree)")
        // The destructive button of the warning, in either language.
        let apply = alert.buttons.matching(NSPredicate(format: "label IN %@", ["Apply", "تطبيق"])).firstMatch
        XCTAssertTrue(apply.exists, "the warning's Apply: \(alert.debugDescription)")
        apply.tap()
        // Then what was taken out, said in a second alert.
        let summary = ui.app.alerts.matching(NSPredicate(format: "label IN %@", ["Redacted", "تمّ الحجب"])).firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout: 40), "the summary: \(ui.tree)")
        summary.buttons.firstMatch.tap()
        ui.waitForEdited()
    }

    /// Saves, and answers the saved file's bytes.
    private func save(_ ui: PartBApp) throws -> Data {
        tapBar(ui, "redact.done")
        let save = ui.app.buttons["document.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 20), "Save: \(ui.tree)")
        save.tap()
        XCTAssertTrue(ui.poll(timeout: 30) { !save.exists }, "the document is saved")
        return try Data(contentsOf: try XCTUnwrap(ui.fileURL))
    }

    /// Each line of the saved file's page, as the core reads it.
    private func lines(_ bytes: Data, page: Int = 0) async throws -> [String] {
        let core = try await Core.open(bytes: bytes)
        return try await core.textLines(page: page).map(\.text)
    }

    /// `word` nowhere in the file — its bytes or any stream, any encoding —
    /// and found by the core's search nowhere.
    private func assertGone(_ word: String, from bytes: Data) async throws {
        let be = Data(word.utf16.flatMap { [UInt8($0 >> 8), UInt8($0 & 0xFF)] })
        for part in readable(bytes) {
            XCTAssertNil(part.range(of: Data(word.utf8)), "\(word) is still in the file")
            XCTAssertNil(part.range(of: be), "\(word) is still in the file, UTF-16")
        }
        struct Args: Encodable { let query: String }
        let core = try await Core.open(bytes: bytes)
        let reply = try await core.call(op: "redact.find", args: Args(query: word))
        XCTAssertEqual(reply.object["total"] as? Int, 0, "the search still finds \(word)")
    }

    /// The file's bytes and every Flate stream in it inflated.
    private func readable(_ bytes: Data) -> [Data] {
        var parts = [bytes]
        var at = bytes.startIndex
        while let s = bytes.range(of: Data("stream".utf8), in: at..<bytes.endIndex) {
            var body = s.upperBound
            while body < bytes.endIndex, bytes[body] == 0x0D || bytes[body] == 0x0A { body += 1 }
            guard let e = bytes.range(of: Data("endstream".utf8), in: body..<bytes.endIndex) else { break }
            if let plain = try? (Data(bytes[body..<e.lowerBound].dropFirst(2)) as NSData).decompressed(using: .zlib) as Data {
                parts.append(plain)
            }
            at = e.upperBound
        }
        return parts
    }

    // MARK: - Find and redact

    func testFoundWordsAreMarkedAppliedAndGoneFromTheSavedFile() async throws {
        let ui = try PartBApp.launch(fixture: Self.contract)
        ui.waitForPage(containing: "Contract")
        openRedact(ui)
        tapBar(ui, "redact.find")
        ui.type("Haddad", into: "redact.find.query")
        ui.app.buttons["redact.find.go"].tap()
        let count = ui.app.staticTexts["redact.find.count"]
        XCTAssertTrue(count.waitForExistence(timeout: 30), "the matches are listed: \(ui.tree)")
        XCTAssertEqual(count.label, "Found: 2")
        let mark = ui.app.buttons["redact.find.mark"]
        XCTAssertEqual(mark.label, "Mark 2")
        mark.tap()
        XCTAssertEqual(markLabels(ui, count: 2), ["Haddad", "haddad"])
        applyMarks(ui)
        let saved = try save(ui)
        let read = try await lines(saved)
        XCTAssertEqual(read[0], "Contract between Warraq Labs and Nadia")
        XCTAssertEqual(read[1], "Contact: nadia. @example.com, phone +966 50 123 4567")
        try await assertGone("Haddad", from: saved)
        try await assertGone("haddad", from: saved)
    }

    /// In Arabic, an Arabic name found without its diacritics.
    func testArabicFoundAndRedactedInAnArabicInterface() async throws {
        let ui = try PartBApp.launch(language: PartBApp.arabic, fixture: Self.contract)
        ui.waitForPage(containing: "العقد")
        openRedact(ui)
        tapBar(ui, "redact.find")
        ui.type("وراق", into: "redact.find.query")
        ui.app.buttons["redact.find.go"].tap()
        XCTAssertTrue(ui.app.buttons["redact.match.ورّاق"].waitForExistence(timeout: 30), "found with its shadda: \(ui.tree)")
        ui.app.buttons["redact.find.mark"].tap()
        XCTAssertEqual(markLabels(ui, count: 1), ["ورّاق"])
        applyMarks(ui)
        let saved = try save(ui)
        let read = try await lines(saved)
        XCTAssertTrue(read.contains("العقد بين شركة  والسيدة نادية"), "\(read)")
        try await assertGone("ورّاق", from: saved)
    }

    // MARK: - Marked by hand

    /// A word tapped on the page: marked, named by the core, taken out.
    func testATappedWordIsMarkedNamedAndTakenOut() async throws {
        let ui = try PartBApp.launch(fixture: Self.contract)
        ui.waitForPage(containing: "Contract")
        openRedact(ui)
        let page = ui.app.descendants(matching: .any).matching(identifier: "redact.layer.0").firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 20), "the page's redact layer: \(ui.tree)")
        // "Contract" is set at 12 pt from (56, 50) on a 595 × 842 page.
        let frame = page.frame
        let point = page.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: frame.width * 76 / 595, dy: frame.height * 57 / 842))
        point.tap()
        XCTAssertEqual(markLabels(ui, count: 1), ["Contract"])
        applyMarks(ui)
        let saved = try save(ui)
        let read = try await lines(saved)
        XCTAssertEqual(read[0], "between Warraq Labs and Nadia Haddad")
        try await assertGone("Contract", from: saved)
    }

    // MARK: - Hidden information

    func testHiddenInformationIsCheckedAndRemoved() async throws {
        let ui = try PartBApp.launch(fixture: PartBApp.outlines)
        XCTAssertTrue(ui.page.waitForExistence(timeout: 40))
        openRedact(ui)
        tapBar(ui, "redact.hidden")
        ui.app.buttons["hidden.check"].tap()
        let metadata = ui.app.switches["hidden.kind.metadata"]
        XCTAssertTrue(metadata.waitForExistence(timeout: 30), "the metadata is reported: \(ui.tree)")
        XCTAssertTrue(ui.app.switches["hidden.kind.bookmarks"].exists)
        ui.app.buttons["hidden.remove"].tap()
        let alert = ui.app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        alert.buttons.matching(NSPredicate(format: "label IN %@", ["Remove", "إزالة"])).firstMatch.tap()
        XCTAssertTrue(ui.poll(timeout: 30) { !metadata.exists }, "checked again: no metadata left")
        ui.app.buttons["hidden.close"].tap()
        let saved = try save(ui)
        let reply = try await Core.callStatic(op: "redact.inspect", args: "{}", blobs: [saved])
        let kinds = ((reply.object["findings"] as? [[String: Any]]) ?? []).compactMap { $0["kind"] as? String }
        XCTAssertFalse(kinds.contains("metadata"), "\(kinds)")
        XCTAssertFalse(kinds.contains("bookmarks"), "\(kinds)")
        XCTAssertEqual(reply.object["revisions"] as? Int, 0)
    }
}
