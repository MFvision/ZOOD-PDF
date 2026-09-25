import UIKit
import XCTest

/// What part B's UI tests share: launching the app in a language and
/// appearance on a corpus file copied where the app can save it, waiting
/// for the page, driving the More menu, and photographing the screen.
@MainActor
struct PartBApp {
    let app: XCUIApplication
    /// The file the app opened: a copy of a corpus file in the runner's
    /// temporary folder, which the app reads and writes on the simulator.
    let fileURL: URL?

    static let arabic = "ar"
    static let english = "en"
    static let invoice = "coretext-sfarabic-mixed-invoice"
    static let threePages = "chrome-notonaskh-justified-3pages"
    static let outlines = "variant-arabic-metadata-outlines-annots"

    private final class Marker {}

    /// A corpus file copied into a folder of its own; nil for none.
    static func copyFixture(_ name: String) throws -> URL {
        let source = try XCTUnwrap(Bundle(for: Marker.self).url(forResource: name, withExtension: "pdf"), "\(name).pdf is in the UI test bundle")
        let folder = FileManager.default.temporaryDirectory.appending(path: "partb-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appending(path: "\(name).pdf")
        try FileManager.default.copyItem(at: source, to: destination)
        return destination
    }

    /// Launches on `file` (already copied) or on a fresh copy of `fixture`.
    static func launch(language: String = english, appearance: String = "light", fixture: String? = nil, file: URL? = nil, arguments: [String] = []) throws -> PartBApp {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == arabic ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", appearance,
        ] + arguments
        var url = file
        if url == nil, let fixture {
            url = try copyFixture(fixture)
        }
        if let url {
            app.launchArguments += ["-warraqOpen", url.path]
        }
        app.launch()
        return PartBApp(app: app, fileURL: url)
    }

    var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    /// The page view, with the core's text of the page as its value.
    var page: XCUIElement { app.descendants(matching: .any).matching(identifier: "document.page").firstMatch }

    /// The accessibility tree, for a failure's message.
    var tree: String {
        String(app.debugDescription.prefix(6000))
    }

    /// Waits for the page view and for the core's text to arrive on it.
    @discardableResult
    func waitForPage(containing word: String, timeout: TimeInterval = 40) -> String {
        XCTAssertTrue(page.waitForExistence(timeout: timeout), "the page view appears: \(tree)")
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if let value = page.value as? String, value.contains(word) { return value }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.3))
        }
        XCTFail("the page's text never held \(word): \(page.value ?? "")")
        return page.value as? String ?? ""
    }

    /// The toolbar's state line (the front-most one, when a sheet has its own).
    var status: XCUIElement { app.staticTexts.matching(identifier: "document.status").firstMatch }

    /// Waits for the toolbar's status, or the page element's label, to
    /// hold `text` ("Page 2 of 3", "of 2").
    func waitForStatus(containing text: String, timeout: TimeInterval = 20) {
        let found = poll(timeout: timeout) {
            let element = self.status
            if element.exists, element.label.contains(text) { return true }
            let page = self.page
            return page.exists && page.label.contains(text)
        }
        XCTAssertTrue(found, "status holds \(text): \(status.exists ? status.label : "no status") \(found ? "" : tree)")
    }

    /// A button of the markup bar, scrolled into reach when the bar is
    /// wider than the screen (a phone, either reading direction).
    @discardableResult
    func tapMarkup(_ identifier: String) -> XCUIElement {
        let button = app.buttons[identifier]
        XCTAssertTrue(button.waitForExistence(timeout: 10), "markup button \(identifier): \(tree)")
        let bar = app.descendants(matching: .any).matching(identifier: "markup.bar").firstMatch
        var tries = 0
        while !button.isHittable, bar.exists, tries < 6 {
            // The bar scrolls one way in Arabic and the other in English.
            if tries % 2 == 0 { bar.swipeLeft() } else { bar.swipeRight() }
            tries += 1
        }
        button.tap()
        return button
    }

    /// "Edited" in the status or on the page element, in either language.
    func waitForEdited(timeout: TimeInterval = 30) {
        let words = ["Edited", "مُعدَّل"]
        let found = poll(timeout: timeout) {
            let state = self.status
            if state.exists, words.contains(where: { state.label.contains($0) }) { return true }
            let page = self.page
            return page.exists && words.contains(where: { page.label.contains($0) })
        }
        XCTAssertTrue(found, "the document says edited: \(status.exists ? status.label : "no status") \(found ? "" : tree)")
    }

    /// Runs `condition` every few hundred milliseconds until it holds.
    @discardableResult
    func poll(timeout: TimeInterval = 15, _ condition: () -> Bool) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.3))
        }
        return condition()
    }

    /// Taps a row of a list, scrolling to it when it is below the fold.
    func tapRow(_ identifier: String) {
        let row = app.buttons[identifier]
        var tries = 0
        while !row.exists, tries < 4 {
            app.swipeUp()
            tries += 1
        }
        XCTAssertTrue(row.waitForExistence(timeout: 5), "row \(identifier)")
        row.tap()
    }

    /// Opens the More menu and taps the item with `identifier` (or, when
    /// the menu item carries none, the one labelled `label`).
    func more(_ identifier: String, label: String? = nil) {
        let more = app.buttons["document.more"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        more.tap()
        var item = app.buttons[identifier]
        if !item.waitForExistence(timeout: 3), let label {
            item = app.buttons[label]
        }
        XCTAssertTrue(item.waitForExistence(timeout: 5), "menu item \(identifier)")
        item.tap()
    }

    /// Taps a control: on iPhone the bottom bar's, on iPad the More menu's.
    func viewControl(_ identifier: String, menuLabel: String) {
        let button = app.buttons[identifier]
        if button.waitForExistence(timeout: 3), button.isHittable {
            button.tap()
        } else {
            more(identifier, label: menuLabel)
        }
    }

    /// A drag across the page view, from and to fractions of its size.
    func drag(from: (Double, Double), to: (Double, Double), duration: TimeInterval = 0.05) {
        XCTAssertTrue(page.waitForExistence(timeout: 10), "the page view is there to drag on: \(tree)")
        let start = page.coordinate(withNormalizedOffset: CGVector(dx: from.0, dy: from.1))
        let end = page.coordinate(withNormalizedOffset: CGVector(dx: to.0, dy: to.1))
        start.press(forDuration: duration, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
    }

    /// The text that a field takes; the keyboard follows the app's language.
    func type(_ text: String, into identifier: String) {
        let field = app.textFields[identifier].exists ? app.textFields[identifier] : (app.secureTextFields[identifier].exists ? app.secureTextFields[identifier] : app.textViews[identifier])
        XCTAssertTrue(field.waitForExistence(timeout: 10), "field \(identifier)")
        field.tap()
        field.typeText(text)
    }

    /// Writes the screen at half size as a JPEG into `directory`, when a
    /// directory was given (scripts/ios/build.sh gives one).
    func screenshot(_ name: String, in directory: String?) throws {
        guard let directory, !directory.isEmpty else { return }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.6))
        let image = XCUIScreen.main.screenshot().image
        let size = CGSize(width: image.size.width / 2, height: image.size.height / 2)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        let data = try XCTUnwrap(small.jpegData(compressionQuality: 0.72))
        let folder = URL(filePath: directory, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try data.write(to: folder.appending(path: "\(name).jpg"), options: .atomic)
    }

    static var screenshotDirectory: String? {
        let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"]
        return directory?.isEmpty == false ? directory : nil
    }

    static var deviceSlug: String {
        ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"] ?? (UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")
    }
}
