@testable import PDFEditor
import WarraqCore
import XCTest

/// The Library's index over corpus files, and the indexer that reads the
/// app's folders into it — with a fake recognizer standing in for OCR, so
/// the scan path is proven without Vision (whose Arabic on the simulator
/// is recorded by `testVisionLanguagesOnThisSimulator`).
final class LibraryTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "LibraryTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: LibraryTests.self).url(forResource: name, withExtension: "pdf"), "\(name).pdf is in the test bundle")
        return try Data(contentsOf: url)
    }

    private func copyFixture(_ name: String, into destination: URL, as fileName: String? = nil) throws -> URL {
        let source = try XCTUnwrap(Bundle(for: LibraryTests.self).url(forResource: name, withExtension: "pdf"))
        let target = destination.appending(path: fileName ?? "\(name).pdf")
        try FileManager.default.copyItem(at: source, to: target)
        return target
    }

    // MARK: - The index

    func testIndexesCorpusFilesAndSearchesArabicWithoutTashkeel() async throws {
        let index = try await LibraryIndex.open(at: folder.appending(path: "library.wlx"))
        let invoice = try await index.add(key: "documents/invoice.pdf", name: "invoice", modified: 1, bytes: fixture("coretext-sfarabic-mixed-invoice"))
        XCTAssertTrue(invoice.added, "\(invoice)")
        XCTAssertEqual(invoice.guessedKind, .pdf)
        let tashkeel = try await index.add(key: "documents/albayan.pdf", name: "albayan", modified: 2, bytes: fixture("coretext-albayan-tashkeel"))
        XCTAssertTrue(tashkeel.added)
        let cairo = try await index.add(key: "documents/cairo.pdf", name: "cairo", modified: 3, bytes: fixture("chrome-cairo-mixed-invoice"))
        XCTAssertTrue(cairo.added)
        let documents = await index.documents
        XCTAssertEqual(documents, 3)

        // The invoice's word, written without its tashkeel and with a haa
        // for the taa marbuta: the index matches it all the same.
        let result = try await index.search("فاتوره")
        XCTAssertGreaterThan(result.total, 0)
        let names = Set(result.hits.map(\.name))
        XCTAssertTrue(names.contains("invoice"), "\(names)")
        let hit = try XCTUnwrap(result.hits.first { $0.name == "invoice" })
        XCTAssertEqual(hit.page, 1, "pages are counted from one")
        XCTAssertFalse(hit.spans.isEmpty, "the matched word is marked")
        let marked = String(hit.marked.characters)
        XCTAssertEqual(marked, hit.text)

        // A search of a word with tashkeel in the file, asked without any.
        let albayanText = try await Core.open(bytes: fixture("coretext-albayan-tashkeel")).extractText(page: 0)
        let word = try XCTUnwrap(albayanText.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            .first { $0.unicodeScalars.contains { (0x064B...0x0652).contains($0.value) } && $0.count > 5 }, albayanText)
        let bare = word.unicodeScalars.filter { (0x0621...0x064A).contains($0.value) }.map { String($0) }.joined()
        let bareResult = try await index.search(bare)
        XCTAssertTrue(bareResult.hits.contains { $0.name == "albayan" }, "\(bare) not found: \(bareResult.hits.map(\.name))")

        // Filters: kinds and tags.
        let onlyScans = try await index.search("فاتوره", filters: SearchFilters(kinds: [.scan]))
        XCTAssertEqual(onlyScans.total, 0)
        _ = try await index.tag(key: "documents/invoice.pdf", add: ["فواتير"])
        let tagged = try await index.search("فاتوره", filters: SearchFilters(tags: ["فواتير"]))
        XCTAssertTrue(tagged.hits.allSatisfy { $0.key == "documents/invoice.pdf" })
        let stats = try await index.stats()
        XCTAssertEqual(stats.documents, 3)
        XCTAssertEqual(stats.tags["فواتير"], 1)

        // A rule tags by words, and applies to what is already there.
        let rules = try await index.rules(set: [TagRule(tag: "ضريبة", words: ["ضريبية"], all: nil, enabled: true, scope: "text", kinds: nil)], apply: true)
        XCTAssertEqual(rules.rules.count, 1)
        XCTAssertGreaterThan(rules.tagged, 0)
        let document = try await index.document(key: "documents/invoice.pdf")
        XCTAssertTrue(document?.tags.contains("ضريبة") == true, "\(String(describing: document))")
        let missing = try await index.document(key: "documents/nothing.pdf")
        XCTAssertNil(missing)

        // Saved, closed, reopened: everything is still there.
        try await index.save()
        await index.close()
        let again = try await LibraryIndex.open(at: folder.appending(path: "library.wlx"))
        let reopened = await again.documents
        XCTAssertEqual(reopened, 3)
        let found = try await again.search("فاتوره")
        XCTAssertEqual(found.total, result.total)
        let keptRules = try await again.rules()
        XCTAssertEqual(keptRules.rules.first?.tag, "ضريبة")
        try await again.forget(keys: ["documents/cairo.pdf"])
        let left = await again.documents
        XCTAssertEqual(left, 2)
        await again.close()
    }

    func testADamagedIndexFileIsSetAsideNotFatal() async throws {
        let url = folder.appending(path: "library.wlx")
        try Data("WRQLIB garbage".utf8).write(to: url)
        let index = try await LibraryIndex.open(at: url)
        let documents = await index.documents
        XCTAssertEqual(documents, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.appendingPathExtension("damaged").path))
        await index.close()
    }

    // MARK: - The indexer

    /// A reader that answers fixed words for every picture, and counts how
    /// often it was asked.
    final class FakeRecognizer: PageTextReading, @unchecked Sendable {
        let words: [IndexedWord]
        private let lock = NSLock()
        private var count = 0
        var calls: Int { lock.withLock { count } }

        init(lines: [String]) {
            words = lines.enumerated().flatMap { line, text in
                text.split(separator: " ").map { IndexedWord(text: String($0), line: line) }
            }
        }

        func read(_ image: CGImage, languages: [String]) async throws -> [IndexedWord] {
            lock.withLock { count += 1 }
            XCTAssertGreaterThan(image.width, 100)
            return words
        }
    }

    @MainActor
    func testIndexerReadsDocumentsAndRecognizesScansThroughTheSeam() async throws {
        let documents = folder.appending(path: "Documents", directoryHint: .isDirectory)
        let thumbnails = folder.appending(path: "Thumbnails", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: true)
        _ = try copyFixture("coretext-sfarabic-mixed-invoice", into: documents)
        _ = try copyFixture("scan-arial-200dpi-bilevel", into: documents)
        try Data("not a pdf".utf8).write(to: documents.appending(path: "broken.pdf"))

        let fake = FakeRecognizer(lines: ["عقد إيجار سكني", "المستأجر أحمد"])
        PageText.reader = fake
        defer { PageText.reader = ScannerPageTextReader() }

        let index = try await LibraryIndex.open(at: folder.appending(path: "Index/library.wlx"))
        let indexer = LibraryIndexer(index: index, documentsFolder: documents, thumbnailsFolder: thumbnails)
        indexer.run(chosen: nil)
        XCTAssertTrue(indexer.isRunning)
        try await waitUntil { !indexer.isRunning }
        let summary = try XCTUnwrap(indexer.summary)
        XCTAssertEqual(summary.added, 2, "\(summary)")
        XCTAssertEqual(summary.skipped, 1, "the file that is not a PDF")
        XCTAssertEqual(summary.recognized, 1, "the scan's one page went through the seam")
        XCTAssertEqual(fake.calls, 1)
        XCTAssertEqual(indexer.catalog.count, 2)
        XCTAssertEqual(indexer.catalog["documents/scan-arial-200dpi-bilevel.pdf"]?.kind, .scan)
        XCTAssertEqual(indexer.catalog["documents/coretext-sfarabic-mixed-invoice.pdf"]?.kind, .pdf)
        XCTAssertNotNil(indexer.thumbnailURL(for: "documents/scan-arial-200dpi-bilevel.pdf"), "a thumbnail was drawn")
        XCTAssertNotNil(indexer.thumbnailURL(for: "documents/coretext-sfarabic-mixed-invoice.pdf"))

        // The recognized words are searchable, tashkeel or not, and lead to the scan.
        let hits = try await index.search("المستاجر")
        XCTAssertEqual(hits.hits.first?.key, "documents/scan-arial-200dpi-bilevel.pdf", "\(hits.hits)")
        XCTAssertEqual(hits.hits.first?.page, 1)
        let scansOnly = try await index.search("عقد", filters: SearchFilters(scannedOnly: true))
        XCTAssertEqual(scansOnly.total, 1)

        // A second run reads nothing again.
        indexer.run(chosen: nil)
        try await waitUntil { !indexer.isRunning }
        XCTAssertEqual(indexer.summary?.added, 0)
        XCTAssertEqual(indexer.summary?.unchanged, 2)
        XCTAssertEqual(fake.calls, 1)

        // A file taken away leaves the index on the next run.
        try FileManager.default.removeItem(at: documents.appending(path: "scan-arial-200dpi-bilevel.pdf"))
        indexer.run(chosen: nil)
        try await waitUntil { !indexer.isRunning }
        XCTAssertEqual(indexer.summary?.forgotten, 1)
        XCTAssertEqual(indexer.catalog.count, 1)
        let gone = try await index.search("المستاجر")
        XCTAssertEqual(gone.total, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appending(path: "Index/library.wlx").path), "the index was saved")
        await index.close()
    }

    @MainActor
    func testStopEndsARunBetweenFiles() async throws {
        let documents = folder.appending(path: "Documents", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: true)
        for i in 0..<30 {
            _ = try copyFixture("chrome-cairo-mixed-invoice", into: documents, as: "file-\(i).pdf")
        }
        let index = try await LibraryIndex.open(at: folder.appending(path: "Index/library.wlx"))
        let indexer = LibraryIndexer(index: index, documentsFolder: documents, thumbnailsFolder: folder.appending(path: "Thumbnails"))
        indexer.run(chosen: nil)
        try await waitUntil { (indexer.progress?.done ?? 0) >= 1 }
        indexer.stop()
        try await waitUntil { !indexer.isRunning }
        let summary = try XCTUnwrap(indexer.summary)
        XCTAssertTrue(summary.stopped)
        XCTAssertLessThan(summary.added, 30, "stopped before the end")
        await index.close()
    }

    func testVisionLanguagesOnThisSimulator() {
        let languages = TextRecognizer.supportedLanguages()
        // Recorded in docs/STATUS.md: whether Arabic is among them here.
        print("VISION_LANGUAGES: \(languages)")
        XCTAssertFalse(languages.isEmpty)
    }

    func testTheLinesOfAPageComeBackFromItsWords() {
        let words = [
            IndexedWord(text: "ب", line: 1),
            IndexedWord(text: "أ", line: 0),
            IndexedWord(text: "ج", line: 1),
        ]
        XCTAssertEqual(PageText.lines(of: words), ["أ", "ب ج"])
    }

    @MainActor
    private func waitUntil(timeout: TimeInterval = 120, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date.now.addingTimeInterval(timeout)
        while !condition() {
            if Date.now > deadline {
                XCTFail("timed out waiting")
                throw CancellationError()
            }
            try await Task.sleep(for: .milliseconds(100))
        }
    }
}
