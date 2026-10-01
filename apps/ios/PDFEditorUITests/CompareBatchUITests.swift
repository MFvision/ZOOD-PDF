import CryptoKit
import WarraqCore
import XCTest

/// Compare and Batch through the interface, on iPhone and iPad.
///
/// Compare: the three-page Naskh file open, the other version (the same file
/// with one Arabic line added on page 2) chosen from My documents; the
/// counts, the added words and the outlined page read back exactly; Next,
/// Previous and the page view — two pages side by side on iPad, a switch on
/// iPhone.
///
/// Batch: a step added, three files from My documents — one of them not a
/// PDF at all — run; the broken one is reported and the others are done; the
/// results are read back with the core and the originals are byte for byte
/// as they were; the sequence is saved and comes back.
@MainActor
final class CompareBatchUITests: XCTestCase {
    private let line = "سطر جديد للمقارنة"
    private let threePages = "chrome-notonaskh-justified-3pages"
    private let invoice = "coretext-sfarabic-mixed-invoice"
    private let otherVersion = "notonaskh-3pages-line-added"
    private var folders: [URL] = []

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        for folder in folders { try? FileManager.default.removeItem(at: folder) }
    }

    private final class Marker {}

    private func fixture(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle(for: Marker.self).url(forResource: name, withExtension: "pdf"), "\(name).pdf is in the UI test bundle")
    }

    private func folder(_ label: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "\(label)-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        folders.append(url)
        return url
    }

    private func digest(_ url: URL) throws -> String {
        SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
    }

    /// The app on a Documents folder of the test's own, holding `imports`.
    private func launch(language: String, documents: URL, imports: URL, open: URL? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == "ar" ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", "light",
            "-warraqFresh", "1",
            "-warraqDocumentsFolder", documents.path,
            "-warraqImport", imports.path,
        ]
        if let open { app.launchArguments += ["-warraqOpen", open.path] }
        app.launch()
        return app
    }

    private func poll(timeout: TimeInterval = 20, _ condition: () -> Bool) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.3))
        }
        return condition()
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func value(_ element: XCUIElement) -> String {
        element.value as? String ?? ""
    }

    private func screenshot(_ name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"], !directory.isEmpty else { return }
        let slug = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"] ?? (UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.8))
        let image = XCUIScreen.main.screenshot().image
        let size = CGSize(width: image.size.width / 2, height: image.size.height / 2)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        let data = try XCTUnwrap(small.jpegData(compressionQuality: 0.72))
        let url = URL(filePath: directory, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        try data.write(to: url.appending(path: "\(name)-\(slug).jpg"), options: .atomic)
    }

    /// Taps the home's Batch card, brought up from under the bars first (on a
    /// phone it sits low, where the bottom bar takes the tap).
    private func openBatch(_ app: XCUIApplication, _ card: XCUIElement) {
        XCTAssertTrue(card.waitForExistence(timeout: 60), "the home's Batch card")
        let window = app.windows.firstMatch.frame
        var tries = 0
        while card.frame.maxY > window.maxY - 160, tries < 4 {
            app.swipeUp(velocity: .slow)
            tries += 1
        }
        card.tap()
        let add = app.buttons["batch.addStep"]
        XCTAssertTrue(add.waitForExistence(timeout: 20), "Batch opens: \(app.debugDescription.prefix(2000))")
        // The cover is still sliding in when its buttons appear.
        _ = poll(timeout: 10) { add.isHittable }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 1))
    }

    /// Opens Add a step and picks `kind`; asked again if a tap landed while
    /// the screen was still moving.
    private func addStep(_ app: XCUIApplication, _ kind: String, label _: String) {
        let menu = app.buttons["batch.addStep"]
        for _ in 0..<3 {
            menu.tap()
            let byID = app.buttons["batch.addStep.\(kind)"]
            if byID.waitForExistence(timeout: 5) {
                byID.tap()
                break
            }
        }
        XCTAssertTrue(element(app, "batch.step.0").waitForExistence(timeout: 10), "the step is added: \(app.debugDescription.prefix(3000))")
    }

    /// Waits for the run to end (Run is back in the toolbar), then brings the
    /// summary, at the foot of the form, into view.
    private func waitForSummary(_ app: XCUIApplication) -> XCUIElement {
        XCTAssertTrue(poll(timeout: 300) { app.buttons["batch.run"].exists && !app.buttons["batch.stop"].exists }, "the run ends")
        let summary = app.staticTexts["batch.summary"]
        var tries = 0
        while !summary.exists, tries < 5 {
            app.swipeUp()
            tries += 1
        }
        XCTAssertTrue(summary.waitForExistence(timeout: 10), "the summary: \(app.debugDescription.prefix(3000))")
        return summary
    }

    // MARK: - Compare

    func testCompareWithAnotherVersionFromMyDocuments() throws {
        let documents = try folder("compare-docs")
        let imports = try folder("compare-imports")
        try FileManager.default.copyItem(at: fixture(otherVersion), to: imports.appending(path: "\(otherVersion).pdf"))
        let openFolder = try folder("compare-open")
        let opened = openFolder.appending(path: "\(threePages).pdf")
        try FileManager.default.copyItem(at: fixture(threePages), to: opened)
        let before = try digest(opened)

        let app = launch(language: "ar", documents: documents, imports: imports, open: opened)
        let page = element(app, "document.page")
        XCTAssertTrue(page.waitForExistence(timeout: 60), "the document opens")
        let more = app.buttons["document.more"]
        XCTAssertTrue(poll(timeout: 60) { more.exists && more.isEnabled })
        more.tap()
        let compareItem = app.buttons["document.compare"].exists ? app.buttons["document.compare"] : app.buttons["قارِن…"]
        XCTAssertTrue(compareItem.waitForExistence(timeout: 10), "Compare… is in the More menu")
        compareItem.tap()

        // The other version, from My documents.
        let pick = app.buttons["compare.pick.\(otherVersion)"]
        XCTAssertTrue(pick.waitForExistence(timeout: 20), "My documents lists the other version: \(app.debugDescription.prefix(3000))")
        pick.tap()
        let run = app.buttons["compare.run"]
        XCTAssertTrue(poll { run.exists && run.isEnabled }, "Compare is ready once the other version is open")
        try screenshot("compare-choose-ar-light")
        run.tap()

        // The counts, exactly.
        let inserted = element(app, "compare.inserted")
        XCTAssertTrue(inserted.waitForExistence(timeout: 120), "the result")
        XCTAssertEqual(value(inserted), "1")
        XCTAssertEqual(value(element(app, "compare.deleted")), "0")
        XCTAssertEqual(value(element(app, "compare.replaced")), "0")
        XCTAssertEqual(value(element(app, "compare.looksChanged")), "1", "one page looks different")
        // The words added, as the newer version has them, in logical order.
        let added = element(app, "compare.change.0.added")
        XCTAssertTrue(added.waitForExistence(timeout: 10))
        XCTAssertEqual(value(added), line)
        XCTAssertFalse(element(app, "compare.change.0.removed").exists, "nothing was removed")
        XCTAssertFalse(app.buttons["compare.next"].isEnabled, "one change: nowhere to go")
        try screenshot("compare-text-ar-light")

        // The pages: the change's page, outlined.
        app.buttons["compare.change.0.page"].tap()
        let newer = element(app, "compare.page.newer")
        XCTAssertTrue(newer.waitForExistence(timeout: 20))
        if UIDevice.current.userInterfaceIdiom == .pad {
            // Side by side: both versions' page 2 at once.
            XCTAssertTrue(element(app, "compare.page.older").exists)
            XCTAssertFalse(element(app, "compare.version").exists)
            XCTAssertTrue(poll(timeout: 30) { self.value(newer) == "1" && self.value(self.element(app, "compare.page.older")) == "1" },
                          "one box on each version's page: \(value(newer))")
            let older = element(app, "compare.page.older")
            XCTAssertLessThan(abs(older.frame.midY - newer.frame.midY), 2, "side by side")
        } else {
            // One at a time, with a switch.
            XCTAssertFalse(element(app, "compare.page.older").exists)
            XCTAssertTrue(element(app, "compare.version").exists)
            XCTAssertTrue(poll(timeout: 30) { self.value(newer) == "1" }, "one box on the newer page: \(value(newer))")
            app.segmentedControls["compare.version"].buttons["الأقدم"].tap()
            let older = element(app, "compare.page.older")
            XCTAssertTrue(older.waitForExistence(timeout: 10))
            XCTAssertTrue(poll(timeout: 30) { self.value(older) == "1" })
        }
        let shownLabel = element(app, "compare.page.\(UIDevice.current.userInterfaceIdiom == .pad ? "newer" : "older")").label
        XCTAssertTrue(shownLabel.contains("2") || shownLabel.contains("٢"), "page 2: \(shownLabel)")
        XCTAssertFalse(app.buttons["compare.next"].isEnabled, "no other page looks different")
        try screenshot("compare-pages-ar-light")

        app.buttons["compare.close"].tap()
        XCTAssertEqual(try digest(opened), before, "the open file is untouched")
    }

    func testCompareInEnglishStepsThroughChanges() throws {
        let documents = try folder("compare-en-docs")
        let imports = try folder("compare-en-imports")
        // The other invoice: a different document, many changes.
        try FileManager.default.copyItem(at: fixture("chrome-cairo-mixed-invoice"), to: imports.appending(path: "chrome-cairo-mixed-invoice.pdf"))
        let openFolder = try folder("compare-en-open")
        let opened = openFolder.appending(path: "\(invoice).pdf")
        try FileManager.default.copyItem(at: fixture(invoice), to: opened)

        let app = launch(language: "en", documents: documents, imports: imports, open: opened)
        XCTAssertTrue(element(app, "document.page").waitForExistence(timeout: 60))
        let more = app.buttons["document.more"]
        XCTAssertTrue(poll(timeout: 60) { more.exists && more.isEnabled })
        more.tap()
        app.buttons["document.compare"].firstMatch.tap()
        app.buttons["compare.pick.chrome-cairo-mixed-invoice"].tap()
        let run = app.buttons["compare.run"]
        XCTAssertTrue(poll { run.isEnabled })
        run.tap()

        let position = app.staticTexts["compare.position"]
        XCTAssertTrue(position.waitForExistence(timeout: 120))
        let total = Int(value(element(app, "compare.inserted")))! + Int(value(element(app, "compare.deleted")))! + Int(value(element(app, "compare.replaced")))!
        XCTAssertGreaterThan(total, 1)
        XCTAssertEqual(position.label, "Change 1 of \(total)", "the tiles add up to the changes listed")
        XCTAssertFalse(app.buttons["compare.previous"].isEnabled)
        app.buttons["compare.next"].tap()
        XCTAssertEqual(position.label, "Change 2 of \(total)")
        app.buttons["compare.previous"].tap()
        XCTAssertEqual(position.label, "Change 1 of \(total)")
        try screenshot("compare-text-en-light")
        app.buttons["compare.close"].tap()
    }

    // MARK: - Batch

    func testBatchOverMyDocumentsWithABrokenFile() throws {
        let documents = try folder("batch-docs")
        let imports = try folder("batch-imports")
        for name in [threePages, invoice] {
            try FileManager.default.copyItem(at: fixture(name), to: imports.appending(path: "\(name).pdf"))
        }
        // Not a PDF, whatever its name says.
        try Data("%PDF-1.7\nthis is not a PDF at all\n%%EOF".utf8).write(to: imports.appending(path: "broken.pdf"))

        let app = launch(language: "en", documents: documents, imports: imports)
        let card = app.buttons["home.batch"]
        openBatch(app, card)

        // One step: delete page 1.
        addStep(app, "deletePages", label: "Delete pages")
        XCTAssertTrue(element(app, "batch.step.0").waitForExistence(timeout: 10))

        // Every file of My documents.
        app.buttons["batch.addLibrary"].tap()
        let all = app.buttons["batch.library.all"]
        XCTAssertTrue(all.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["batch.library.broken"].exists, "the broken file is listed with the rest")
        all.tap()
        app.buttons["batch.library.add"].tap()
        XCTAssertTrue(element(app, "batch.file.broken").waitForExistence(timeout: 10))
        let originals = try [threePages, invoice, "broken"].map { try digest(documents.appending(path: "\($0).pdf")) }
        try screenshot("batch-ready-en-light")

        let run = app.buttons["batch.run"]
        XCTAssertTrue(poll { run.isEnabled })
        run.tap()
        let summary = waitForSummary(app)
        XCTAssertEqual(summary.label, "Done 1 · Failed 2 · Stopped 0")
        XCTAssertEqual(value(element(app, "batch.file.broken")), "Not done: This file is not a PDF that can be opened.")
        XCTAssertEqual(value(element(app, "batch.file.\(threePages)")), "Saved as \(threePages) – processed.pdf")
        // The invoice has one page: deleting it would leave none, and the row says so.
        XCTAssertEqual(value(element(app, "batch.file.\(invoice)")), "Not done at step 1, Delete pages: Deleting those pages would leave no page.")
        XCTAssertFalse(FileManager.default.fileExists(atPath: documents.appending(path: "\(invoice) – processed.pdf").path))
        try screenshot("batch-report-en-light")

        // Read back: the result has the old page 2 as its page 1, word for word.
        let result = documents.appending(path: "\(threePages) – processed.pdf")
        let expectation = expectation(description: "read back")
        Task {
            do {
                let original = try await Core.open(bytes: try Data(contentsOf: documents.appending(path: "\(threePages).pdf")))
                let made = try await Core.open(bytes: try Data(contentsOf: result))
                let count = await made.pageCount
                XCTAssertEqual(count, 2)
                let resultFirst = try await made.extractText(page: 0)
                let originalSecond = try await original.extractText(page: 1)
                XCTAssertEqual(resultFirst, originalSecond)
            } catch {
                XCTFail("reading the result: \(error)")
            }
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 60)
        // The originals, byte for byte as they were.
        XCTAssertEqual(try [threePages, invoice, "broken"].map { try digest(documents.appending(path: "\($0).pdf")) }, originals)

        // Saved, and back again after the screen is closed.
        app.buttons["batch.save"].tap()
        let name = app.textFields["batch.save.name"].exists ? app.textFields["batch.save.name"] : app.alerts.textFields.firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("Cover")
        let confirm = app.buttons["batch.save.confirm"]
        (confirm.exists ? confirm : app.alerts.buttons["Save"].firstMatch).tap()
        app.buttons["batch.close"].tap()
        openBatch(app, card)
        let saved = app.buttons["batch.saved.Cover"]
        XCTAssertTrue(saved.waitForExistence(timeout: 20), "the saved sequence is listed")
        XCTAssertFalse(element(app, "batch.step.0").exists, "a fresh screen has no steps")
        saved.tap()
        XCTAssertTrue(element(app, "batch.step.0").waitForExistence(timeout: 10), "its step comes back")
        XCTAssertTrue(element(app, "batch.step.0").label.contains("Delete pages"))
        try screenshot("batch-saved-en-light")
        app.buttons["batch.close"].tap()
    }

    func testBatchInArabic() throws {
        let documents = try folder("batch-ar-docs")
        let imports = try folder("batch-ar-imports")
        try FileManager.default.copyItem(at: fixture(invoice), to: imports.appending(path: "\(invoice).pdf"))
        let app = launch(language: "ar", documents: documents, imports: imports)
        let card = app.buttons["home.batch"]
        openBatch(app, card)
        addStep(app, "compress", label: "ضغط")
        app.buttons["batch.addLibrary"].tap()
        app.buttons["batch.library.\(invoice)"].tap()
        app.buttons["batch.library.add"].tap()
        let run = app.buttons["batch.run"]
        XCTAssertTrue(poll { run.isEnabled })
        run.tap()
        let summary = waitForSummary(app)
        XCTAssertTrue(summary.label.hasPrefix("أُنجز"), summary.label)
        let row = element(app, "batch.file.\(invoice)")
        // The file's name is isolated inside the Arabic sentence (U+2068 … U+2069), as it should be.
        XCTAssertEqual(value(row), "حُفظ باسم \u{2068}\(invoice) – معالَج.pdf\u{2069}")
        XCTAssertTrue(FileManager.default.fileExists(atPath: documents.appending(path: "\(invoice) – معالَج.pdf").path))
        try screenshot("batch-report-ar-light")
        app.buttons["batch.close"].tap()
    }
}
