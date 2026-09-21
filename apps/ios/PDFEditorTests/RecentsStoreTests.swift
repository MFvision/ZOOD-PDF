@testable import PDFEditor
import XCTest

/// The recents list the Library and the widgets share.
final class RecentsStoreTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "RecentsStoreTests-\(UUID().uuidString)", directoryHint: .isDirectory)
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

    func testRemembersNewestFirstAndOncePerFile() throws {
        let store = RecentsStore(fileURL: folder.appending(path: "recents.json"))
        XCTAssertEqual(store.load(), [])
        let a = try file("a.pdf")
        let b = try file("b.pdf")
        try store.remember(RecentDocument(name: "a", bookmark: a.bookmarkData(), lastOpened: Date(timeIntervalSince1970: 100), pageCount: 1))
        try store.remember(RecentDocument(name: "b", bookmark: b.bookmarkData(), lastOpened: Date(timeIntervalSince1970: 200), pageCount: 2))
        XCTAssertEqual(store.load().map(\.name), ["b", "a"])

        // The same file again moves to the top with its new entry.
        try store.remember(RecentDocument(name: "a again", bookmark: a.bookmarkData(), lastOpened: Date(timeIntervalSince1970: 300), pageCount: 1))
        XCTAssertEqual(store.load().map(\.name), ["a again", "b"])
        XCTAssertEqual(store.load()[0].resolveURL()?.standardizedFileURL, a.standardizedFileURL)

        let id = store.load()[1].id
        try store.forget(id: id)
        XCTAssertEqual(store.load().map(\.name), ["a again"])
        try store.clear()
        XCTAssertEqual(store.load(), [])
    }

    func testKeepsAtMostTheLimit() throws {
        let store = RecentsStore(fileURL: folder.appending(path: "recents.json"))
        let url = try file("x.pdf")
        let bookmark = try url.bookmarkData()
        for i in 0..<(RecentsStore.limit + 5) {
            var list = store.load()
            list.append(RecentDocument(name: "\(i)", bookmark: bookmark, lastOpened: Date(timeIntervalSince1970: TimeInterval(i)), pageCount: 1))
            try store.save(list)
        }
        XCTAssertEqual(store.load().count, RecentsStore.limit)
        XCTAssertEqual(store.load().first?.name, "\(RecentsStore.limit + 4)", "the newest survive")
    }

    func testADamagedFileIsAnEmptyList() throws {
        let fileURL = folder.appending(path: "recents.json")
        try Data("{not json".utf8).write(to: fileURL)
        XCTAssertEqual(RecentsStore(fileURL: fileURL).load(), [])
    }
}
