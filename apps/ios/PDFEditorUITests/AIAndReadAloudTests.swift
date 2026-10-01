import FoundationModels
import PDFKit
import UIKit
import XCTest

/// Through the interface, on the simulator: the AI sheet over a document (a
/// Debug run with the fake engine behind the same `AIEngine` protocol, since
/// Apple's model is not on these simulators — `AITests` records what the
/// framework says), a summary answered from the page's own text, an Arabic
/// form filled from the profile after review and saved, Settings saying
/// exactly why there is no model, and read aloud with its bar — photographed
/// in Arabic and English, iPhone and iPad.
@MainActor
final class AIAndReadAloudTests: XCTestCase {
    private static let form = "acroform-pdflib-arabic-fields"

    /// The profile a test seeds (Debug builds read `-warraqProfileJSON`).
    private static let profileJSON = #"{"nameArabic":"محمد الغماس","nameEnglish":"Mohammed Alghammas","nationalID":"1234567890","email":"m@example.com","phone":"0500000000"}"#

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(language: String = PartBApp.arabic, appearance: String = "light", fixture: String?, fakeAI: Bool = true) throws -> PartBApp {
        var arguments = ["-warraqReset", "1", "-warraqProfileJSON", Self.profileJSON]
        if fakeAI { arguments += ["-warraqFakeAI", "1"] }
        return try PartBApp.launch(language: language, appearance: appearance, fixture: fixture, arguments: arguments)
    }

    /// A toolbar button, from the bar or, when the bar has folded it away
    /// on a narrow phone, from its overflow menu.
    private func tapToolbar(_ ui: PartBApp, _ identifier: String) {
        let button = ui.app.buttons[identifier].firstMatch
        if !button.waitForExistence(timeout: 10) || !button.isHittable {
            let overflow = ui.app.navigationBars.buttons.matching(NSPredicate(format: "identifier CONTAINS[c] 'overflow' OR label CONTAINS[c] 'More'")).firstMatch
            if overflow.exists { overflow.tap() }
        }
        XCTAssertTrue(ui.poll(timeout: 10) { button.exists && button.isHittable }, "toolbar button \(identifier): \(ui.tree)")
        button.tap()
    }

    // MARK: - The assistant

    func testSummarizesFromThePagesOwnTextAndSaysWhatItRead() throws {
        let ui = try launch(fixture: PartBApp.invoice)
        let pageText = ui.waitForPage(containing: "فاتورة")
        tapToolbar(ui, "document.ai")
        let run = ui.app.buttons["ai.run"]
        XCTAssertTrue(run.waitForExistence(timeout: 10), "the AI sheet is up")
        XCTAssertFalse(ui.app.buttons["ai.autofill"].exists, "no form, so no autofill")
        run.tap()
        let answer = ui.app.staticTexts["ai.answer"]
        XCTAssertTrue(answer.waitForExistence(timeout: 30), "an answer appears")
        // The fake engine answers with the first lines of what it was
        // handed: the prompt's opening, the page's mark and the page's first
        // line as the core reads it — so the document's own text went in.
        let trimmed = pageText.trimmingCharacters(in: .whitespacesAndNewlines)
        let firstLine = try XCTUnwrap(trimmed.split(separator: "\n").first)
        XCTAssertEqual(answer.label, String("[fake] <document> [page 1] \(firstLine)".prefix(247)))
        let note = ui.app.staticTexts["ai.context"]
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        XCTAssertEqual(note.label, "قرأ المستند كاملًا.")
        ui.app.buttons["sheet.done"].tap()
    }

    func testFillsTheArabicFormFromTheProfileAfterReviewAndSaves() throws {
        let ui = try launch(fixture: Self.form)
        ui.waitForPage(containing: "الاسم")
        tapToolbar(ui, "document.ai")
        let autofill = ui.app.buttons["ai.autofill"]
        XCTAssertTrue(autofill.waitForExistence(timeout: 10))
        autofill.tap()
        XCTAssertTrue(ui.app.buttons["autofill.fill"].waitForExistence(timeout: 30), "proposals are listed with a Fill button")

        // Three proposals, each read back exactly: the name and ID fields
        // already hold values, so they come switched off with what they
        // hold now; the email is empty, so it is on.
        let name = ui.app.textFields["autofill.value.الاسم الكامل"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        XCTAssertEqual(name.value as? String, "محمد الغماس")
        XCTAssertEqual(ui.app.staticTexts["autofill.current.الاسم الكامل"].label, "الآن: محمد عبد الله")
        XCTAssertEqual(ui.app.textFields["autofill.value.رقم الهوية"].value as? String, "1234567890")
        XCTAssertEqual(ui.app.textFields["autofill.value.البريد الإلكتروني"].value as? String, "m@example.com")
        XCTAssertFalse(ui.app.textFields["autofill.value.الجنسية"].exists, "nothing answers nationality: no proposal")
        let nameSwitch = ui.app.switches["autofill.accept.الاسم الكامل"]
        let idSwitch = ui.app.switches["autofill.accept.رقم الهوية"]
        let emailSwitch = ui.app.switches["autofill.accept.البريد الإلكتروني"]
        XCTAssertEqual(nameSwitch.value as? String, "0")
        XCTAssertEqual(idSwitch.value as? String, "0")
        XCTAssertEqual(emailSwitch.value as? String, "1")
        // The person replaces the name, keeps the email, leaves the ID.
        if nameSwitch.switches.firstMatch.exists { nameSwitch.switches.firstMatch.tap() } else { nameSwitch.tap() }
        XCTAssertTrue(ui.poll(timeout: 5) { nameSwitch.value as? String == "1" })
        ui.app.buttons["autofill.fill"].tap()
        let done = ui.app.descendants(matching: .any)["autofill.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 30), "the fields are written")
        XCTAssertEqual(done.label, "عُبِّئ حقلان. راجعهما في الصفحة ثم احفظ.")
        ui.app.buttons["sheet.done"].tap()

        // Edited, and the page's text (the core's reading) has the new name
        // drawn once, shaped, on its label's line, and not the old one.
        ui.waitForEdited()
        let lines = ui.waitForPage(containing: "محمد الغماس").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        XCTAssertEqual(lines.filter { $0.hasPrefix("الاسم الكامل") }, ["الاسم الكامل: محمد الغماس"], "\(lines)")
        XCTAssertEqual(lines.filter { $0.hasPrefix("البريد الإلكتروني") }, ["البريد الإلكتروني: m@example.com"], "\(lines)")
        XCTAssertEqual(lines.filter { $0.hasPrefix("رقم الهوية") }, ["رقم الهوية: 1098765432"], "\(lines)")

        // Saved, and the file on disk holds exactly what was chosen.
        let save = ui.app.buttons["document.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 10), "there is something to save")
        save.tap()
        XCTAssertTrue(ui.poll(timeout: 20) { !save.exists }, "saved")
        let url = try XCTUnwrap(ui.fileURL)
        let page = try XCTUnwrap(PDFDocument(url: url)?.page(at: 0))
        func value(_ field: String) -> String? {
            page.annotations.first { $0.fieldName == field }?.widgetStringValue
        }
        XCTAssertEqual(value("الاسم الكامل"), "محمد الغماس")
        XCTAssertEqual(value("البريد الإلكتروني"), "m@example.com")
        XCTAssertEqual(value("رقم الهوية"), "1098765432")
        XCTAssertEqual(value("الجنسية") ?? "", "")
    }

    // MARK: - Without the model

    /// What Settings must say on this device, from the framework itself
    /// (asked in the runner, on the same simulator).
    private func expectedAvailability() -> (status: String, reason: String) {
        guard #available(iOS 26, *) else { return ("Not available", "On-device AI needs iOS 26 or later.") }
        switch SystemLanguageModel.default.availability {
        case .available:
            return ("Available", "The system's on-device model answers here. Nothing leaves this device.")
        case .unavailable(.deviceNotEligible):
            return ("Not available", "This device cannot run Apple Intelligence, so on-device AI is not available.")
        case .unavailable(.appleIntelligenceNotEnabled):
            return ("Not available", "Turn on Apple Intelligence in the Settings app to use on-device AI.")
        case .unavailable(.modelNotReady):
            return ("Not available", "The on-device model is not ready yet — it may still be downloading. Try again later.")
        case .unavailable:
            return ("Not available", "On-device AI is not available on this device.")
        }
    }

    /// Apple's model itself, no fake: the AI button exists exactly when the
    /// framework says the model is there, and Settings says what it says.
    /// On these simulators the framework answers "available" but every
    /// request fails in its safety check ("Simulator is not supported"):
    /// the sheet says so in words, rather than pretending.
    func testTheAIButtonAndSettingsFollowTheFramework() throws {
        let expected = expectedAvailability()
        print("WARRAQ_AI_SETTINGS expected: \(expected)")
        var ui = try launch(language: PartBApp.english, fixture: PartBApp.invoice, fakeAI: false)
        ui.waitForPage(containing: "فاتورة")
        let hasAI = ui.app.buttons["document.ai"].waitForExistence(timeout: 5)
        XCTAssertEqual(hasAI, expected.status == "Available", "the AI button exists exactly when the model does")
        if hasAI {
            tapToolbar(ui, "document.ai")
            let run = ui.app.buttons["ai.run"]
            XCTAssertTrue(run.waitForExistence(timeout: 10))
            run.tap()
            let answer = ui.app.staticTexts["ai.answer"]
            let failure = ui.app.descendants(matching: .any)["ai.error"]
            XCTAssertTrue(ui.poll(timeout: 120) { answer.exists || failure.exists }, ui.tree)
            if failure.exists {
                print("WARRAQ_AI_REAL: failed — \(failure.label)")
                XCTAssertEqual(failure.label, "The on-device model did not answer: its safety check cannot run on this device.")
            } else {
                print("WARRAQ_AI_REAL: answered — \(answer.label)")
                XCTAssertFalse(answer.label.isEmpty)
            }
            ui.app.buttons["sheet.done"].tap()
        }
        ui.app.terminate()

        ui = try PartBApp.launch(language: PartBApp.english, arguments: ["-warraqFresh", "1"])
        ui.app.homeSettingsCard().tap()
        let status = ui.app.descendants(matching: .any)["settings.ai.status"].firstMatch
        let form = ui.app.collectionViews.firstMatch.exists ? ui.app.collectionViews.firstMatch : ui.app
        for _ in 0..<8 where !(status.exists && status.isHittable) { form.swipeUp() }
        XCTAssertTrue(status.waitForExistence(timeout: 10), ui.tree)
        let reason = ui.app.staticTexts["settings.ai.reason"]
        for _ in 0..<3 where !reason.exists { form.swipeUp() }
        XCTAssertTrue(reason.waitForExistence(timeout: 5), ui.tree)
        print("WARRAQ_AI_SETTINGS shown: \(status.label) | \(String(describing: status.value)) | \(reason.label)")
        XCTAssertEqual(reason.label, expected.reason)
        let statusText = ui.app.staticTexts.matching(NSPredicate(format: "label == %@", expected.status)).firstMatch
        XCTAssertTrue(statusText.exists || (status.value as? String) == expected.status || status.label.hasSuffix(expected.status), "\(status.label)")
    }

    // MARK: - Read aloud

    func testReadsAloudWithTheBarAndTheSentence() throws {
        let ui = try launch(fixture: PartBApp.invoice, fakeAI: false)
        let pageText = ui.waitForPage(containing: "فاتورة")
        tapToolbar(ui, "document.readAloud")
        let bar = ui.app.descendants(matching: .any)["readAloud.bar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 20), "the read-aloud bar appears")
        let sentence = ui.app.staticTexts["readAloud.sentence"]
        XCTAssertTrue(sentence.waitForExistence(timeout: 20))
        XCTAssertTrue(ui.poll(timeout: 20) { sentence.label != "جارٍ القراءة…" && !sentence.label.isEmpty })
        // Paused, so the sentence on screen stays put while it is checked:
        // one of the page's sentences, exactly (the voice may have finished
        // the first one already); next is exactly the one after it, and
        // previous brings it back.
        ui.app.buttons["readAloud.playPause"].tap()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.5))
        let first = sentence.label
        let at = try XCTUnwrap(ReadAloudExpectations.invoice.firstIndex(of: first), "\(first) is a sentence of the page")
        XCTAssertLessThan(at, ReadAloudExpectations.invoice.count - 1)
        XCTAssertTrue(pageText.contains(first), "the sentence is the page's own text")
        ui.app.buttons["readAloud.next"].tap()
        XCTAssertTrue(ui.poll(timeout: 10) { sentence.label == ReadAloudExpectations.invoice[at + 1] }, sentence.label)
        ui.app.buttons["readAloud.previous"].tap()
        XCTAssertTrue(ui.poll(timeout: 10) { sentence.label == first }, sentence.label)
        ui.app.buttons["readAloud.stop"].tap()
        XCTAssertTrue(bar.waitForNonExistence(timeout: 10), "the bar goes away on Stop")
    }

    // MARK: - Screenshots

    func testScreenshots() throws {
        guard let directory = ProcessInfo.processInfo.environment["WARRAQ_SCREENSHOT_DIR"], !directory.isEmpty else {
            throw XCTSkip("WARRAQ_SCREENSHOT_DIR is not set; scripts/ios/build.sh sets it")
        }
        let device = ProcessInfo.processInfo.environment["WARRAQ_DEVICE_SLUG"]
            ?? (UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")
        for (language, appearance) in [(PartBApp.arabic, "light"), (PartBApp.english, "dark")] {
            let suffix = "\(language)-\(appearance)-\(device)"
            var ui = try launch(language: language, appearance: appearance, fixture: Self.form)
            ui.waitForPage(containing: "الاسم")
            tapToolbar(ui, "document.ai")
            XCTAssertTrue(ui.app.buttons["ai.run"].waitForExistence(timeout: 10))
            ui.app.buttons["ai.run"].tap()
            XCTAssertTrue(ui.app.staticTexts["ai.answer"].waitForExistence(timeout: 30))
            try save(ui.app, as: "ai-\(suffix)", in: directory)
            let autofill = ui.app.buttons["ai.autofill"]
            for _ in 0..<4 where !(autofill.exists && autofill.isHittable) { ui.app.swipeUp() }
            autofill.tap()
            XCTAssertTrue(ui.app.buttons["autofill.fill"].waitForExistence(timeout: 30))
            try save(ui.app, as: "autofill-\(suffix)", in: directory)
            ui.app.terminate()

            ui = try launch(language: language, appearance: appearance, fixture: PartBApp.invoice)
            ui.waitForPage(containing: "فاتورة")
            tapToolbar(ui, "document.readAloud")
            let sentence = ui.app.staticTexts["readAloud.sentence"]
            XCTAssertTrue(sentence.waitForExistence(timeout: 20))
            XCTAssertTrue(ui.poll(timeout: 20) { ReadAloudExpectations.invoice.contains(sentence.label) })
            ui.app.buttons["readAloud.playPause"].tap()
            try save(ui.app, as: "readaloud-\(suffix)", in: directory)
            ui.app.terminate()

            ui = try PartBApp.launch(language: language, appearance: appearance, arguments: ["-warraqFresh", "1", "-warraqProfileJSON", Self.profileJSON])
            ui.app.homeSettingsCard().tap()
            let profile = ui.app.buttons["settings.ai.profile"]
            let form = ui.app.collectionViews.firstMatch.exists ? ui.app.collectionViews.firstMatch : ui.app
            for _ in 0..<8 where !(profile.exists && profile.isHittable) { form.swipeUp() }
            XCTAssertTrue(profile.waitForExistence(timeout: 10))
            try save(ui.app, as: "settings-ai-\(suffix)", in: directory)
            profile.tap()
            XCTAssertTrue(ui.app.textFields["profile.nameArabic"].waitForExistence(timeout: 10))
            try save(ui.app, as: "profile-\(suffix)", in: directory)
            ui.app.terminate()
        }
    }

    private func save(_ app: XCUIApplication, as name: String, in directory: String) throws {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.8))
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

/// The invoice's sentences as read aloud, the same list `ReadAloudTests`
/// reads off the core.
enum ReadAloudExpectations {
    static let invoice = [
        "فاتورة ضريبية مبسطة",
        "رقم الفاتورة: INV-2026-0042",
        "التاريخ: ١٦ سبتمبر ٢٠٢٦",
        "العميل: شركة زود للتقنية",
        "الوصف | الكمية | السعر | الإجمالي",
        "اشتراك سنوي في خدمة Warraq Pro | 1 | 1,200.00 | 1,200.00",
        "دعم فني (Premium Support) | 1,800.00 | 150.00 | 12",
        "الإجمالي قبل الضريبة: 3,000.00 ر.س",
        "ضريبة القيمة المضافة (%15): 450.00 ر.س",
        "الإجمالي المستحق: 3,450.00 ر.س",
        "شكراً لتعاملكم معنا — Thank you for your business",
    ]
}
