@testable import PDFEditor
import Compression
import PDFKit
import WarraqCore
import XCTest

/// Redact on iPhone and iPad, through the model the screen drives: words
/// and patterns found Arabic-aware, marks laid and labelled by the core,
/// applied, saved — and then the saved file attacked: the core's reading
/// of every page, its search, the raw bytes and every stream in them
/// inflated, in each encoding a PDF holds text in, must have nothing of
/// what was marked, while the rest of each line reads back exactly.
@MainActor
final class RedactTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = try PartB.folder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: - Reading a file the hard way

    /// The file as anyone could read it without a PDF reader: its bytes, and
    /// every stream in it inflated.
    static func readable(_ bytes: Data) -> [Data] {
        var parts = [bytes]
        let start = Data("stream".utf8)
        let end = Data("endstream".utf8)
        var at = bytes.startIndex
        while let s = bytes.range(of: start, in: at..<bytes.endIndex) {
            var body = s.upperBound
            while body < bytes.endIndex, bytes[body] == 0x0D || bytes[body] == 0x0A { body += 1 }
            guard let e = bytes.range(of: end, in: body..<bytes.endIndex) else { break }
            let raw = bytes[body..<e.lowerBound]
            // Flate is zlib: two bytes of header, then raw deflate.
            if raw.count > 2, let plain = inflate(Data(raw.dropFirst(2))) {
                parts.append(plain)
            }
            at = e.upperBound
        }
        return parts
    }

    static func inflate(_ data: Data) -> Data? {
        let capacity = max(data.count * 20, 1 << 16)
        var out = Data(count: capacity)
        let written = out.withUnsafeMutableBytes { dst in
            data.withUnsafeBytes { src in
                compression_decode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, capacity,
                                          src.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
            }
        }
        return written > 0 ? out.prefix(written) : nil
    }

    /// `word` in UTF-8, UTF-16BE, UTF-16LE and UTF-16BE as hex either case.
    static func encodings(_ word: String) -> [(String, Data)] {
        let be = word.utf16.flatMap { [UInt8($0 >> 8), UInt8($0 & 0xFF)] }
        let le = word.utf16.flatMap { [UInt8($0 & 0xFF), UInt8($0 >> 8)] }
        let hex = be.map { String(format: "%02x", $0) }.joined()
        return [("UTF-8", Data(word.utf8)), ("UTF-16BE", Data(be)), ("UTF-16LE", Data(le)),
                ("hex", Data(hex.utf8)), ("HEX", Data(hex.uppercased().utf8))]
    }

    /// `word` is nowhere in `bytes` in any encoding, no page reads it, and
    /// the core's Arabic-aware search finds it nowhere.
    static func assertGone(_ word: String, from bytes: Data, file: StaticString = #filePath, line: UInt = #line) async throws {
        for part in readable(bytes) {
            for (name, needle) in encodings(word) {
                XCTAssertNil(part.range(of: needle), "\(word) is still in the file, \(name)", file: file, line: line)
            }
        }
        let core = try await Core.open(bytes: bytes)
        for page in 0..<(await core.pageCount) {
            let text = try await core.extractText(page: page)
            XCTAssertFalse(text.contains(word), "page \(page) still reads \(word)", file: file, line: line)
        }
        struct Args: Encodable { let query: String }
        let reply = try await core.call(op: "redact.find", args: Args(query: word))
        XCTAssertEqual(reply.object["total"] as? Int, 0, "the search still finds \(word)", file: file, line: line)
    }

    /// The lines of a page as the core reads them.
    static func lines(_ bytes: Data, page: Int = 0) async throws -> [String] {
        let core = try await Core.open(bytes: bytes)
        return try await core.textLines(page: page).map(\.text)
    }

    private func settle(_ redact: RedactModel) async throws {
        let deadline = Date(timeIntervalSinceNow: 30)
        while redact.working {
            if Date() > deadline { XCTFail("the redaction did not settle"); return }
            try await Task.sleep(for: .milliseconds(30))
        }
    }

    // MARK: - Find and redact

    func testFoundWordsAndEmailsAreGoneFromTheSavedFileAndTheRestReadsExactly() async throws {
        let model = try await PartB.loadedModel("contract", in: folder)
        let original = model.bytes
        let redact = RedactModel(model: model)
        let undo = UndoManager()
        redact.undoManager = undo
        redact.query = "Haddad"
        redact.chosenPatterns = ["email"]
        await redact.search()
        // The "haddad" inside the first address and the address itself are
        // one stretch of text: merged into one match, as the desktop lists it.
        XCTAssertEqual(redact.total, 3)
        XCTAssertEqual(redact.matches.map(\.text), ["Haddad", "nadia.haddad@example.com", "nadia@example.sa"])
        redact.markChosenMatches()
        XCTAssertEqual(redact.marks.count, 3)
        await redact.apply()
        try await settle(redact)
        XCTAssertNil(redact.error)
        XCTAssertTrue(redact.marks.isEmpty, "the marks are spent")
        XCTAssertEqual(redact.applied?.glyphs, 6 + 24 + 16, "Haddad and both addresses")
        XCTAssertFalse(model.bytes.starts(with: original.prefix(original.count / 2)), "written whole, not as an update")

        try await model.save()
        let saved = try Data(contentsOf: try XCTUnwrap(model.url))
        for word in ["Haddad", "haddad", "nadia.haddad@example.com", "nadia@example.sa", "example.com", "example.sa"] {
            try await Self.assertGone(word, from: saved)
        }
        let lines = try await Self.lines(saved)
        XCTAssertEqual(lines[0], "Contract between Warraq Labs and Nadia")
        XCTAssertEqual(lines[1], "Contact: , phone +966 50 123 4567")
        XCTAssertEqual(lines[2], "IBAN SA03 8000 0000 6080 1016 7519, card 4111 1111 1111 1111")
        XCTAssertTrue(lines.contains("البريد:  والجوال ٠٥٠١٢٣٤٥٦٧"), "\(lines)")
    }

    func testArabicFoundWithoutItsTashkeelIsGoneAndItsLineReadsExactly() async throws {
        let model = try await PartB.loadedModel("contract", in: folder)
        let redact = RedactModel(model: model)
        redact.undoManager = UndoManager()
        // Typed as a person types it: no shadda.
        redact.query = "وراق"
        await redact.search()
        XCTAssertEqual(redact.matches.map(\.text), ["ورّاق"])
        redact.markChosenMatches()
        redact.query = "نادية"
        await redact.search()
        XCTAssertEqual(redact.matches.map(\.text), ["نادية"])
        redact.markChosenMatches()
        await redact.apply()
        try await settle(redact)
        try await model.save()
        let saved = try Data(contentsOf: try XCTUnwrap(model.url))
        try await Self.assertGone("ورّاق", from: saved)
        try await Self.assertGone("نادية", from: saved)
        let lines = try await Self.lines(saved)
        XCTAssertTrue(lines.contains("العقد بين شركة  والسيدة"), "\(lines)")
        XCTAssertTrue(lines.contains("Contract between Warraq Labs and Nadia Haddad"), "the English line is untouched: \(lines)")
    }

    // MARK: - Marks laid by hand

    /// An area marked over a word is named by what the core reads under it,
    /// exactly, and taking it out leaves the words beside it.
    func testAnAreaMarkIsNamedByTheCoreAndTakesOutOnlyItsWord() async throws {
        let model = try await PartB.loadedModel("contract", in: folder)
        let redact = RedactModel(model: model)
        redact.undoManager = UndoManager()
        // Where the core found "Labs", as a finger would draw round it.
        redact.query = "Labs"
        await redact.search()
        let box = try XCTUnwrap(redact.matches.first?.rects.first?.cgRect)
        redact.clearSearch()
        await redact.mark(rects: [box.insetBy(dx: -1, dy: -1)], onPage: 0, kind: .area)
        XCTAssertEqual(redact.marks.first?.label, "Labs")
        await redact.apply()
        try await settle(redact)
        let lines = try await Self.lines(model.bytes)
        XCTAssertEqual(lines[0], "Contract between Warraq  and Nadia Haddad")
        try await Self.assertGone("Labs", from: model.bytes)
    }

    func testRemovingAMarkLeavesTheOthersAndNothingIsWrittenUntilApply() async throws {
        let model = try await PartB.loadedModel("contract", in: folder)
        let before = model.bytes
        let redact = RedactModel(model: model)
        redact.query = "Haddad"
        await redact.search()
        redact.markChosenMatches()
        XCTAssertEqual(redact.marks.count, 2)
        XCTAssertEqual(model.bytes, before, "marks are not in the file")
        redact.remove(redact.marks[0].id)
        XCTAssertEqual(redact.marks.map(\.label), ["haddad"])
        redact.removeAll()
        XCTAssertTrue(redact.marks.isEmpty)
        XCTAssertEqual(model.bytes, before)
    }

    // MARK: - Undo, protection, hidden information

    func testUndoBringsTheTextBackUntilSaveAndRedoTakesItAgain() async throws {
        let model = try await PartB.loadedModel("contract", in: folder)
        let undo = UndoManager()
        let redact = RedactModel(model: model)
        redact.undoManager = undo
        redact.query = "Haddad"
        await redact.search()
        redact.markChosenMatches()
        await redact.apply()
        try await settle(redact)
        var lines = try await Self.lines(model.bytes)
        XCTAssertEqual(lines[0], "Contract between Warraq Labs and Nadia")
        XCTAssertTrue(undo.canUndo)
        undo.undo()
        _ = await model.readyEngine()
        lines = try await Self.lines(model.bytes)
        XCTAssertEqual(lines[0], "Contract between Warraq Labs and Nadia Haddad", "undone: the original is back")
        XCTAssertFalse(model.isEdited)
        undo.redo()
        _ = await model.readyEngine()
        lines = try await Self.lines(model.bytes)
        XCTAssertEqual(lines[0], "Contract between Warraq Labs and Nadia")
    }

    func testAProtectedFileIsRefusedAndLeftAsItWas() async throws {
        let model = try await PartB.loadedModel("variant-encrypted-aes256", in: folder, password: "warraq")
        let before = model.bytes
        let redact = RedactModel(model: model)
        XCTAssertTrue(redact.isProtected)
        await redact.mark(rects: [CGRect(x: 50, y: 50, width: 100, height: 20)], onPage: 0, kind: .area)
        await redact.apply()
        XCTAssertNotNil(redact.error, "refused, with the reason")
        XCTAssertEqual(model.bytes, before)
        XCTAssertEqual(redact.marks.count, 1, "the mark is kept, to apply once the password is off")
    }

    func testHiddenInformationIsReportedAndRemovedWhole() async throws {
        let model = try await PartB.loadedModel("variant-arabic-metadata-outlines-annots", in: folder)
        let redact = RedactModel(model: model)
        redact.undoManager = UndoManager()
        await redact.inspect()
        let found = Set(try XCTUnwrap(redact.report).findings.map(\.kind))
        XCTAssertTrue(found.isSuperset(of: ["metadata", "bookmarks", "comments"]), "\(found)")
        XCTAssertFalse(redact.chosenFindings.contains("hiddenText"), "hidden text is never chosen for the person")
        await redact.removeHidden()
        try await settle(redact)
        XCTAssertNil(redact.error)
        let left = Set(try XCTUnwrap(redact.report).findings.map(\.kind))
        XCTAssertTrue(left.isDisjoint(with: ["metadata", "bookmarks", "comments"]), "\(left)")
        XCTAssertEqual(redact.report?.revisions, 0)
        let core = try await Core.open(bytes: model.bytes)
        let metadata = try await core.metadata()
        XCTAssertNil(metadata.author)
        XCTAssertNil(metadata.title)
    }
}
