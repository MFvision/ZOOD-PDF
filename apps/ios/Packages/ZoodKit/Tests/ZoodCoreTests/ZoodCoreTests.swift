import Foundation
import Testing
@testable import ZoodCore

@Suite("Arabic search normalisation (mirror of the web rules)")
struct SearchNormalizerTests {
    @Test func dropsTashkeelAndTatweel() {
        #expect(SearchNormalizer.normalize("مُحَمَّد") == "محمد")
        #expect(SearchNormalizer.normalize("العـــربية") == "العربيه")
        #expect(SearchNormalizer.normalize("\u{0670}ا") == "ا")
    }

    @Test func unifiesLetterForms() {
        #expect(SearchNormalizer.normalize("أإآٱ") == "اااا")
        #expect(SearchNormalizer.normalize("مستشفى") == "مستشفي")
        #expect(SearchNormalizer.normalize("مدرسة") == "مدرسه")
    }

    @Test func digitsAndCase() {
        #expect(SearchNormalizer.normalize("فاتورة ٢٠٢٤") == "فاتوره 2024")
        #expect(SearchNormalizer.normalize("۱۲۳") == "123")
        #expect(SearchNormalizer.normalize("Report Q3") == "report q3")
    }

    @Test func matchingNeedsEveryTerm() {
        let fields = ["فاتورة الكهرباء ٢٠٢٤.pdf", "منزل"]
        #expect(SearchNormalizer.matches(query: "فاتوره 2024", fields: fields))
        #expect(SearchNormalizer.matches(query: "إلكهرباء", fields: fields), "hamza forms unify")
        #expect(SearchNormalizer.matches(query: "الكهرباء ماء", fields: fields) == false)
        #expect(SearchNormalizer.matches(query: "الكهرباء منزل", fields: fields))
        #expect(SearchNormalizer.matches(query: "   ", fields: fields) == false)
    }
}

@Suite("Page ranges")
struct PageRangeTests {
    @Test func basics() throws {
        #expect(try PageRanges.parse("1-3, 5", pageCount: 9) == [0, 1, 2, 4])
        #expect(try PageRanges.parse("5, 1 - 2", pageCount: 9) == [4, 0, 1])
        #expect(try PageRanges.parse("8-", pageCount: 9) == [7, 8])
        #expect(try PageRanges.parse("2,2,2", pageCount: 3) == [1])
    }

    @Test func arabicInput() throws {
        #expect(try PageRanges.parse("١–٣، ٥", pageCount: 9) == [0, 1, 2, 4])
        #expect(try PageRanges.parse("۷ — ۹", pageCount: 9) == [6, 7, 8])
    }

    @Test func errors() {
        #expect(throws: PageRanges.ParseError.empty) { try PageRanges.parse(" ، ", pageCount: 3) }
        #expect(throws: PageRanges.ParseError.outOfRange(page: 4, pageCount: 3)) { try PageRanges.parse("4", pageCount: 3) }
        #expect(throws: PageRanges.ParseError.outOfRange(page: 0, pageCount: 3)) { try PageRanges.parse("0", pageCount: 3) }
        #expect(throws: PageRanges.ParseError.reversed("3-1")) { try PageRanges.parse("3-1", pageCount: 3) }
        #expect(throws: PageRanges.ParseError.invalid("a")) { try PageRanges.parse("a", pageCount: 3) }
        #expect(throws: PageRanges.ParseError.invalid("1-2-3")) { try PageRanges.parse("1-2-3", pageCount: 3) }
        #expect(throws: PageRanges.ParseError.invalid("-2")) { try PageRanges.parse("-2", pageCount: 3) }
    }

    @Test func formatting() {
        #expect(PageRanges.format([0, 1, 2, 4]) == "1-3, 5")
        #expect(PageRanges.format([4, 0]) == "1, 5")
        #expect(PageRanges.format([]) == "")
    }
}

@Suite("Hijri and Gregorian dates")
struct DateFormattingTests {
    let riyadh = TimeZone(identifier: "Asia/Riyadh") ?? .gmt
    /// 11 March 2024, noon in Riyadh = 1 Ramadan 1445 (Umm al-Qura).
    var ramadan1445: Date {
        var c = DateComponents()
        (c.year, c.month, c.day, c.hour) = (2024, 3, 11, 12)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = riyadh
        return cal.date(from: c) ?? Date()
    }

    @Test func ummAlQuraDay() {
        #expect(DateFormatting.hijriDay(ramadan1445, timeZone: riyadh) == .init(year: 1445, month: 9, day: 1))
    }

    @Test func formattedInEnglishAndArabic() {
        let en = DateFormatting.hijri(ramadan1445, locale: Locale(identifier: "en"), timeZone: riyadh)
        #expect(en.contains("1445"), "\(en)")
        #expect(en.contains("Ram"), "\(en)")
        let ar = DateFormatting.hijri(ramadan1445, locale: Locale(identifier: "ar-SA@numbers=arab"), timeZone: riyadh)
        #expect(ar.contains("رمضان"), "\(ar)")
        #expect(ar.contains("١٤٤٥"), "\(ar)")
        let both = DateFormatting.both(ramadan1445, locale: Locale(identifier: "en"), timeZone: riyadh)
        #expect(both.contains("2024") && both.contains("1445"))
    }

    @Test func localeNumerals() {
        #expect(DateFormatting.number(19, locale: Locale(identifier: "ar-SA@numbers=arab")) == "١٩")
        #expect(DateFormatting.number(19, locale: Locale(identifier: "en")) == "19")
    }
}

@Suite("File naming")
struct FileNamingTests {
    @Test func sanitizeRemovesSpoofingAndSeparators() {
        #expect(FileNaming.sanitize("invoice\u{202E}fdp.exe") == "invoicefdp.exe")
        #expect(FileNaming.sanitize("a/b:c\\d") == "a-b-c-d")
        #expect(FileNaming.sanitize("  ..تقرير..  ") == "تقرير")
        #expect(FileNaming.sanitize("\u{2067}\u{2069}") == "Document")
        #expect(FileNaming.sanitize(String(repeating: "ب", count: 300)).count == FileNaming.maxBaseLength)
    }

    @Test func derivedAndUnique() {
        #expect(FileNaming.derived(from: "Report.PDF", suffix: "compressed") == "Report (compressed).pdf")
        #expect(FileNaming.derived(from: "عقد.pdf", suffix: "مضغوط") == "عقد (مضغوط).pdf")
        #expect(FileNaming.pdfName("x.pdf") == "x.pdf")
        #expect(FileNaming.unique("Scan.pdf", existing: []) == "Scan.pdf")
        #expect(FileNaming.unique("Scan.pdf", existing: ["scan.pdf", "Scan 2.pdf"]) == "Scan 3.pdf")
    }

    @Test func scanNameUsesSortableAsciiDigits() {
        let d = Date(timeIntervalSince1970: 1_790_000_000) // 2026-09-21 14:13:20 UTC
        #expect(FileNaming.scanName(prefix: "مسح ضوئي", date: d, timeZone: .gmt) == "مسح ضوئي 2026-09-21 14.13.pdf")
    }
}

@Suite("Recents store")
struct RecentsStoreTests {
    func tempDir() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("zood-recents-\(UUID().uuidString)")
    }

    @Test func recordDedupesAndOrders() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let clock = Clock()
        let store = RecentsStore(directory: dir, now: { clock.tick() })
        let a = try await store.record(name: "a.pdf", bookmark: nil, documentsPath: "Scans/a.pdf", size: 10, pageCount: 1)
        _ = try await store.record(name: "b.pdf", bookmark: Data([1]), documentsPath: nil, size: 20, pageCount: 2)
        let again = try await store.record(name: "a.pdf", bookmark: nil, documentsPath: "Scans/a.pdf", size: 11, pageCount: nil)
        #expect(again.id == a.id)
        #expect(again.pageCount == 1)
        let list = await store.list()
        #expect(list.map(\.name) == ["a.pdf", "b.pdf"])
        #expect(RecentsStore.snapshot(directory: dir).count == 2, "widgets read the same file")
    }

    @Test func starsTagsSearchAndThumbnails() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = RecentsStore(directory: dir)
        let r = try await store.record(name: "فاتورة الكهرباء.pdf", bookmark: nil, documentsPath: nil, size: 5, pageCount: 1)
        try await store.setStarred(id: r.id, true)
        try await store.setTags(id: r.id, ["  منزل ", "منزل", "", "فواتير"])
        #expect(await store.item(id: r.id)?.tags == ["منزل", "فواتير"])
        #expect(await store.starred().count == 1)
        #expect(await store.search("فاتوره").count == 1)
        #expect(await store.search("فواتير").count == 1)
        #expect(await store.search("ماء").isEmpty)
        #expect(await store.tagged("منزل").count == 1)
        #expect(await store.allTags().count == 2)

        try await store.writeThumbnail(id: r.id, png: Data([0x89, 0x50]))
        #expect(await store.item(id: r.id)?.hasThumbnail == true)
        #expect(FileManager.default.fileExists(atPath: store.thumbnailURL(id: r.id).path))
        try await store.forgetThumbnail(id: r.id)
        #expect(await store.item(id: r.id)?.hasThumbnail == false)
        #expect(!FileManager.default.fileExists(atPath: store.thumbnailURL(id: r.id).path))
        try await store.remove(id: r.id)
        #expect(await store.list().isEmpty)
    }

    @Test func capsTheList() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = RecentsStore(directory: dir)
        for i in 0..<(RecentsStore.maxItems + 5) {
            try await store.record(name: "\(i).pdf", bookmark: nil, documentsPath: "\(i).pdf", size: Int64(i), pageCount: 1)
        }
        #expect(await store.list().count == RecentsStore.maxItems)
    }

    @Test func thumbnailPathCannotEscape() {
        let store = RecentsStore(directory: URL(fileURLWithPath: "/tmp/r"))
        #expect(store.thumbnailURL(id: "../../etc/passwd").lastPathComponent == "etcpasswd.png")
    }
}

/// Deterministic, strictly increasing clock for ordering tests.
final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var t = 1_700_000_000.0
    func tick() -> Date {
        lock.lock()
        defer { lock.unlock() }
        t += 1
        return Date(timeIntervalSince1970: t)
    }
}

@Suite("Scan geometry")
struct ScanGeometryTests {
    @Test func ordersShuffledCorners() throws {
        let pts = [Point2(90, 95), Point2(10, 5), Point2(5, 100), Point2(100, 0)]
        let q = try #require(Quad.ordered(pts))
        #expect(q.topLeft == Point2(10, 5))
        #expect(q.topRight == Point2(100, 0))
        #expect(q.bottomRight == Point2(90, 95))
        #expect(q.bottomLeft == Point2(5, 100))
    }

    @Test func rejectsDegenerateQuads() {
        #expect(Quad.ordered([Point2(0, 0), Point2(1, 1), Point2(2, 2), Point2(3, 3)]) == nil)
        #expect(Quad.ordered([Point2(0, 0), Point2(0, 0), Point2(2, 2), Point2(3, 3)]) == nil)
        #expect(Quad.ordered([Point2(0, 0)]) == nil)
    }

    @Test func areaSizeAndClamp() {
        let q = Quad.inset(Size2(100, 200), by: 0)
        #expect(q.area == 20_000)
        #expect(q.correctedSize == Size2(100, 200))
        let c = Quad(topLeft: Point2(-5, -5), topRight: Point2(120, 0), bottomRight: Point2(100, 250), bottomLeft: Point2(0, 200))
            .clamped(to: Size2(100, 200))
        #expect(c.topLeft == Point2(0, 0) && c.topRight == Point2(100, 0) && c.bottomRight == Point2(100, 200))
    }

    @Test func visionCoordinatesFlip() {
        let q = Quad.fromVision(
            topLeft: Point2(0, 1), topRight: Point2(1, 1), bottomRight: Point2(1, 0), bottomLeft: Point2(0, 0),
            imageSize: Size2(40, 20))
        #expect(q == Quad(topLeft: Point2(0, 0), topRight: Point2(40, 0), bottomRight: Point2(40, 20), bottomLeft: Point2(0, 20)))
    }

    @Test func idCardIsRealSizeAndCentred() {
        let (front, back) = ScanLayout.idCardFrames()
        #expect(abs(front.width - 242.65) < 0.1)
        #expect(abs(front.height - 153.01) < 0.1)
        #expect(abs(front.x + front.width / 2 - ScanLayout.a4.width / 2) < 0.001)
        #expect(back.y > front.y + front.height)
    }

    @Test func bookOrderFollowsReadingDirection() {
        let pages = ScanLayout.bookPages(spread: Size2(200, 100), rightToLeft: true)
        #expect(pages[0].x == 100, "Arabic books: the right-hand page comes first")
        #expect(ScanLayout.bookPages(spread: Size2(200, 100), rightToLeft: false)[0].x == 0)
    }

    @Test func aspectFit() {
        let r = ScanLayout.aspectFit(Size2(100, 50), in: Rect2(x: 0, y: 0, width: 50, height: 50))
        #expect(r == Rect2(x: 0, y: 12.5, width: 50, height: 25))
    }
}

@Suite("Deep links")
struct DeepLinkTests {
    @Test func roundTrip() {
        for link in [DeepLink.home, .scan(.book), .scan(.idCard), .openRecent(id: "ABC-123"), .combine, .compress] {
            #expect(DeepLink(url: link.url) == link, "\(link.url)")
        }
    }

    @Test func rejectsForeignOrBadLinks() {
        #expect(DeepLink(url: URL(string: "https://zood.sa/scan")!) == nil)
        #expect(DeepLink(url: URL(string: "zoodpdf://open")!) == nil)
        #expect(DeepLink(url: URL(string: "zoodpdf://format-disk")!) == nil)
        #expect(DeepLink(url: URL(string: "zoodpdf://scan?mode=nope")!) == .scan(.document))
    }
}
