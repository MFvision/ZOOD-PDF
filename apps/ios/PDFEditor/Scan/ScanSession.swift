import CoreGraphics
import CoreImage
import Foundation
import Observation
import SwiftUI
import WarraqCore

/// What is being scanned: loose pages, the two sides of a card, a
/// passport's page, or an open book.
enum ScanMode: String, CaseIterable, Identifiable, Codable {
    case document
    case idCard
    case passport
    case book

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .document: "Document"
        case .idCard: "ID card"
        case .passport: "Passport"
        case .book: "Book"
        }
    }

    var symbol: String {
        switch self {
        case .document: "doc.viewfinder"
        case .idCard: "person.text.rectangle"
        case .passport: "book.closed"
        case .book: "book"
        }
    }

    /// ID and passport modes compose their sides onto one page.
    var composesOnePage: Bool { self == .idCard || self == .passport }

    var idKind: IDPageComposer.Kind? {
        switch self {
        case .idCard: .card
        case .passport: .passport
        default: nil
        }
    }
}

/// Which side or half a page is, where the mode cares.
enum ScanSide: String, Codable, Sendable {
    case front
    case back
    case left
    case right

    var title: LocalizedStringKey {
        switch self {
        case .front: "Front"
        case .back: "Back"
        case .left: "Left page"
        case .right: "Right page"
        }
    }
}

/// One captured page: the photo as taken, its corners, what the pipeline
/// made of it, and what Vision read off it.
struct ScanPage: Identifiable {
    let id: UUID
    var original: CGImage
    var quad: Quad
    var enhancement: Enhancement
    var side: ScanSide?
    /// The page inside its corners.
    var corrected: CGImage?
    /// The page after the enhancement.
    var enhanced: CGImage?
    /// Degrees counter-clockwise the deskew took out.
    var skew = 0.0
    /// Book mode: the bow taken out, in pixels, when it could be measured.
    var bow: Double?
    var recognition: Recognition?
    /// The slant Vision read the page at: 0 once deskewed; otherwise the
    /// slant measured before reading, which the text layer is turned by.
    var recognitionAngle = 0.0
    /// Bumped with every change; a result for an older version is dropped.
    var version = 0
    var isProcessing = false

    var originalSize: CGSize { CGSize(width: original.width, height: original.height) }
    /// What the screen shows: the best picture there is so far.
    var display: CGImage { enhanced ?? corrected ?? original }
}

/// A scan in progress: the pages captured so far, in order, each with its
/// corners and enhancement, the mode, and what the session can make of
/// them — a PDF with a text layer, and the text alone. Everything works on
/// pictures in memory; nothing is written until `savePDF`.
@MainActor @Observable
final class ScanSession {
    /// At most this many pages in one session.
    nonisolated static let maxPages = 50

    private var storedMode: ScanMode
    var mode: ScanMode {
        get { storedMode }
        set {
            guard newValue != storedMode else { return }
            storedMode = newValue
            for index in pages.indices {
                pages[index].enhancement.flattenCurvature = newValue == .book
                pages[index].side = nil
            }
            assignSides()
            for page in pages { process(page.id) }
            refreshComposedPage()
        }
    }
    private(set) var pages: [ScanPage] = []
    var selectedID: UUID?
    /// While the compare button is held: the stage shows the page cut out
    /// but not enhanced.
    var previewOriginal = false
    /// The enhancement new pages start with.
    var defaultEnhancement: Enhancement
    var ocrEnabled = true
    /// The languages chosen in Settings ("ar", "en"), before the device's answer.
    var chosenLanguages: [String]
    /// Vision's own list on this device.
    let supportedLanguages: [String]
    private(set) var isBusy = false
    private(set) var busyMessage: LocalizedStringKey?
    /// Something that went wrong, shown once: one of the app's own messages
    /// (a key of the String Catalog), or the system's.
    var error: LocalizedStringKey?
    /// The PDF just written, and the text just read.
    private(set) var savedURL: URL?
    private(set) var recognizedText: String?
    /// ID and passport modes: the sides composed on one page.
    private(set) var composedPage: CGImage?
    let documentsFolder: URL

    init(mode: ScanMode = .document,
         documentsFolder: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0],
         enhancement: Enhancement = Enhancement(),
         languages: [String] = ["ar", "en"],
         supportedLanguages: [String]? = nil) {
        self.storedMode = mode
        self.documentsFolder = documentsFolder
        self.defaultEnhancement = enhancement
        self.chosenLanguages = languages
        self.supportedLanguages = supportedLanguages ?? TextRecognizer.supportedLanguages()
    }

    // MARK: - What the session reads

    /// The languages Vision will be asked to read, as it names them.
    var readingLanguages: [String] {
        TextRecognizer.languages(chosen: chosenLanguages, supported: supportedLanguages)
    }

    var readsArabic: Bool {
        TextRecognizer.supports("ar", in: supportedLanguages)
    }

    /// "Arabic, English" — the languages the device will read, named.
    var readingLanguageNames: String {
        readingLanguages.map(TextRecognizer.name(of:)).joined(separator: ", ")
    }

    // MARK: - Pages

    var selected: ScanPage? {
        pages.first { $0.id == selectedID } ?? pages.last
    }

    var selectedIndex: Int? {
        guard let selected else { return nil }
        return pages.firstIndex { $0.id == selected.id }
    }

    func page(_ id: UUID) -> ScanPage? {
        pages.first { $0.id == id }
    }

    /// Takes photos into the session: the page found in each (Vision), or
    /// in book mode the spread cut at its gutter into two pages.
    func add(images: [CGImage]) async {
        for image in images.prefix(Self.maxPages - pages.count) {
            let placeholder = UUID()
            let mode = mode
            let detected = await Task.detached(priority: .userInitiated) { () -> (quad: Quad?, halves: (CGImage, CGImage)?) in
                let quad = mode == .book ? ScanPipeline.detectSpread(in: image) : ScanPipeline.detectPage(in: image)
                guard mode == .book else { return (quad, nil) }
                let spread = ScanPipeline.corrected(image, quad: quad ?? .whole(CGSize(width: image.width, height: image.height)))
                let split = BookSplitter.split(spread)
                return (quad, (split.left, split.right))
            }.value
            if let halves = detected.halves {
                append(ScanPage(id: placeholder, original: halves.0, quad: .whole(CGSize(width: halves.0.width, height: halves.0.height)),
                                enhancement: pageEnhancement(), side: .left))
                append(ScanPage(id: UUID(), original: halves.1, quad: .whole(CGSize(width: halves.1.width, height: halves.1.height)),
                                enhancement: pageEnhancement(), side: .right))
            } else {
                let size = CGSize(width: image.width, height: image.height)
                append(ScanPage(id: placeholder, original: image, quad: detected.quad ?? .whole(size), enhancement: pageEnhancement()))
            }
        }
    }

    private func pageEnhancement() -> Enhancement {
        var enhancement = defaultEnhancement
        enhancement.flattenCurvature = mode == .book
        return enhancement
    }

    private func append(_ page: ScanPage) {
        withAnimation(Motion.flick) {
            pages.append(page)
            selectedID = page.id
        }
        assignSides()
        process(page.id)
    }

    /// Front and back in ID mode; the passport's page; left and right in a book.
    private func assignSides() {
        switch mode {
        case .idCard:
            for index in pages.indices { pages[index].side = index == 0 ? .front : (index == 1 ? .back : nil) }
        case .passport:
            for index in pages.indices { pages[index].side = index == 0 ? .front : nil }
        case .book:
            for index in pages.indices where pages[index].side == nil {
                pages[index].side = index.isMultiple(of: 2) ? .left : .right
            }
        case .document:
            for index in pages.indices { pages[index].side = nil }
        }
    }

    /// Another photo in the place of a page.
    func retake(_ id: UUID, with image: CGImage) async {
        guard let index = pages.firstIndex(where: { $0.id == id }) else { return }
        let quad = await Task.detached(priority: .userInitiated) { ScanPipeline.detectPage(in: image) }.value
        guard let current = pages.firstIndex(where: { $0.id == id }), current == index || pages.indices.contains(current) else { return }
        pages[current].original = image
        pages[current].quad = quad ?? .whole(CGSize(width: image.width, height: image.height))
        pages[current].corrected = nil
        pages[current].enhanced = nil
        pages[current].recognition = nil
        selectedID = id
        process(id)
    }

    func remove(_ id: UUID) {
        guard let index = pages.firstIndex(where: { $0.id == id }) else { return }
        withAnimation(Motion.travel) {
            pages.remove(at: index)
            if selectedID == id {
                selectedID = pages.isEmpty ? nil : pages[min(index, pages.count - 1)].id
            }
        }
        assignSides()
        refreshComposedPage()
    }

    /// Puts a page before another (or at the end when `before` is nil).
    func move(_ id: UUID, before target: UUID?) {
        guard let from = pages.firstIndex(where: { $0.id == id }) else { return }
        var to = target.flatMap { t in pages.firstIndex { $0.id == t } } ?? pages.count
        if from < to { to -= 1 }
        guard from != to else { return }
        withAnimation(Motion.travel) {
            let page = pages.remove(at: from)
            pages.insert(page, at: to)
        }
        assignSides()
        refreshComposedPage()
    }

    func move(fromOffsets source: IndexSet, toOffset destination: Int) {
        withAnimation(Motion.travel) {
            pages.move(fromOffsets: source, toOffset: destination)
        }
        assignSides()
        refreshComposedPage()
    }

    func setQuad(_ quad: Quad, for id: UUID) {
        guard let index = pages.firstIndex(where: { $0.id == id }) else { return }
        let clamped = quad.clamped(to: pages[index].originalSize)
        guard clamped != pages[index].quad else { return }
        pages[index].quad = clamped
        pages[index].corrected = nil
        pages[index].enhanced = nil
        pages[index].recognition = nil
        process(id)
    }

    func setEnhancement(_ enhancement: Enhancement, for id: UUID) {
        guard let index = pages.firstIndex(where: { $0.id == id }), pages[index].enhancement != enhancement else { return }
        pages[index].enhancement = enhancement
        pages[index].enhanced = nil
        pages[index].recognition = nil
        process(id)
    }

    /// The same enhancement for every page from now on.
    func setEnhancementForAll(_ enhancement: Enhancement) {
        defaultEnhancement = enhancement
        for page in pages { setEnhancement(enhancement, for: page.id) }
    }

    /// Runs the pipeline for a page off the main thread and keeps the
    /// result if the page has not changed since.
    private func process(_ id: UUID) {
        guard let index = pages.firstIndex(where: { $0.id == id }) else { return }
        pages[index].version += 1
        pages[index].isProcessing = true
        let version = pages[index].version
        let original = pages[index].original
        let quad = pages[index].quad
        let enhancement = pages[index].enhancement
        Task.detached(priority: .userInitiated) {
            let corrected = ScanPipeline.corrected(original, quad: quad)
            let enhanced = ScanPipeline.enhance(corrected, with: enhancement)
            await self.took(id: id, version: version, corrected: corrected, enhanced: enhanced)
        }
    }

    private func took(id: UUID, version: Int, corrected: CGImage, enhanced: EnhancedPage) {
        guard let index = pages.firstIndex(where: { $0.id == id }), pages[index].version == version else { return }
        pages[index].corrected = corrected
        pages[index].enhanced = enhanced.image
        pages[index].skew = enhanced.skew
        pages[index].bow = enhanced.bow
        pages[index].isProcessing = false
        refreshComposedPage()
    }

    var isProcessing: Bool {
        pages.contains { $0.isProcessing }
    }

    /// ID and passport modes: the composed page follows the sides.
    private func refreshComposedPage() {
        guard let kind = mode.idKind else {
            composedPage = nil
            return
        }
        let sides = pages.prefix(kind.sides).map(\.display)
        guard !sides.isEmpty else {
            composedPage = nil
            return
        }
        Task.detached(priority: .userInitiated) {
            let composed = IDPageComposer.compose(sides: sides, kind: kind)
            await MainActor.run { self.composedPage = composed }
        }
    }

    // MARK: - Reading and saving

    /// The pictures that become the PDF's pages: the composed page in ID
    /// and passport modes, else every page as enhanced.
    func outputPictures() -> [CGImage] {
        if mode.composesOnePage, let composedPage {
            return [composedPage]
        }
        return pages.map(\.display)
    }

    /// Reads every output page with Vision, straightened first when its
    /// lines still slant.
    func recognize() async -> [(recognition: Recognition, angle: Double)] {
        let languages = readingLanguages
        let pictures = outputPictures()
        var results: [(Recognition, Double)] = []
        for picture in pictures {
            let read = await Task.detached(priority: .userInitiated) { () -> (Recognition, Double) in
                var angle = ScanPipeline.skewAngle(of: picture)
                var target = picture
                if abs(angle) >= 0.4, let level = ScanPipeline.render(ScanPipeline.rotated(CIImage(cgImage: picture), counterClockwiseDegrees: -angle)) {
                    target = level
                } else {
                    angle = 0
                }
                let recognition = (try? TextRecognizer.recognize(target, languages: languages)) ?? .empty
                return (recognition, angle)
            }.value
            results.append(read)
        }
        if !mode.composesOnePage {
            for (index, result) in results.enumerated() where index < pages.count {
                pages[index].recognition = result.0
                pages[index].recognitionAngle = result.1
            }
        }
        recognizedText = results.map(\.0.text).filter { !$0.isEmpty }.joined(separator: "\n\n")
        return results.map { (recognition: $0.0, angle: $0.1) }
    }

    /// Writes the pages as a PDF into the Documents folder, with the text
    /// layer when OCR is on, and answers where it went.
    func savePDF(named name: String, locale: Locale = .current) async throws -> URL {
        guard !pages.isEmpty else { throw ScanError.noPages }
        isBusy = true
        busyMessage = ocrEnabled ? "Reading the text…" : "Making the PDF…"
        defer {
            isBusy = false
            busyMessage = nil
        }
        // Let the pipeline finish on every page first.
        while isProcessing {
            try await Task.sleep(for: .milliseconds(60))
        }
        let pictures = outputPictures()
        let recognitions = ocrEnabled ? await recognize() : []
        busyMessage = "Making the PDF…"
        let title = name.isEmpty ? Self.defaultName(locale: locale) : name
        let made = try await ScanExporter.makePDF(pictures: pictures,
                                                   recognitions: recognitions.map { $0.recognition },
                                                   angles: recognitions.map { $0.angle }, title: title)
        try FileManager.default.createDirectory(at: documentsFolder, withIntermediateDirectories: true)
        let url = ScanExporter.freeURL(for: "\(Self.safeFileName(title)).pdf", in: documentsFolder)
        try made.bytes.write(to: url, options: .atomic)
        savedURL = url
        return url
    }

    /// Writes the recognised text as a note beside the PDF.
    func saveText(named name: String) throws -> URL {
        guard let recognizedText, !recognizedText.isEmpty else { throw ScanError.noText }
        try FileManager.default.createDirectory(at: documentsFolder, withIntermediateDirectories: true)
        let url = ScanExporter.freeURL(for: "\(Self.safeFileName(name)).txt", in: documentsFolder)
        try recognizedText.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    /// "Scan 2026-09-21 14.32" — a file name, so a String rather than a
    /// `Text`: looked up for the interface's locale, which follows the
    /// language chosen in Settings at once.
    nonisolated static func defaultName(now: Date = .now, locale: Locale = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH.mm"
        return String(localized: "Scan", locale: locale) + " " + formatter.string(from: now)
    }

    /// A name a file system takes: no slashes or colons, nothing hidden, not empty.
    nonisolated static func safeFileName(_ name: String) -> String {
        var cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        while cleaned.hasPrefix(".") { cleaned.removeFirst() }
        if cleaned.isEmpty { cleaned = defaultName() }
        return String(cleaned.prefix(120))
    }
}

enum ScanError: Error {
    case noPages
    case noText
    case noFont
    case core(String)

    /// What the interface shows: the app's own message (a key of the
    /// String Catalog), or the core's.
    var message: LocalizedStringKey {
        switch self {
        case .noPages: "There are no pages to save yet."
        case .noText: "No text was read."
        case .noFont: "The text layer's font is missing from the app."
        case let .core(message): LocalizedStringKey(message)
        }
    }
}

/// The PDF, through the core: `create.images` for the pages, then
/// `ocr.add_text_layer` for the words Vision read — the same invisible,
/// shaped, searchable layer every other host of the core writes.
enum ScanExporter {
    /// A4, the paper every scan lands on, in points.
    static let paper = CGSize(width: 595.276, height: 841.89)

    /// How a picture sits on its page, as the core places it: the paper
    /// turned to the picture's way, the picture fitted and centred.
    struct Placement: Equatable, Sendable {
        let paper: CGSize
        let scale: CGFloat
        let offset: CGPoint

        /// A pixel box on the picture as points on the page, `[x0, top, x1, bottom]`.
        func points(_ box: CGRect) -> [Float] {
            [Float(offset.x + box.minX * scale), Float(offset.y + box.minY * scale),
             Float(offset.x + box.maxX * scale), Float(offset.y + box.maxY * scale)]
        }
    }

    static func placement(of pixels: CGSize, on paper: CGSize = paper) -> Placement {
        let short = min(paper.width, paper.height), long = max(paper.width, paper.height)
        let landscape = pixels.width > pixels.height
        let page = landscape ? CGSize(width: long, height: short) : CGSize(width: short, height: long)
        let scale = min(page.width / pixels.width, page.height / pixels.height)
        let drawn = CGSize(width: pixels.width * scale, height: pixels.height * scale)
        return Placement(paper: page, scale: scale,
                         offset: CGPoint(x: (page.width - drawn.width) / 2, y: (page.height - drawn.height) / 2))
    }

    /// Now as a PDF date, `D:YYYYMMDDHHmmSSZ`, in UTC: the core has no clock.
    static func pdfDate(_ date: Date = .now) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "'D:'yyyyMMddHHmmss'Z'"
        return formatter.string(from: date)
    }

    /// The face the layer is written in: Amiri (OFL), bundled with the app.
    static func fontData() throws -> Data {
        guard let url = Bundle.main.url(forResource: "Amiri-Regular", withExtension: "ttf") else {
            throw ScanError.noFont
        }
        return try Data(contentsOf: url)
    }

    struct Made: Sendable {
        let bytes: Data
        let pages: Int
        let words: Int
    }

    private struct PaperArgs: Encodable {
        let width: Float
        let height: Float
    }

    private struct CreateArgs: Encodable {
        let paper: PaperArgs
        let orientation: String
        let margin: Float
        let title: String
        let created: String
    }

    private struct LayerWord: Encodable {
        let text: String
        let bbox: [Float]
    }

    private struct LayerPage: Encodable {
        let index: Int
        let words: [LayerWord]
        let angle: Float
    }

    private struct LayerArgs: Encodable {
        let pages: [LayerPage]
        let modified: String
    }

    /// A PDF of the pictures, one to a page, with a text layer of the
    /// recognitions (one per picture, `nil` or empty for a page with no
    /// text) written at each page's angle.
    static func makePDF(pictures: [CGImage], recognitions: [Recognition?], angles: [Double], title: String, now: Date = .now) async throws -> Made {
        guard !pictures.isEmpty else { throw ScanError.noPages }
        var jpegs: [Data] = []
        for picture in pictures {
            guard let jpeg = ScanPipeline.jpegData(picture) else { throw ScanError.core("E_IMAGE: a page could not be encoded") }
            jpegs.append(jpeg)
        }
        let createArgs = CreateArgs(paper: PaperArgs(width: Float(paper.width), height: Float(paper.height)),
                                    orientation: "auto", margin: 0, title: title, created: pdfDate(now))
        let created = try await Core.callStatic(op: "create.images", args: createArgs, blobs: jpegs)
        guard var bytes = created.blobs.first, !bytes.isEmpty else { throw ScanError.core("create.images answered no file") }
        let pageCount = created.object["pages"] as? Int ?? pictures.count

        var layerPages: [LayerPage] = []
        for (index, picture) in pictures.enumerated() where index < recognitions.count {
            guard let recognition = recognitions[index], !recognition.words.isEmpty else { continue }
            let placement = placement(of: CGSize(width: picture.width, height: picture.height))
            let words = recognition.words.map { LayerWord(text: $0.text, bbox: placement.points($0.box)) }
            layerPages.append(LayerPage(index: index, words: words, angle: Float(index < angles.count ? angles[index] : 0)))
        }
        var words = 0
        if !layerPages.isEmpty {
            let font = try fontData()
            let layered = try await Core.callStatic(op: "ocr.add_text_layer",
                                                    args: LayerArgs(pages: layerPages, modified: pdfDate(now)),
                                                    blobs: [bytes, font])
            words = layered.object["words"] as? Int ?? 0
            if let layeredBytes = layered.blobs.first, !layeredBytes.isEmpty, (layered.object["pages"] as? Int ?? 0) > 0 {
                bytes = layeredBytes
            }
        }
        return Made(bytes: bytes, pages: pageCount, words: words)
    }

    /// "Name.pdf", then "Name 2.pdf", "Name 3.pdf"…
    static func freeURL(for fileName: String, in folder: URL) -> URL {
        let base = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension
        var candidate = folder.appending(path: fileName)
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appending(path: "\(base) \(n).\(ext)")
            n += 1
        }
        return candidate
    }
}
