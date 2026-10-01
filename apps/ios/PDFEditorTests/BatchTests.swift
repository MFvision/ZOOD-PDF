@testable import PDFEditor
import CryptoKit
import WarraqCore
import XCTest

/// Batch: each step through the core, read back exactly; a run over real
/// files with a broken one and a truncated one among them, which are
/// reported while the rest are done; the originals byte for byte as they
/// were; names that never overwrite; Stop and the system's stop; saved
/// sequences that never keep a password.
@MainActor
final class BatchTests: XCTestCase {
    private var folder: URL!
    private var output: URL!

    override func setUp() async throws {
        folder = try PartB.folder()
        output = folder.appending(path: "out", directoryHint: .isDirectory)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// A corpus file copied into the test's folder.
    private func copy(_ name: String) throws -> URL {
        let url = folder.appending(path: "\(name).pdf")
        try FileManager.default.copyItem(at: PartB.fixtureURL(name), to: url)
        return url
    }

    private func write(_ bytes: Data, as name: String) throws -> URL {
        let url = folder.appending(path: name)
        try bytes.write(to: url)
        return url
    }

    private func digest(_ url: URL) throws -> String {
        SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
    }

    private func options(_ steps: [BatchStep], password: String? = nil, openPassword: String? = nil, suffix: String = "processed") -> BatchRun.Options {
        BatchRun.Options(steps: steps, password: password, openPassword: openPassword, ownerPassword: nil,
                         outputFolder: output, suffix: suffix, languages: ["ar", "en"], locale: Locale(identifier: "en"))
    }

    private func text(_ bytes: Data, page: Int, password: String? = nil) async throws -> String {
        let core = try await Core.open(bytes: bytes, password: password)
        let text = try await core.extractText(page: page)
        await core.close()
        return text
    }

    private func pageCount(_ bytes: Data, password: String? = nil) async throws -> Int {
        let core = try await Core.open(bytes: bytes, password: password)
        let count = await core.pageCount
        await core.close()
        return count
    }

    // MARK: - A run with broken files

    func testABatchWithBrokenFilesReportsThemAndDoesTheRestLeavingTheOriginalsAsTheyWere() async throws {
        let three = try copy("chrome-notonaskh-justified-3pages")
        let invoice = try copy("coretext-sfarabic-mixed-invoice")
        let broken = try write(Data("%PDF-1.7\n1 0 obj << /Type /Catalog >> garbage\n%%EOF".utf8), as: "broken.pdf")
        let whole = try PartB.fixture("raw-amiri-cid-identity-tounicode")
        let truncated = try write(whole.prefix(whole.count / 3), as: "truncated.pdf")
        let gone = folder.appending(path: "gone.pdf")
        let before = try [three, invoice, broken, truncated].map(digest)
        let originalPage2 = try await text(try Data(contentsOf: three), page: 1)

        var delete = BatchStep(kind: .deletePages)
        delete.pages = "1"
        let run = BatchRun()
        run.add([three, broken, invoice, truncated, gone])
        XCTAssertEqual(run.inputs.count, 5)
        run.start(options([delete]))
        await run.finish()

        XCTAssertEqual(run.summary, BatchRun.Summary(done: 1, failed: 4, cancelled: 0, stoppedBySystem: 0))
        let states = run.inputs.map { run.state(of: $0) }
        XCTAssertEqual(states[1], .failed(step: nil, .notPDF), "the broken file is said to be no PDF")
        XCTAssertEqual(states[3], .failed(step: nil, .notPDF), "the truncated file too")
        XCTAssertEqual(states[4], .failed(step: nil, .unreadable), "a file that is not there")
        XCTAssertEqual(states[2], .failed(step: 0, .deleteAll), "the one-page invoice: its step refuses, and says which")

        // The results: new files, the first page gone, the rest as it was.
        guard case let .done(first) = states[0] else {
            return XCTFail("the three-page file is done: \(states)")
        }
        XCTAssertEqual(first.lastPathComponent, "chrome-notonaskh-justified-3pages – processed.pdf")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: output.path), [first.lastPathComponent], "one result, nothing for the others")
        XCTAssertEqual(first.deletingLastPathComponent().standardizedFileURL, output.standardizedFileURL)
        let result = try Data(contentsOf: first)
        let resultCount = try await pageCount(result)
        XCTAssertEqual(resultCount, 2)
        let resultPage1 = try await text(result, page: 0)
        XCTAssertEqual(resultPage1, originalPage2, "the old page 2 is page 1, word for word")

        // Every original, byte for byte as it was; nothing written beside them.
        XCTAssertEqual(try [three, invoice, broken, truncated].map(digest), before)
        let beside = try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted()
        XCTAssertEqual(beside, ["broken.pdf", "chrome-notonaskh-justified-3pages.pdf", "coretext-sfarabic-mixed-invoice.pdf", "out", "truncated.pdf"])
    }

    func testAProtectedFileIsAskedForItsPasswordAndOpensWithIt() async throws {
        let locked = try copy("variant-encrypted-aes256")
        var rotate = BatchStep(kind: .rotate)
        rotate.quarterTurns = 1

        let run = BatchRun()
        run.add([locked])
        run.start(options([rotate]))
        await run.finish()
        XCTAssertEqual(run.state(of: run.inputs[0]), .failed(step: nil, .needsPassword))

        run.start(options([rotate], password: "wrong"))
        await run.finish()
        XCTAssertEqual(run.state(of: run.inputs[0]), .failed(step: nil, .wrongPassword))

        run.start(options([rotate], password: "warraq"))
        await run.finish()
        guard case let .done(url) = run.state(of: run.inputs[0]) else { return XCTFail("done with the password") }
        // Still protected (an incremental update), and turned.
        let bytes = try Data(contentsOf: url)
        let status = await Protect.status(of: bytes)
        XCTAssertTrue(status.protected)
        let core = try await Core.open(bytes: bytes, password: "warraq")
        let size = try await core.pageSize(0)
        let originalCore = try await Core.open(bytes: try Data(contentsOf: locked), password: "warraq")
        let originalSize = try await originalCore.pageSize(0)
        XCTAssertEqual(size.width, originalSize.height, accuracy: 0.5, "turned a quarter")
        XCTAssertEqual(size.height, originalSize.width, accuracy: 0.5)
    }

    // MARK: - Each step, read back

    func testPageMarksCompressAndProtectInSequence() async throws {
        let invoice = try copy("coretext-sfarabic-mixed-invoice")
        var mark = BatchStep(kind: .pageMarks)
        mark.markKind = MarkSpec.Kind.watermark.rawValue
        mark.markText = "سري للغاية"
        var compress = BatchStep(kind: .compress)
        compress.compressLevel = .lossless
        let protect = BatchStep(kind: .protect)
        let password = "كلمة ١٢٣"

        let run = BatchRun()
        run.add([invoice])
        run.start(options([mark, compress, protect], openPassword: password))
        await run.finish()
        guard case let .done(url) = run.state(of: run.inputs[0]) else {
            return XCTFail("done: \(run.state(of: run.inputs[0]))")
        }
        let bytes = try Data(contentsOf: url)
        let status = await Protect.status(of: bytes)
        XCTAssertEqual(status.method, "aes-256")
        XCTAssertFalse(status.opensWithoutPassword)
        XCTAssertEqual(status.permissions, Protect.Permissions(print: true, copy: false, change: false))
        // The watermark, read back from the page through the core.
        struct Args: Encodable { let password: String; let page: Int }
        let reply = try await Core.callStatic(op: "marks.text", args: Args(password: password, page: 0), blobs: [bytes])
        XCTAssertEqual(reply.object["marks"] as? String, "سري للغاية")
        // And the page's own text is the original's, word for word.
        let page = reply.object["page"] as? String
        let original = try await text(try Data(contentsOf: invoice), page: 0)
        XCTAssertEqual(page, original)
    }

    func testCompressRefusesASignedOrProtectedFileAndSaysWhy() async throws {
        let locked = try PartB.fixture("variant-encrypted-aes256")
        do {
            _ = try await BatchEngine.compress(BatchDoc(bytes: locked, password: "warraq"), level: .balanced)
            XCTFail("a protected file was compressed")
        } catch let failure as BatchFailure {
            XCTAssertEqual(failure, .compressProtected)
        }
    }

    func testRemoveHiddenInformation() async throws {
        let source = try PartB.fixture("variant-arabic-metadata-outlines-annots")
        struct Inspect: Encodable { let password: String? }
        struct Findings: Decodable { struct Finding: Decodable { let kind: String; let count: Int }; let findings: [Finding] }
        let before: Findings = try await Core.callStatic(op: "redact.inspect", args: Inspect(password: nil), blobs: [source]).decode()
        XCTAssertTrue(before.findings.contains { $0.kind == "metadata" && $0.count > 0 })
        XCTAssertTrue(before.findings.contains { $0.kind == "bookmarks" && $0.count > 0 })
        var step = BatchStep(kind: .removeHidden)
        step.hiddenKinds = ["metadata", "bookmarks"]
        let done = try await BatchEngine.run(step, on: BatchDoc(bytes: source), context: context())
        let after: Findings = try await Core.callStatic(op: "redact.inspect", args: Inspect(password: nil), blobs: [done.bytes]).decode()
        XCTAssertFalse(after.findings.contains { ($0.kind == "metadata" || $0.kind == "bookmarks") && $0.count > 0 }, "\(after.findings.map { ($0.kind, $0.count) })")
        let firstBefore = try await text(source, page: 0)
        let firstAfter = try await text(done.bytes, page: 0)
        XCTAssertEqual(firstAfter, firstBefore, "the pages say what they said")
    }

    func testExtractAndExportToText() async throws {
        let three = try PartB.fixture("chrome-notonaskh-justified-3pages")
        var keep = BatchStep(kind: .extractPages)
        keep.pages = "2-3"
        var export = BatchStep(kind: .export)
        export.exportFormat = .text
        var doc = BatchDoc(bytes: three)
        doc = try await BatchEngine.run(keep, on: doc, context: context())
        let kept = try await pageCount(doc.bytes)
        XCTAssertEqual(kept, 2)
        doc = try await BatchEngine.run(export, on: doc, context: context())
        XCTAssertEqual(doc.fileExtension, "txt")
        let page2 = DocxWriter.clean(try await text(three, page: 1))
        let page3 = DocxWriter.clean(try await text(three, page: 2))
        XCTAssertEqual(String(decoding: doc.bytes, as: UTF8.self), "Page 1\n\n\(page2)\n\nPage 2\n\n\(page3)")
    }

    func testOCRWritesAReadableLayerOnAScan() async throws {
        let scan = try PartB.fixture("scan-arial-200dpi-bilevel")
        let ownText = try await text(scan, page: 0)
        XCTAssertTrue(ownText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "a scan with no text of its own")
        let done = try await BatchEngine.run(BatchStep(kind: .ocr), on: BatchDoc(bytes: scan), context: context())
        XCTAssertTrue(done.bytes.starts(with: scan), "an incremental update on the scan")
        struct Words: Decodable { struct Page: Decodable { struct Word: Decodable { let text: String }; let words: [Word] }; let pages: [Page] }
        struct Args: Encodable { let password: String? }
        let layer: Words = try await Core.callStatic(op: "ocr.layer_words", args: Args(password: nil), blobs: [done.bytes]).decode()
        let words = layer.pages.flatMap(\.words).map(\.text)
        XCTAssertGreaterThan(words.count, 5, "Vision read the page")
        let read = try await text(done.bytes, page: 0)
        for word in words.prefix(20) {
            XCTAssertTrue(read.contains(word), "the layer's word \(word) reads back from the page")
        }
        // A second OCR pass leaves a page with text alone.
        let again = try await BatchEngine.run(BatchStep(kind: .ocr), on: done, context: context())
        XCTAssertEqual(again.bytes, done.bytes)
    }

    func testDeletingEveryPageIsRefused() async throws {
        var delete = BatchStep(kind: .deletePages)
        delete.pages = "1-"
        do {
            _ = try await BatchEngine.run(delete, on: BatchDoc(bytes: try PartB.fixture("coretext-sfarabic-mixed-invoice")), context: context())
            XCTFail("deleted every page")
        } catch let failure as BatchFailure {
            XCTAssertEqual(failure, .deleteAll)
        }
    }

    private func context() -> BatchContext {
        BatchContext(name: "test", openPassword: nil, ownerPassword: nil, languages: ["ar", "en"], now: .now, locale: Locale(identifier: "en"))
    }

    // MARK: - Stop

    func testStopAndTheSystemsStopLeaveTheFilesUndoneAndSaySo() async throws {
        let files = try ["coretext-sfarabic-mixed-invoice", "chrome-notonaskh-justified-3pages"].map(copy)
        let run = BatchRun()
        run.add(files)
        run.start(options([BatchStep(kind: .rotate)]))
        run.stop()
        await run.finish()
        XCTAssertEqual(run.summary?.cancelled, 2)
        XCTAssertFalse(run.systemStopped)
        let written = (try? FileManager.default.contentsOfDirectory(atPath: output.path)) ?? []
        XCTAssertEqual(written, [], "nothing written")

        run.start(options([BatchStep(kind: .rotate)]))
        run.stopBySystem()
        await run.finish()
        XCTAssertTrue(run.systemStopped, "the screen says the system stopped it")
        XCTAssertEqual(run.summary?.stoppedBySystem, 2)
        XCTAssertEqual(run.inputs.map { run.state(of: $0) }, [.stoppedBySystem, .stoppedBySystem])
    }

    // MARK: - Names

    func testResultsNeverOverwriteAFileOrTheOriginal() throws {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try Data("taken".utf8).write(to: output.appending(path: "report – processed.pdf"))
        let input = BatchInput(url: folder.appending(path: "report.pdf"))
        var taken = Set<String>()
        XCTAssertEqual(BatchRun.outputURL(for: input, fileExtension: "pdf", in: output, suffix: "processed", taken: &taken).lastPathComponent,
                       "report – processed 2.pdf")
        XCTAssertEqual(BatchRun.outputURL(for: input, fileExtension: "pdf", in: output, suffix: "processed", taken: &taken).lastPathComponent,
                       "report – processed 3.pdf", "a name this run already gave is taken too")
        // No suffix, the original's own folder: never the original's name.
        try Data("original".utf8).write(to: input.url)
        var none = Set<String>()
        let same = BatchRun.outputURL(for: input, fileExtension: "pdf", in: folder, suffix: " / ", taken: &none)
        XCTAssertEqual(same.lastPathComponent, "report 2.pdf")
        XCTAssertEqual(BatchRun.cleanSuffix("a/b:c*\u{7}"), "abc")
    }

    func testPagesAreReadAndClippedToEachFile() {
        XCTAssertEqual(BatchPages.parse("", count: 3), [0, 1, 2])
        XCTAssertEqual(BatchPages.parse("1-2, 5", count: 3), [0, 1])
        XCTAssertEqual(BatchPages.parse("٢-", count: 4), [1, 2, 3], "Arabic-Indic digits, an open end")
        XCTAssertEqual(BatchPages.parse("-2", count: 4), [0, 1])
        XCTAssertEqual(BatchPages.parse("4", count: 3), [])
        XCTAssertNil(BatchPages.parse("a-b", count: 3))
        XCTAssertNil(BatchPages.parse("3-1", count: 3))
        XCTAssertNil(BatchPages.parse("0", count: 3))
        XCTAssertEqual(BatchPages.parse("1-999999", count: 2), [0, 1])
    }

    func testASequenceIsCheckedAsAWhole() {
        XCTAssertNotNil(BatchSequence.problem([]))
        XCTAssertEqual(BatchSequence.problem([BatchStep(kind: .export), BatchStep(kind: .compress)])?.index, 0, "export is last")
        XCTAssertNil(BatchSequence.problem([BatchStep(kind: .compress), BatchStep(kind: .export)]))
        var mark = BatchStep(kind: .pageMarks)
        mark.markKind = MarkSpec.Kind.watermark.rawValue
        XCTAssertEqual(BatchSequence.problem([mark])?.index, 0, "a watermark that says nothing")
        var delete = BatchStep(kind: .deletePages)
        delete.pages = ""
        XCTAssertNotNil(delete.problem)
    }

    // MARK: - Saved sequences

    func testSavedSequencesKeepTheirStepsAndNeverAPassword() throws {
        let suite = "batch-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = BatchSequenceStore(defaults: defaults)
        var mark = BatchStep(kind: .pageMarks)
        mark.markKind = MarkSpec.Kind.footer.rawValue
        mark.markText = "{file} — {page}"
        var protect = BatchStep(kind: .protect)
        protect.allowCopy = true
        store.save(name: "  أرشفة   الفواتير ", steps: [BatchStep(kind: .ocr), mark, protect], now: Date(timeIntervalSince1970: 100))
        let loaded = store.load()
        XCTAssertEqual(loaded.map(\.name), ["أرشفة الفواتير"])
        let steps = try XCTUnwrap(loaded.first?.steps)
        XCTAssertEqual(steps.map(\.kind), [.ocr, .pageMarks, .protect])
        XCTAssertEqual(steps[1].markText, "{file} — {page}")
        XCTAssertEqual(steps[1].mark, .footer)
        XCTAssertTrue(steps[2].allowCopy)
        // What is stored has no field for a password at all.
        let stored = try XCTUnwrap(defaults.data(forKey: "batch.sequences"))
        XCTAssertFalse(String(decoding: stored, as: UTF8.self).lowercased().contains("password"))

        // The same name replaces; another is added before it; delete removes.
        store.save(name: "أرشفة الفواتير", steps: [BatchStep(kind: .compress)])
        store.save(name: "Other", steps: [BatchStep(kind: .rotate)])
        XCTAssertEqual(store.load().map(\.name), ["Other", "أرشفة الفواتير"])
        XCTAssertEqual(store.load().last?.steps.map(\.kind), [.compress])
        store.delete(name: "Other")
        XCTAssertEqual(store.load().map(\.name), ["أرشفة الفواتير"])

        // A damaged entry is dropped, a damaged option comes back as its default.
        let damaged = #"[{"name":"x","steps":[{"kind":"rotate","quarterTurns":99,"pages":7},{"kind":"nonsense"}]},{"steps":[]},"junk"]"#
        defaults.set(Data(damaged.utf8), forKey: "batch.sequences")
        let read = store.load()
        XCTAssertEqual(read.map(\.name), ["x"])
        XCTAssertEqual(read.first?.steps.count, 1)
        XCTAssertEqual(read.first?.steps.first?.quarterTurns, 3)
        XCTAssertEqual(read.first?.steps.first?.pages, "")
        defaults.set(Data("not json".utf8), forKey: "batch.sequences")
        XCTAssertEqual(store.load(), [])
    }
}
