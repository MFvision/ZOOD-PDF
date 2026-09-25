import AppIntents
@testable import PDFEditor
import WarraqCore
import XCTest

/// The App Intents' resolution: documents found by name from the recents
/// and the index, the search answered from the index file, a PDF made from
/// files, and the routes the opening intents leave for the app.
final class IntentsTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "IntentsTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: IntentsTests.self).url(forResource: name, withExtension: "pdf"))
        return try Data(contentsOf: url)
    }

    /// An index file with two corpus documents, and the keys file beside it.
    private func seededIndex() async throws -> IndexReader {
        let indexURL = folder.appending(path: "Index/library.wlx")
        let index = try await LibraryIndex.open(at: indexURL)
        _ = try await index.add(key: "documents/فاتورة.pdf", name: "فاتورة", modified: 1, bytes: fixture("coretext-sfarabic-mixed-invoice"))
        _ = try await index.add(key: "documents/albayan.pdf", name: "albayan", modified: 2, bytes: fixture("coretext-albayan-tashkeel"))
        try await index.save()
        await index.close()
        // Sorted, as the indexer writes them.
        try JSONEncoder().encode(["documents/albayan.pdf", "documents/فاتورة.pdf"]).write(to: folder.appending(path: "Index/library-keys.json"))
        return IndexReader(indexURL: indexURL, documentsFolder: folder)
    }

    func testDocumentsResolveByNameFromRecentsAndTheIndex() async throws {
        let reader = try await seededIndex()
        let store = RecentsStore(fileURL: folder.appending(path: "recents.json"))
        let file = folder.appending(path: "عقد.pdf")
        try Data("%PDF-1.4\n".utf8).write(to: file)
        let recentID = UUID()
        try store.remember(RecentDocument(id: recentID, name: "عقد إيجار", bookmark: file.bookmarkData(), pageCount: 2))

        let all = await DocumentQuery.allDocuments(store: store, index: reader)
        XCTAssertEqual(all.map(\.name), ["عقد إيجار", "albayan", "فاتورة"], "recents first, then the index, by name")
        XCTAssertEqual(all[0].route, .open(id: recentID))
        XCTAssertEqual(all[2].route, .openKey("documents/فاتورة.pdf"))
        XCTAssertEqual(all[2].pages, 1)

        // "Open <document>": by a part of the name, tashkeel and case aside.
        XCTAssertTrue(DocumentQuery.matches("عقد إيجار", "إيجار"))
        XCTAssertTrue(DocumentQuery.matches("فاتُورة", "فاتورة"), "diacritics do not matter")
        XCTAssertTrue(DocumentQuery.matches("Albayan", "albayan"))
        XCTAssertFalse(DocumentQuery.matches("عقد", "فاتورة"))
        let matched = all.filter { DocumentQuery.matches($0.name, "فاتور") }
        XCTAssertEqual(matched.map(\.name), ["فاتورة"])
        let byID = all.filter { $0.id == all[1].id }
        XCTAssertEqual(byID.count, 1)
    }

    func testSearchIntentAnswersFromTheIndexFile() async throws {
        let reader = try await seededIndex()
        let result = await reader.search("فاتوره", limit: 20)
        XCTAssertGreaterThan(result.total, 0)
        XCTAssertEqual(result.hits.first?.name, "فاتورة")
        XCTAssertEqual(result.hits.first?.page, 1)
        // A word no file holds (common words such as "في" would be found).
        let nothing = await reader.search("زقطبعرخ", limit: 20)
        XCTAssertEqual(nothing.total, 0)
        let none = await IndexReader(indexURL: folder.appending(path: "missing/library.wlx"), documentsFolder: folder).search("x", limit: 1)
        XCTAssertEqual(none.total, 0, "no index yet is no matches, not a failure")
    }

    func testMakePDFJoinsPDFsAndPictures() async throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 400))
        let picture = renderer.pngData { context in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 300, height: 400))
            UIColor.darkGray.setFill()
            context.fill(CGRect(x: 100, y: 100, width: 100, height: 100))
        }
        let photo = renderer.jpegData(withCompressionQuality: 0.8) { context in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 300, height: 400))
            UIColor.black.setFill()
            context.fill(CGRect(x: 40, y: 40, width: 200, height: 20))
        }
        let bytes = try await PDFMaker.pdf(fromFiles: [
            (name: "invoice.pdf", bytes: fixture("coretext-sfarabic-mixed-invoice")),
            (name: "photo.jpg", bytes: photo),
            (name: "symbol.png", bytes: picture),
        ])
        let core = try await Core.open(bytes: bytes)
        let pages = await core.pageCount
        XCTAssertEqual(pages, 3, "one page from the PDF, one from each picture")
        let text = try await core.extractText(page: 0)
        XCTAssertTrue(text.contains("فاتورة"), "the PDF's Arabic is intact")

        // Black and white and grey modes still make pages.
        let grey = try await PDFMaker.pdf(fromPictures: [photo], mode: .gray)
        let bw = try await PDFMaker.pdf(fromPictures: [photo], mode: .blackAndWhite)
        XCTAssertTrue(grey.starts(with: Data("%PDF".utf8)))
        XCTAssertTrue(bw.starts(with: Data("%PDF".utf8)))
    }

    /// Each opening intent posts its route; the host app takes it the moment
    /// the notification fires, so the notification's `url` is what is checked.
    @MainActor
    func testOpeningIntentsLeaveTheirRouteForTheApp() async throws {
        let id = UUID()
        let open = OpenDocumentIntent()
        open.document = DocumentEntity(recent: RecentDocument(id: id, name: "x", bookmark: Data(), pageCount: 1))
        let cases: [(name: String, route: AppRoute, run: () async throws -> Void)] = [
            ("scan", .scan, { _ = try await ScanDocumentIntent().perform() }),
            ("last", .lastDocument, { _ = try await OpenLastDocumentIntent().perform() }),
            ("open", .open(id: id), { _ = try await open.perform() }),
        ]
        for item in cases {
            let posted = expectation(forNotification: AppRoute.notification, object: nil) { note in
                (note.userInfo?["url"] as? URL) == item.route.url
            }
            try await item.run()
            await fulfillment(of: [posted], timeout: 2)
        }
    }

    func testTheShortcutsNameEveryIntent() {
        let shortcuts = PDFEditorShortcuts.appShortcuts
        XCTAssertEqual(shortcuts.count, 5)
    }
}
