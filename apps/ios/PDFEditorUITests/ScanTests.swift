import UIKit
import Vision
import WarraqCore
import XCTest

/// The scanner through the interface, on the simulator: a photo from the
/// library (put there by `simctl addmedia`) becomes a page, its corners are
/// dragged, it is enhanced with the original held for comparison, its
/// text is read, and it is saved as a PDF — which the test then opens with
/// the core and searches for a word without its tashkeel. ID mode composes
/// a card's two sides on one page; book mode splits a spread. Then every
/// screen is photographed in Arabic and English, light and dark.
@MainActor
final class ScanTests: XCTestCase {
    nonisolated(unsafe) private var folder: URL!
    private var bundle: Bundle { Bundle(for: ScanTests.self) }

    override func setUpWithError() throws {
        continueAfterFailure = false
        folder = FileManager.default.temporaryDirectory.appending(path: "scan-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func fixture(_ name: String) throws -> URL {
        try XCTUnwrap(bundle.url(forResource: name, withExtension: "jpg"), "\(name).jpg is in the UI test bundle")
    }

    /// Launches the app with its documents in this test's folder; with
    /// `scan`, the scanner opens on those photos in `mode`.
    private func launch(language: String, appearance: String = "light", scan: [URL] = [], mode: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == "ar" ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", appearance,
            "-warraqDocumentsFolder", folder.path,
            "-warraqReset", "1",
        ]
        if !scan.isEmpty {
            app.launchArguments += ["-warraqScan", scan.map(\.path).joined(separator: ",")]
        }
        if let mode {
            app.launchArguments += ["-warraqScanMode", mode]
        }
        app.launch()
        return app
    }

    /// The pipeline has drawn the page: the stage no longer shows corners.
    private func waitForPage(_ index: Int, in app: XCUIApplication, timeout: TimeInterval = 90) {
        XCTAssertTrue(app.buttons["scan.page.\(index)"].waitForExistence(timeout: timeout), "page \(index + 1) is in the stack")
        let done = NSPredicate(format: "exists == false")
        expectation(for: done, evaluatedWith: app.descendants(matching: .any)["scan.processing"])
        waitForExpectations(timeout: timeout)
    }

    /// The newest PDF in the test's folder.
    private func savedPDF() throws -> Data {
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])
            .filter { $0.pathExtension == "pdf" }
        let newest = try XCTUnwrap(files.max { a, b in
            ((try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
                < ((try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
        }, "a PDF was saved into \(folder.path)")
        return try Data(contentsOf: newest)
    }

    // MARK: - The whole way through

    func testScansAPhotoFromTheLibraryIntoASearchablePDF() async throws {
        let app = launch(language: "ar")
        XCTAssertTrue(app.buttons["library.scan"].waitForExistence(timeout: 30))
        app.buttons["library.scan"].tap()
        XCTAssertTrue(app.buttons["scan.photos"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["scan.shutterCaption"].exists, "the shutter says there is no camera here")

        // From the simulator's photo library: the newest photo is the corpus
        // page simctl addmedia put there (scripts/ios/build.sh).
        app.buttons["scan.photos"].tap()
        try pickNewestPhoto(in: app)
        waitForPage(0, in: app)
        XCTAssertTrue(app.descendants(matching: .any)["scan.stage"].exists)

        // The corners: Auto off puts the handles on the whole photo; the
        // top-left one dragged inwards moves.
        app.descendants(matching: .any)["scan.auto"].firstMatch.tap()
        let handle = app.descendants(matching: .any)["crop.handle.0"]
        XCTAssertTrue(handle.waitForExistence(timeout: 10))
        let before = try XCTUnwrap(handle.value as? String)
        let grab = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        grab.press(forDuration: 0.3, thenDragTo: grab.withOffset(CGVector(dx: 40, dy: 40)))
        let after = try XCTUnwrap(handle.value as? String)
        XCTAssertNotEqual(before, after, "the handle followed the finger")
        app.buttons["scan.cut"].tap()
        waitForPage(0, in: app)
        XCTAssertTrue(app.buttons["scan.corners"].waitForExistence(timeout: 5), "the page is cut out; the corners can come back")

        // Enhance: black and white, creases off, hold to compare.
        app.buttons["scan.enhance"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["enhance.form"].firstMatch.waitForExistence(timeout: 10))
        let modes = app.segmentedControls["enhance.mode"]
        XCTAssertTrue(modes.waitForExistence(timeout: 5))
        modes.buttons.element(boundBy: 2).tap()
        app.switches["enhance.creases"].firstMatch.tap()
        let compare = app.descendants(matching: .any)["enhance.original"].firstMatch
        if !compare.waitForExistence(timeout: 3) {
            // Below the sheet's fold on a phone: a list makes its rows as they scroll in.
            app.swipeUp()
        }
        XCTAssertTrue(compare.waitForExistence(timeout: 5))
        compare.press(forDuration: 1.0)
        app.buttons["sheet.done"].tap()
        waitForPage(0, in: app)

        // The text, read and copied.
        app.buttons["scan.text"].tap()
        XCTAssertTrue(app.buttons["text.read"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["scan.languages"].exists, "the languages read are named")
        app.buttons["text.read"].tap()
        XCTAssertTrue(app.staticTexts["text.body"].waitForExistence(timeout: 120), "Vision read the page")
        app.buttons["text.copy"].tap()
        app.buttons["sheet.done"].tap()

        // Save as PDF with the text layer; the Library opens it.
        app.buttons["scan.save"].tap()
        XCTAssertTrue(app.buttons["save.confirm"].waitForExistence(timeout: 10))
        app.buttons["save.confirm"].tap()
        let page = app.otherElements["document.page"]
        XCTAssertTrue(page.waitForExistence(timeout: 180), "the saved scan opened")

        // Through the core: the layer is searchable without tashkeel.
        let bytes = try savedPDF()
        let core = try await Core.open(bytes: bytes)
        let pages = await core.pageCount
        XCTAssertEqual(pages, 1)
        let languages = (try? VNRecognizeTextRequest().supportedRecognitionLanguages()) ?? []
        let readsArabic = languages.contains { $0.lowercased().hasPrefix("ar") }
        if readsArabic {
            let hits = try await core.search("محرر")
            XCTAssertEqual(hits, [0], "«محرّر» is found as «محرر»")
        } else {
            let hits = try await core.search("OpenType")
            XCTAssertEqual(hits, [0], "the Latin word on the page is found (Arabic is not read on this device)")
        }
        let text = try await core.extractText(page: 0)
        XCTAssertFalse(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "the page carries text")
        let value = try XCTUnwrap(page.value as? String)
        XCTAssertFalse(value.isEmpty, "the document view reads the layer through the core")
    }

    /// The system photo picker: its newest photo, tapped, then the
    /// picker's Add (a multi-selection picker) when it shows one.
    private func pickNewestPhoto(in app: XCUIApplication) throws {
        let images = app.images.matching(NSPredicate(format: "label CONTAINS[c] 'photo' OR label CONTAINS 'صورة' OR identifier CONTAINS 'PXG'"))
        XCTAssertTrue(images.firstMatch.waitForExistence(timeout: 30), "the photo library shows its photos")
        images.firstMatch.tap()
        let add = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Add' OR label BEGINSWITH 'إضافة' OR label == 'Done' OR label == 'تم'")).firstMatch
        if add.waitForExistence(timeout: 5) {
            add.tap()
        }
    }

    // MARK: - ID and book modes

    func testIDModeComposesFrontAndBackOnOnePage() async throws {
        let app = launch(language: "en", scan: [try fixture("id-front"), try fixture("id-back")], mode: "idCard")
        waitForPage(1, in: app)
        XCTAssertTrue(app.buttons["scan.page.0"].label.contains("1"))
        let stage = app.descendants(matching: .any)["scan.stage"]
        let composed = expectation(for: NSPredicate(format: "label CONTAINS[c] 'card size'"), evaluatedWith: stage)
        await fulfillment(of: [composed], timeout: 60)

        app.buttons["scan.save"].tap()
        XCTAssertTrue(app.buttons["save.confirm"].waitForExistence(timeout: 10))
        app.switches["save.ocr"].firstMatch.tap()
        app.buttons["save.confirm"].tap()
        XCTAssertTrue(app.otherElements["document.page"].waitForExistence(timeout: 120))

        let core = try await Core.open(bytes: try savedPDF())
        let pages = await core.pageCount
        XCTAssertEqual(pages, 1, "both sides on one page")
        let size = try await core.pageSize(0)
        XCTAssertEqual(size.width, 595.276, accuracy: 0.01)
        XCTAssertEqual(size.height, 841.89, accuracy: 0.01)
    }

    func testBookModeSplitsASpreadIntoTwoPages() async throws {
        let app = launch(language: "ar", scan: [try fixture("book-spread")], mode: "book")
        waitForPage(1, in: app)
        XCTAssertFalse(app.buttons["scan.page.2"].exists, "one spread, two pages")
        app.buttons["scan.save"].tap()
        XCTAssertTrue(app.buttons["save.confirm"].waitForExistence(timeout: 10))
        app.buttons["save.confirm"].tap()
        XCTAssertTrue(app.otherElements["document.page"].waitForExistence(timeout: 180))
        let core = try await Core.open(bytes: try savedPDF())
        let pages = await core.pageCount
        XCTAssertEqual(pages, 2)
        let hits = try await core.search("scanner")
        XCTAssertEqual(hits, [0, 1], "the English text of both halves was read into the layer")
    }

    // MARK: - Screenshots

    func testScanScreenshots() throws {
        guard let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"], !directory.isEmpty else {
            throw XCTSkip("WARRAQ_SCREENSHOT_DIR is not set; scripts/ios/build.sh sets it")
        }
        let device = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"]
            ?? (UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")
        let combos: [(language: String, appearance: String)] = [("ar", "light"), ("ar", "dark"), ("en", "light"), ("en", "dark")]
        for combo in combos {
            let suffix = "\(combo.language)-\(combo.appearance)-\(device)"
            var app = launch(language: combo.language, appearance: combo.appearance, scan: [try fixture("page-crooked")])
            waitForPage(0, in: app)
            try save(app, as: "scan-\(suffix)", in: directory)

            // Auto off: the corners on the whole photo; mid-drag, so the
            // magnifier is in the picture.
            let handle = app.descendants(matching: .any)["crop.handle.0"]
            XCTAssertTrue(handle.waitForExistence(timeout: 10))
            let target = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: 30, dy: 30))
            handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.3, thenDragTo: target, withVelocity: .slow, thenHoldForDuration: 0.1)
            try save(app, as: "scan-corners-\(suffix)", in: directory)
            app.buttons["scan.cut"].tap()
            waitForPage(0, in: app)
            try save(app, as: "scan-page-\(suffix)", in: directory)

            app.buttons["scan.enhance"].tap()
            XCTAssertTrue(app.segmentedControls["enhance.mode"].waitForExistence(timeout: 10))
            try save(app, as: "scan-enhance-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()

            app.buttons["scan.text"].tap()
            XCTAssertTrue(app.buttons["text.read"].waitForExistence(timeout: 10))
            app.buttons["text.read"].tap()
            XCTAssertTrue(app.staticTexts["text.body"].waitForExistence(timeout: 120))
            try save(app, as: "scan-text-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()

            app.buttons["scan.save"].tap()
            XCTAssertTrue(app.buttons["save.confirm"].waitForExistence(timeout: 10))
            try save(app, as: "scan-save-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()

            app = launch(language: combo.language, appearance: combo.appearance, scan: [try fixture("id-front"), try fixture("id-back")], mode: "idCard")
            waitForPage(1, in: app)
            let stage = app.descendants(matching: .any)["scan.stage"]
            expectation(for: NSPredicate(format: "label CONTAINS[c] 'card' OR label CONTAINS 'بطاقة'"), evaluatedWith: stage)
            waitForExpectations(timeout: 60)
            try save(app, as: "scan-id-\(suffix)", in: directory)

            app = launch(language: combo.language, appearance: combo.appearance, scan: [try fixture("book-spread")], mode: "book")
            waitForPage(1, in: app)
            try save(app, as: "scan-book-\(suffix)", in: directory)

            app = launch(language: combo.language, appearance: combo.appearance, scan: [try fixture("whiteboard")], mode: "whiteboard")
            waitForPage(0, in: app)
            try save(app, as: "scan-whiteboard-\(suffix)", in: directory)

            app = launch(language: combo.language, appearance: combo.appearance)
            XCTAssertTrue(app.buttons["library.settings"].waitForExistence(timeout: 30))
            app.buttons["library.settings"].tap()
            app.swipeUp()
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'settings.ocr.'")).firstMatch.waitForExistence(timeout: 15))
            try save(app, as: "settings-scan-\(suffix)", in: directory)
            app.buttons["sheet.done"].tap()
        }
    }

    /// Writes the screen at half size as a JPEG, as LaunchTests does.
    private func save(_ app: XCUIApplication, as name: String, in directory: String) throws {
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
