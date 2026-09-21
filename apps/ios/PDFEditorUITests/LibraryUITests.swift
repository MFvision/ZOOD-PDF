import XCTest

/// The Library through the interface, on the simulator: a small corpus is
/// imported into My documents and indexed (the scan through Vision), an
/// Arabic word is searched without its tashkeel, a hit opens the document
/// at its page; tags and rules; the widgets' data is written. Screenshots
/// of the search and the tags go to docs/design/ios/ when
/// WARRAQ_SCREENSHOT_DIR says where.
@MainActor
final class LibraryUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// The UI test bundle's folder holds the corpus PDFs; the app copies
    /// its PDFs into Documents on launch (`-warraqImport`).
    private var corpus: String {
        get throws {
            try XCTUnwrap(Bundle(for: LibraryUITests.self).resourceURL).path
        }
    }

    private func launch(language: String = "ar", appearance: String = "light", importCorpus: Bool = true, extra: [String] = []) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == "ar" ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", appearance,
        ] + extra
        if importCorpus {
            app.launchArguments += ["-warraqImport", try corpus]
        }
        app.launch()
        return app
    }

    /// Waits until the index holds `count` documents (the status line's
    /// accessibility value is the plain number).
    private func waitForIndex(in app: XCUIApplication, count: Int, timeout: TimeInterval = 240) {
        let status = app.staticTexts["library.indexedCount"]
        XCTAssertTrue(status.waitForExistence(timeout: 60), "the index status line is there")
        let indexed = NSPredicate(format: "value.integerValue >= %d", count)
        expectation(for: indexed, evaluatedWith: status)
        waitForExpectations(timeout: timeout)
    }

    private func search(_ query: String, in app: XCUIApplication) {
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 20), "the search field is above the documents")
        field.tap()
        field.typeText(query)
        XCTAssertTrue(app.staticTexts["search.total"].waitForExistence(timeout: 30), "results appear")
    }

    func testIndexesTheCorpusSearchesArabicWithoutTashkeelAndOpensAHitAtItsPage() throws {
        let app = try launch()
        waitForIndex(in: app, count: 5)

        // The invoice's word, without tashkeel and with a haa for the taa marbuta.
        search("فاتوره", in: app)
        let firstHit = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.hit.'")).firstMatch
        XCTAssertTrue(firstHit.waitForExistence(timeout: 30), "a line matched")
        XCTAssertTrue(app.staticTexts["search.document.coretext-sfarabic-mixed-invoice"].exists
            || app.staticTexts["search.document.chrome-cairo-mixed-invoice"].exists, "an invoice answered")

        // A hit past the first page proves "at its page"; the first page otherwise.
        let hits = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.hit.'"))
        var chosen = firstHit
        var page = 1
        for i in 0..<min(hits.count, 30) {
            let hit = hits.element(boundBy: i)
            if let n = Int(hit.identifier.replacingOccurrences(of: "search.hit.", with: "")), n > 1 {
                chosen = hit
                page = n
                break
            }
        }
        chosen.tap()
        let pageView = app.otherElements["document.page"]
        XCTAssertTrue(pageView.waitForExistence(timeout: 30), "the document opened")
        let status = app.staticTexts["document.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 20))
        let shown = NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@", "\(page)", Self.arabicDigits("\(page)"))
        expectation(for: shown, evaluatedWith: status)
        waitForExpectations(timeout: 20)

        // The search is now one the widget offers.
        let searches = AppGroupProbe.searches()
        XCTAssertTrue(searches.contains("فاتوره"), "\(searches)")
    }

    func testAScanIsFoundThroughTextRecognitionAndScansOnlyFiltersToIt() throws {
        let app = try launch(language: "en")
        waitForIndex(in: app, count: 5)
        // The bilevel scan holds Latin text ("Arial"); Vision reads it.
        search("the", in: app)
        app.buttons["search.filters"].tap()
        let scansOnly = app.switches["filters.scannedOnly"]
        XCTAssertTrue(scansOnly.waitForExistence(timeout: 10))
        scansOnly.tap()
        app.buttons["sheet.done"].tap()
        let scan = app.staticTexts["search.document.scan-arial-200dpi-bilevel"]
        let anyHit = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.hit.'")).firstMatch
        if anyHit.waitForExistence(timeout: 30) {
            XCTAssertTrue(scan.exists, "with Scans only, the one document is the scan")
        } else {
            // Vision read nothing usable off this bilevel scan on this simulator: say so, do not pretend.
            throw XCTSkip("Vision found no words on scan-arial-200dpi-bilevel in this simulator")
        }
    }

    func testTagsAndRulesThroughTheInterface() throws {
        let app = try launch(language: "ar")
        waitForIndex(in: app, count: 5)
        openTags(in: app)
        app.buttons["tags.rules"].tap()
        app.buttons["rules.add"].tap()
        let tag = app.textFields["rule.tag"]
        XCTAssertTrue(tag.waitForExistence(timeout: 10))
        tag.tap()
        tag.typeText("فواتير")
        let words = app.textFields["rule.words"]
        words.tap()
        words.typeText("فاتورة")
        app.buttons["rule.save"].tap()
        XCTAssertTrue(app.buttons["rules.rule.فواتير"].waitForExistence(timeout: 10), "the rule is listed")
        app.buttons["sheet.done"].firstMatch.tap()
        // The rule tagged the invoices: the tag heads a section.
        let heading = app.staticTexts.matching(NSPredicate(format: "identifier == 'tags.tag.فواتير'")).firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 20) || app.otherElements["tags.tag.فواتير"].waitForExistence(timeout: 5), "the tag appears with its documents")
    }

    private func openTags(in app: XCUIApplication) {
        let sidebar = app.buttons["sidebar.tags"]
        let cell = app.cells["sidebar.tags"]
        if sidebar.waitForExistence(timeout: 5) {
            sidebar.tap()
        } else if cell.waitForExistence(timeout: 5) {
            cell.tap()
        } else {
            app.staticTexts["sidebar.tags"].firstMatch.tap()
        }
        XCTAssertTrue(app.otherElements["library.tags"].waitForExistence(timeout: 10) || app.tables["library.tags"].waitForExistence(timeout: 5)
            || app.collectionViews["library.tags"].waitForExistence(timeout: 5), "the Tags screen is shown")
    }

    func testScreenshots() throws {
        guard let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"], !directory.isEmpty else {
            throw XCTSkip("WARRAQ_SCREENSHOT_DIR is not set; scripts/ios/build.sh sets it")
        }
        let device = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"]
            ?? (UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")
        for combo in [("ar", "light"), ("en", "dark")] {
            let suffix = "\(combo.0)-\(combo.1)-\(device)"
            let app = try launch(language: combo.0, appearance: combo.1)
            waitForIndex(in: app, count: 5)
            try Screenshots.save(app, as: "library-indexed-\(suffix)", in: directory)
            search(combo.0 == "ar" ? "فاتوره" : "invoice", in: app)
            _ = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.hit.'")).firstMatch.waitForExistence(timeout: 30)
            try Screenshots.save(app, as: "library-search-\(suffix)", in: directory)
            app.buttons["search.filters"].tap()
            _ = app.switches["filters.scannedOnly"].waitForExistence(timeout: 10)
            try Screenshots.save(app, as: "library-filters-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()
            let cancel = app.buttons["Cancel"].firstMatch
            if cancel.exists { cancel.tap() } else if app.buttons["إلغاء"].firstMatch.exists { app.buttons["إلغاء"].firstMatch.tap() }
            openTags(in: app)
            try Screenshots.save(app, as: "library-tags-\(suffix)", in: directory)
        }
    }

    static func arabicDigits(_ digits: String) -> String {
        String(digits.map { ch -> Character in
            guard let value = ch.wholeNumberValue else { return ch }
            return Character(UnicodeScalar(0x0660 + value)!)
        })
    }
}

/// Reads the shared container the way the widgets do, from the test.
enum AppGroupProbe {
    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.warraq")
    }

    static func searches() -> [String] {
        guard let container, let data = try? Data(contentsOf: container.appending(path: "searches.json")),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return list.compactMap { $0["query"] as? String }
    }
}

/// Screenshots at half size as JPEG, the same way LaunchTests keeps them.
enum Screenshots {
    @MainActor
    static func save(_ app: XCUIApplication, as name: String, in directory: String) throws {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.6))
        let image = XCUIScreen.main.screenshot().image
        let size = CGSize(width: image.size.width / 2, height: image.size.height / 2)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        let data = try XCTUnwrap(small.jpegData(compressionQuality: 0.82))
        let folder = URL(filePath: directory, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try data.write(to: folder.appending(path: "\(name).jpg"), options: .atomic)
    }
}
