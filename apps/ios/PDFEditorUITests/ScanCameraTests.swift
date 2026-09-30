import XCTest

/// Opening the scanner opens the camera. This Mac's simulator has no camera
/// and no way to refuse one, so the scanner is walked through each answer with
/// `-warraqCamera` (a Debug-only launch argument) and the interface is read
/// back: the camera asked for the moment the scanner appears, the true reason
/// and the way to Settings where permission was refused, and today's photo
/// fallback where there is no camera at all. What is *not* proven here is the
/// real `VNDocumentCameraViewController` — nothing on this machine can run it.
@MainActor
final class ScanCameraTests: XCTestCase {
    nonisolated(unsafe) private var folder: URL!

    override func setUpWithError() throws {
        continueAfterFailure = false
        folder = FileManager.default.temporaryDirectory.appending(path: "scan-camera-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func launch(camera: String, language: String = "en", scan: [URL] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == "ar" ? "ar_SA" : "en_US",
            "-language", language,
            "-appearance", "light",
            "-warraqDocumentsFolder", folder.path,
            "-warraqReset", "1",
            "-warraqCamera", camera,
        ]
        if !scan.isEmpty {
            app.launchArguments += ["-warraqScan", scan.map(\.path).joined(separator: ",")]
        }
        app.launch()
        return app
    }

    private func openScanner(in app: XCUIApplication) {
        XCTAssertTrue(app.buttons["library.scan"].waitForExistence(timeout: 30), "the Library's Scan button")
        app.buttons["library.scan"].tap()
    }

    private func fixture(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle(for: ScanCameraTests.self).url(forResource: name, withExtension: "jpg"))
    }

    // MARK: - The camera opens by itself

    func testTheCameraOpensTheMomentTheScannerDoes() throws {
        let app = launch(camera: "ready")
        openScanner(in: app)
        let camera = app.descendants(matching: .any)["scan.camera"]
        XCTAssertTrue(camera.waitForExistence(timeout: 20),
                      "the scanner opened the camera without anything being tapped")
        // The shutter is behind it, not in front of it: the camera is the screen.
        XCTAssertFalse(app.buttons["scan.shutter"].isHittable)
    }

    /// And closing the camera leaves the scanner, rather than opening it again
    /// for ever — which would be a room with no door.
    func testClosingTheCameraDoesNotOpenItAgain() throws {
        let app = launch(camera: "ready")
        openScanner(in: app)
        XCTAssertTrue(app.descendants(matching: .any)["scan.camera"].waitForExistence(timeout: 20))
        app.buttons["scan.camera.cancel"].tap()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: app.descendants(matching: .any)["scan.camera"])
        waitForExpectations(timeout: 15)
        XCTAssertTrue(app.buttons["scan.shutter"].waitForExistence(timeout: 10), "the scanner is there, with its shutter")
        // Still shut a few seconds later.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 3))
        XCTAssertFalse(app.descendants(matching: .any)["scan.camera"].exists, "it did not reopen on its own")
        // And the empty stage offers the way back in.
        XCTAssertTrue(app.descendants(matching: .any)["scan.empty"].exists)
        app.buttons["scan.emptyAction"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["scan.camera"].waitForExistence(timeout: 15),
                      "the empty stage's button opens the camera again")
    }

    /// Never asked before: the scanner asks, and opens the camera on a yes.
    func testAnUnaskedCameraIsAskedForAndThenOpened() throws {
        let app = launch(camera: "notAsked")
        openScanner(in: app)
        XCTAssertTrue(app.descendants(matching: .any)["scan.camera"].waitForExistence(timeout: 20),
                      "asked for, allowed, opened — all without a tap")
    }

    // MARK: - When it cannot open

    func testARefusedCameraSaysSoAndOffersSettings() throws {
        let app = launch(camera: "denied")
        openScanner(in: app)
        let empty = app.descendants(matching: .any)["scan.empty"]
        XCTAssertTrue(empty.waitForExistence(timeout: 20), "the stage explains itself rather than going black")
        XCTAssertFalse(app.descendants(matching: .any)["scan.camera"].exists, "nothing was opened")
        let settings = app.buttons["scan.emptyAction"]
        XCTAssertTrue(settings.exists)
        XCTAssertTrue(settings.label.localizedCaseInsensitiveContains("settings"), "the way out is Settings: \(settings.label)")
        let caption = app.staticTexts["scan.shutterCaption"]
        XCTAssertTrue(caption.exists)
        XCTAssertTrue(caption.label.localizedCaseInsensitiveContains("off for this app"),
                      "the shutter says what it will do instead: \(caption.label)")
        // Nothing is dead: the shutter still brings pictures in.
        XCTAssertTrue(app.buttons["scan.shutter"].isHittable)
        XCTAssertTrue(app.buttons["scan.photos"].isHittable)
        XCTAssertTrue(app.buttons["scan.files"].isHittable)
    }

    func testARestrictedCameraSaysThatInstead() throws {
        let app = launch(camera: "restricted")
        openScanner(in: app)
        XCTAssertTrue(app.descendants(matching: .any)["scan.empty"].waitForExistence(timeout: 20))
        let caption = app.staticTexts["scan.shutterCaption"]
        XCTAssertTrue(caption.label.localizedCaseInsensitiveContains("not allowed"), caption.label)
        XCTAssertTrue(app.buttons["scan.emptyAction"].label.localizedCaseInsensitiveContains("settings"))
    }

    /// This simulator, and any device with no camera: today's behaviour, kept.
    func testNoCameraAtAllKeepsThePhotoFallbackAndItsCaption() throws {
        let app = launch(camera: "missing")
        openScanner(in: app)
        XCTAssertTrue(app.descendants(matching: .any)["scan.empty"].waitForExistence(timeout: 20))
        let caption = app.staticTexts["scan.shutterCaption"]
        XCTAssertTrue(caption.label.localizedCaseInsensitiveContains("no camera on this device"), caption.label)
        XCTAssertTrue(app.buttons["scan.emptyAction"].label.localizedCaseInsensitiveContains("photo"),
                      app.buttons["scan.emptyAction"].label)
        XCTAssertTrue(app.buttons["scan.photos"].isHittable)
    }

    /// The scanner opened on a picture handed to it: the camera must not cover
    /// the page the person came to look at.
    func testPicturesHandedToTheScannerAreNotCoveredByTheCamera() throws {
        let app = launch(camera: "ready", scan: [try fixture("page-crooked")])
        openScanner(in: app)
        XCTAssertTrue(app.buttons["scan.page.0"].waitForExistence(timeout: 90), "the picture became a page")
        XCTAssertFalse(app.descendants(matching: .any)["scan.camera"].exists, "the camera stayed out of the way")
        // And the shutter is the way to it when the person wants it.
        app.buttons["scan.shutter"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["scan.camera"].waitForExistence(timeout: 15))
    }

    /// "Create a PDF" means pictures into a PDF, so it opens the photo picker,
    /// not the camera — the same screen, a different thing asked for.
    func testCreateAPDFStartsAtThePicturesRatherThanTheCamera() throws {
        let app = launch(camera: "ready")
        XCTAssertTrue(app.buttons["home.settings"].waitForExistence(timeout: 30))
        let create = app.buttons["home.create"]
        XCTAssertTrue(create.waitForExistence(timeout: 20), "the home's Create card")
        create.tap()
        XCTAssertTrue(app.buttons["scan.shutter"].waitForExistence(timeout: 20), "the scanner opened")
        XCTAssertFalse(app.descendants(matching: .any)["scan.camera"].exists,
                       "Create asks for pictures, so the camera is not what it puts in front of you")
    }

    /// The same, in Arabic: the reasons are translated and the screen is
    /// right-to-left.
    func testTheReasonIsSaidInArabicToo() throws {
        let app = launch(camera: "denied", language: "ar")
        openScanner(in: app)
        XCTAssertTrue(app.descendants(matching: .any)["scan.empty"].waitForExistence(timeout: 20))
        let caption = app.staticTexts["scan.shutterCaption"]
        XCTAssertTrue(caption.exists)
        XCTAssertTrue(caption.label.contains("الكاميرا"), "the caption is Arabic: \(caption.label)")
        XCTAssertTrue(app.buttons["scan.emptyAction"].exists)
    }
}
