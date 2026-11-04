import UIKit
import XCTest

/// The App Store's pictures: the screens a new person should see first,
/// photographed at the simulator's full resolution as PNG, in Arabic and
/// English, into WARRAQ_STORE_DIR (the "App Store screenshots" workflow sets
/// it; without it every test here is skipped). The documents carry real
/// names, as a person's own library would, not the corpus file names.
/// Each screen is its own test, so one that cannot be reached does not cost
/// the others.
@MainActor
final class StoreScreenshotTests: XCTestCase {
    private static let languages = [PartBApp.arabic, PartBApp.english]

    override func setUpWithError() throws {
        continueAfterFailure = true
        guard Self.directory != nil else {
            throw XCTSkip("WARRAQ_STORE_DIR is not set; the App Store screenshots workflow sets it")
        }
    }

    private static var directory: String? {
        let directory = ProcessInfo.processInfo.environment["WARRAQ_STORE_DIR"]
        return directory?.isEmpty == false ? directory : nil
    }

    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    /// A library that looks like a person's: the corpus files under the
    /// names a person would give them, in the run's language.
    private func demoLibrary(_ language: String) throws -> URL {
        let names: [(fixture: String, ar: String, en: String)] = [
            ("variant-arabic-metadata-outlines-annots", "نظام حماية حقوق المؤلف", "Copyright law"),
            ("coretext-sfarabic-mixed-invoice", "فاتورة أكتوبر", "October invoice"),
            ("chrome-notonaskh-justified-3pages", "تقرير الربع الثالث", "Q3 report"),
            ("acroform-pdflib-arabic-fields", "نموذج طلب إجازة", "Leave request form"),
            ("chrome-cairo-mixed-invoice", "عرض سعر", "Price quote"),
            ("coretext-albayan-tashkeel", "قصيدة", "Poem"),
        ]
        final class Marker {}
        let bundle = Bundle(for: Marker.self)
        let folder = FileManager.default.temporaryDirectory.appending(path: "store-\(language)-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for entry in names {
            guard let source = bundle.url(forResource: entry.fixture, withExtension: "pdf") else { continue }
            let name = language == PartBApp.arabic ? entry.ar : entry.en
            try FileManager.default.copyItem(at: source, to: folder.appending(path: "\(name).pdf"))
        }
        return folder
    }

    /// One named document, copied where the app may write it.
    private func named(_ fixture: String, ar: String, en: String, language: String) throws -> URL {
        let source = try PartBApp.copyFixture(fixture)
        let target = source.deletingLastPathComponent().appending(path: "\(language == PartBApp.arabic ? ar : en).pdf")
        try FileManager.default.moveItem(at: source, to: target)
        return target
    }

    private func launchHome(_ language: String, appearance: String = "light") throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == PartBApp.arabic ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", appearance,
            "-theme", "zood",
            "-warraqFresh", "1",
            "-warraqImport", try demoLibrary(language).path,
        ]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["library.home"].firstMatch.waitForExistence(timeout: 60), "the home screen")
        // The thumbnails of the imported files are drawn after the import.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 6))
        return app
    }

    private func openDocument(_ fixture: String, ar: String, en: String, language: String, appearance: String = "light", extra: [String] = []) throws -> PartBApp {
        let file = try named(fixture, ar: ar, en: en, language: language)
        return try PartBApp.launch(language: language, appearance: appearance, file: file, arguments: ["-theme", "zood", "-warraqFresh", "1"] + extra)
    }

    /// The screen at full resolution, as the App Store takes it.
    private func shot(_ name: String, _ language: String) {
        guard let directory = Self.directory else { return }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 1.2))
        let data = XCUIScreen.main.screenshot().pngRepresentation
        let device = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"] ?? (isPad ? "iPad" : "iPhone")
        let folder = URL(filePath: directory, directoryHint: .isDirectory).appending(path: "\(device)/\(language)", directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: folder.appending(path: "\(name).png"), options: .atomic)
        } catch {
            XCTFail("could not keep \(name): \(error)")
        }
    }

    // MARK: - The screens

    func test01Home() throws {
        for language in Self.languages {
            let app = try launchHome(language)
            shot("01-home", language)
            app.terminate()
        }
    }

    func test02HomeDark() throws {
        for language in Self.languages {
            let app = try launchHome(language, appearance: "dark")
            shot("02-home-dark", language)
            app.terminate()
        }
    }

    func test03Read() throws {
        for language in Self.languages {
            let ui = try openDocument(PartBApp.outlines, ar: "نظام حماية حقوق المؤلف", en: "Copyright law", language: language)
            ui.waitForPage(containing: "الفصل")
            shot("03-read", language)
            ui.app.terminate()
        }
    }

    func test04Search() throws {
        for language in Self.languages {
            let ui = try openDocument(PartBApp.outlines, ar: "نظام حماية حقوق المؤلف", en: "Copyright law", language: language)
            ui.waitForPage(containing: "الفصل")
            ui.app.buttons["document.search"].tap()
            ui.type("الفصل", into: "search.field")
            _ = ui.app.buttons["search.count"].waitForExistence(timeout: 20)
            shot("04-search", language)
            ui.app.terminate()
        }
    }

    func test05Markup() throws {
        for language in Self.languages {
            let ui = try openDocument(PartBApp.threePages, ar: "تقرير الربع الثالث", en: "Q3 report", language: language)
            ui.waitForPage(containing: "ال")
            ui.app.buttons["document.markup"].tap()
            ui.tapMarkup("markup.highlight")
            // A stroke of the highlighter over the first lines.
            let page = ui.page
            if page.waitForExistence(timeout: 10) {
                let a = page.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.18))
                let b = page.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.18))
                a.press(forDuration: 0.1, thenDragTo: b, withVelocity: .slow, thenHoldForDuration: 0.1)
            }
            ui.tapMarkup("markup.ink")
            _ = ui.app.buttons["pen.color.red"].waitForExistence(timeout: 10)
            shot("05-markup", language)
            ui.app.terminate()
        }
    }

    func test06Sign() throws {
        for language in Self.languages {
            let ui = try openDocument(PartBApp.invoice, ar: "فاتورة أكتوبر", en: "October invoice", language: language)
            ui.waitForPage(containing: "فاتورة")
            ui.app.buttons["document.markup"].tap()
            let canvas = ui.openSignatureCanvas()
            if canvas.waitForExistence(timeout: 10) {
                // A signature in three strokes, not a straight line.
                let strokes: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [(0.15, 0.65, 0.35, 0.3), (0.35, 0.3, 0.55, 0.7), (0.55, 0.7, 0.85, 0.35)]
                for s in strokes {
                    let a = canvas.coordinate(withNormalizedOffset: CGVector(dx: s.0, dy: s.1))
                    let b = canvas.coordinate(withNormalizedOffset: CGVector(dx: s.2, dy: s.3))
                    a.press(forDuration: 0.05, thenDragTo: b, withVelocity: .slow, thenHoldForDuration: 0.05)
                }
            }
            shot("06-sign", language)
            ui.app.terminate()
        }
    }

    func test07Pages() throws {
        for language in Self.languages {
            let ui = try openDocument(PartBApp.threePages, ar: "تقرير الربع الثالث", en: "Q3 report", language: language)
            ui.waitForPage(containing: "ال")
            ui.viewControl("document.thumbnails.toggle", menuLabel: language == PartBApp.arabic ? "المصغّرات" : "Thumbnails")
            _ = ui.app.buttons["thumbnail.0"].waitForExistence(timeout: 10)
            shot("07-pages", language)
            ui.app.terminate()
        }
    }

    /// The iPad (and an unfolded iPhone Duo) lays a document out as a book.
    func test08TwoPages() throws {
        guard isPad else { throw XCTSkip("two pages side by side is for the wide screens") }
        for language in Self.languages {
            let ui = try openDocument(PartBApp.threePages, ar: "تقرير الربع الثالث", en: "Q3 report", language: language, extra: ["-view.layout", "book"])
            ui.waitForPage(containing: "ال")
            shot("08-two-pages", language)
            ui.app.terminate()
        }
    }

    func test09Tools() throws {
        guard !isPad else { throw XCTSkip("the iPad keeps its sidebar, with the tools on Home") }
        for language in Self.languages {
            let app = try launchHome(language)
            let tools = app.tabBars.buttons.element(boundBy: 3)
            if tools.waitForExistence(timeout: 10) {
                tools.tap()
                shot("09-tools", language)
            }
            app.terminate()
        }
    }
}
