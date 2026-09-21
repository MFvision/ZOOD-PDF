import WarraqCore
import XCTest

/// The Swift wrapper over the C ABI, on corpus files from the test bundle.
final class CoreTests: XCTestCase {
    func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: CoreTests.self).url(forResource: name, withExtension: "pdf"), "\(name).pdf is in the test bundle")
        return try Data(contentsOf: url)
    }

    func testVersionIsTheCoresVersion() {
        XCTAssertFalse(Core.version.isEmpty)
        XCTAssertEqual(Core.version.split(separator: ".").count, 3, Core.version)
    }

    func testReadsArabicInLogicalOrderFromACorpusFile() async throws {
        let core = try await Core.open(bytes: fixture("coretext-sfarabic-mixed-invoice"))
        let pages = await core.pageCount
        XCTAssertEqual(pages, 1)

        let text = try await core.extractText(page: 0)
        XCTAssertTrue(text.contains("فاتورة ضريبية مبسطة"), text)
        XCTAssertTrue(text.contains("شركة زود للتقنية"), text)

        let lines = try await core.textLines(page: 0)
        XCTAssertGreaterThan(lines.count, 5)
        XCTAssertTrue(lines.contains { $0.isRightToLeft })
        XCTAssertGreaterThan(lines[0].height, 0)

        // Arabic-aware: taa marbuta and haa are one letter to the search.
        let hits = try await core.search("الفاتوره")
        XCTAssertEqual(hits, [0])

        let metadata = try await core.metadata()
        XCTAssertEqual(metadata.pages, 1)
        XCTAssertFalse(metadata.encrypted)
        XCTAssertEqual(metadata.engine, "hayro")

        let size = try await core.pageSize(0)
        XCTAssertGreaterThan(size.width, 100)
        XCTAssertGreaterThan(size.height, size.width)

        let paragraphs = try await core.paragraphs(page: 0)
        XCTAssertEqual(paragraphs.first?.index, 0)

        let picture = try await core.renderPage(0, scale: 0.25)
        XCTAssertEqual(picture.rgba.count, picture.width * picture.height * 4)
    }

    func testACallEditsAndSaveIsAnIncrementalUpdate() async throws {
        let original = try fixture("coretext-sfarabic-mixed-invoice")
        let core = try await Core.open(bytes: original)
        struct Rotate: Encodable { let pages: [Int]; let quarterTurns: Int }
        let reply = try await core.call(op: "pages.rotate", args: Rotate(pages: [0], quarterTurns: 1))
        XCTAssertEqual(reply.object["pageCount"] as? Int, 1)

        let turned = try await core.pageSize(0)
        XCTAssertGreaterThan(turned.width, turned.height)

        let saved = try await core.save()
        XCTAssertTrue(saved.starts(with: original), "the original bytes are untouched")
        XCTAssertGreaterThan(saved.count, original.count, "the edit is appended")

        let again = try await Core.open(bytes: saved)
        let size = try await again.pageSize(0)
        XCTAssertGreaterThan(size.width, size.height)
    }

    func testAStaticCallCombinesFiles() async throws {
        let a = try fixture("coretext-sfarabic-mixed-invoice")
        let b = try fixture("raw-amiri-cid-identity-tounicode")
        let reply = try await Core.callStatic(op: "pages.combine", blobs: [a, b])
        XCTAssertEqual(reply.object["pageCount"] as? Int, 2)
        XCTAssertEqual(reply.blobs.count, 1)
        let combined = try await Core.open(bytes: reply.blobs[0])
        let pages = await combined.pageCount
        XCTAssertEqual(pages, 2)
    }

    func testErrorsAreTyped() async throws {
        do {
            _ = try await Core.open(bytes: Data("not a pdf".utf8))
            XCTFail("opened")
        } catch let error as CoreError {
            guard case .parse = error else { return XCTFail("\(error)") }
            XCTAssertEqual(error.code, "E_PARSE")
        }

        let locked = try fixture("variant-encrypted-rc4-40")
        do {
            _ = try await Core.open(bytes: locked)
            XCTFail("opened without a password")
        } catch let error as CoreError {
            XCTAssertEqual(error, .password)
        }
        do {
            _ = try await Core.open(bytes: locked, password: "wrong")
            XCTFail("opened with a wrong password")
        } catch let error as CoreError {
            XCTAssertEqual(error, .password)
        }
        let opened = try await Core.open(bytes: locked, password: "warraq")
        let metadata = try await opened.metadata()
        XCTAssertTrue(metadata.encrypted)

        do {
            _ = try await opened.extractText(page: 99)
            XCTFail("read a page that is not there")
        } catch let error as CoreError {
            guard case .page = error else { return XCTFail("\(error)") }
        }
        do {
            _ = try await opened.call(op: "nothing.here")
            XCTFail("ran an operation that does not exist")
        } catch let error as CoreError {
            guard case .unknownOperation = error else { return XCTFail("\(error)") }
        }
        do {
            _ = try await opened.call(op: "pages.rotate", args: #"{"pages":"not a list"}"#)
            XCTFail("took bad arguments")
        } catch let error as CoreError {
            guard case .arguments = error else { return XCTFail("\(error)") }
        }

        await opened.close()
        let isOpen = await opened.isOpen
        XCTAssertFalse(isOpen)
        do {
            _ = try await opened.metadata()
            XCTFail("used a closed document")
        } catch let error as CoreError {
            XCTAssertEqual(error, .closed)
        }
    }
}
