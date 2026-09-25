@testable import PDFEditor
import XCTest

/// The widgets' timelines from a seeded container, and the routes every
/// widget, control, Shortcut and quick action shares.
final class WidgetsAndRoutesTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "WidgetsTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func file(_ name: String) throws -> URL {
        let url = folder.appending(path: name)
        try Data("%PDF-1.4\n".utf8).write(to: url)
        return url
    }

    func testRecentsTimelineComesFromTheSeededContainerNewestFirstAndOnlyFilesStillThere() throws {
        let store = RecentsStore(fileURL: folder.appending(path: "recents.json"))
        let a = try file("a.pdf")
        let b = try file("b.pdf")
        let gone = try file("gone.pdf")
        try store.remember(RecentDocument(name: "a", bookmark: a.bookmarkData(), lastOpened: Date(timeIntervalSince1970: 100), pageCount: 1))
        try store.remember(RecentDocument(name: "gone", bookmark: gone.bookmarkData(), lastOpened: Date(timeIntervalSince1970: 150), pageCount: 4))
        try store.remember(RecentDocument(name: "b", bookmark: b.bookmarkData(), lastOpened: Date(timeIntervalSince1970: 200), pageCount: 2))
        try FileManager.default.removeItem(at: gone)

        XCTAssertEqual(WidgetTimelines.recents(from: store, capacity: 6).map(\.name), ["b", "a"])
        XCTAssertEqual(WidgetTimelines.recents(from: store, capacity: 1).map(\.name), ["b"], "the small widget shows the last one")
        XCTAssertEqual(WidgetTimelines.recents(from: RecentsStore(fileURL: folder.appending(path: "none.json")), capacity: 3), [])
    }

    func testSearchesTimelineKeepsEachQueryOnceNewestFirst() throws {
        let store = SearchesStore(fileURL: folder.appending(path: "searches.json"))
        try store.remember(RecentSearch(query: "فاتورة", date: Date(timeIntervalSince1970: 1), hits: 3))
        try store.remember(RecentSearch(query: "عقد", date: Date(timeIntervalSince1970: 2), hits: 1))
        try store.remember(RecentSearch(query: "فاتورة", date: Date(timeIntervalSince1970: 3), hits: 5))
        try store.remember(RecentSearch(query: "   ", date: Date(timeIntervalSince1970: 4), hits: 0))
        let shown = WidgetTimelines.searches(from: store, capacity: 4)
        XCTAssertEqual(shown.map(\.query), ["فاتورة", "عقد"])
        XCTAssertEqual(shown.first?.hits, 5)
        for i in 0..<(SearchesStore.limit + 3) {
            try store.remember(RecentSearch(query: "q\(i)", date: Date(timeIntervalSince1970: TimeInterval(10 + i)), hits: i))
        }
        XCTAssertEqual(store.load().count, SearchesStore.limit)
        XCTAssertEqual(WidgetTimelines.searches(from: store, capacity: 2).map(\.query), ["q\(SearchesStore.limit + 2)", "q\(SearchesStore.limit + 1)"])
    }

    func testRoutesRoundTripThroughTheirURLs() throws {
        let id = UUID()
        let routes: [AppRoute] = [.scan, .open(id: id), .openKey("folder/عقود/إيجار 2026.pdf"), .search("فاتورة ضريبية"), .search(""), .lastDocument]
        for route in routes {
            XCTAssertEqual(AppRoute(url: route.url), route, route.url.absoluteString)
            XCTAssertEqual(route.url.scheme, "pdfeditor")
        }
        XCTAssertEqual(AppRoute(url: URL(string: "pdfeditor://open/\(id.uuidString)")!), .open(id: id))
        XCTAssertNil(AppRoute(url: URL(string: "pdfeditor://open/not-an-id")!))
        XCTAssertNil(AppRoute(url: URL(string: "https://example.com/scan")!))
        XCTAssertNil(AppRoute(url: URL(string: "pdfeditor://elsewhere")!))
    }

    func testAPostedRouteIsTakenOnceByTheApp() {
        // A file of the test's own: the host app takes what lands in the
        // real one the moment the notification fires.
        let file = folder.appending(path: "pending-route")
        let expectation = expectation(forNotification: AppRoute.notification, object: nil) { note in
            (note.userInfo?["url"] as? URL) == AppRoute.search("عقد").url
        }
        AppRoute.search("عقد").post(to: file)
        wait(for: [expectation], timeout: 2)
        XCTAssertEqual(AppRoute.takePending(from: file), .search("عقد"))
        XCTAssertNil(AppRoute.takePending(from: file), "taken once")
        XCTAssertNil(AppRoute.takePending(from: folder.appending(path: "none")))
    }

    @MainActor
    func testQuickActionsCarryTheirRoutes() {
        let id = UUID()
        QuickActions.update(lastDocument: RecentDocument(id: id, name: "عقد", bookmark: Data(), pageCount: 3))
        let items = UIApplication.shared.shortcutItems ?? []
        XCTAssertEqual(items.map(\.type), [QuickActions.scanType, QuickActions.lastType])
        XCTAssertEqual(items.map { QuickActions.route(for: $0) }, [.scan, .open(id: id)])
        XCTAssertEqual(items[1].localizedTitle, "عقد")
        QuickActions.update(lastDocument: nil)
        XCTAssertEqual(UIApplication.shared.shortcutItems?.count, 1)
        let bare = UIApplicationShortcutItem(type: QuickActions.lastType, localizedTitle: "x")
        XCTAssertEqual(QuickActions.route(for: bare), .lastDocument)
    }
}
