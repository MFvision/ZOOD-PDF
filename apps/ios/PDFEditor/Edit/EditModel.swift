import Foundation
import Observation
import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import WarraqCore

/// Edit PDF on the page itself: the text that is already there, a new line
/// where the finger lands, the pictures and the links. Every change is one
/// call to the core on the open document — the text edits through its own
/// readers (`paragraphs`, `replaceParagraph`, `addText`), the pictures and
/// links through `images.*` and `links.*` — so the original bytes wait
/// under an incremental update until Save, and each change is a step of
/// undo like every other tool's.
///
/// What is on a page is read once per page per revision and kept here: the
/// overlays draw from these lists, and a change that reflows a paragraph or
/// moves a picture makes the page's lists stale, so they are dropped and
/// read again.
@MainActor @Observable
final class EditModel {
    /// Which of the page's things the editor is working on. Text is where it
    /// opens: it is what the owner asked for first.
    enum Mode: String, CaseIterable, Identifiable {
        case text
        case pictures
        case links

        var id: String { rawValue }

        var title: LocalizedStringKey {
            switch self {
            case .text: "Text"
            case .pictures: "Pictures"
            case .links: "Links"
            }
        }

        var symbol: String {
            switch self {
            case .text: "textformat"
            case .pictures: "photo"
            case .links: "link"
            }
        }
    }

    /// The paragraph a tap opened, and the text as it was, so Cancel and the
    /// round-trip check have something to compare against.
    struct Editing: Equatable {
        let page: Int
        let paragraph: Paragraph
    }

    /// Where a new line of text will go, in the page's stored space.
    struct Placing: Equatable {
        let page: Int
        let point: CGPoint
    }

    let model: DocumentModel
    weak var undoManager: UndoManager?
    var mode: Mode = .text {
        didSet {
            guard mode != oldValue else { return }
            editing = nil
            placing = nil
            selectedPicture = nil
            selectedLink = nil
            cropping = false
        }
    }

    /// True while a call to the core is out: the overlays stop taking
    /// gestures, so two edits cannot race on one document.
    private(set) var working = false
    /// Shown once, then cleared: one of the app's own messages or the core's.
    var error: LocalizedStringKey?
    /// What the core said about the last replacement, when it is worth
    /// saying (the text did not fit, or it was shrunk to make it fit).
    var notice: LocalizedStringKey?
    /// Counts the edits made here, for the haptic and for the tests.
    private(set) var edits = 0

    var editing: Editing?
    var placing: Placing?
    /// "Add a line" is in hand: the next tap on a page is where it goes.
    var placingArmed = false
    /// What is in the field on the page, whichever of the two it is showing.
    var draft = ""
    var selectedPicture: PictureRef?
    var selectedLink: LinkRef?
    /// The picked picture is being cropped rather than resized.
    var cropping = false
    /// A picture chosen and waiting to be dragged out on a page.
    var pendingPicture: PendingPicture?
    /// The next picture chosen goes in the place of the picked one rather
    /// than onto the page as a new one.
    var replacingPicture = false
    /// A link area drawn and not yet given anywhere to go.
    var draftLink: DraftLink?

    // The controls for a new line of text.
    var font: EditFace = .amiri
    var size: Float = 14
    var color: MarkupColor = .black

    /// Each page's paragraphs, pictures and links, and the revision they
    /// were read at.
    private var paragraphs: [Int: [Paragraph]] = [:]
    private var pictures: [Int: [PagePicture]] = [:]
    private var links: [Int: [PageLink]] = [:]
    private var readAt: [Int: Int] = [:]
    private var reading: Set<Int> = []

    init(model: DocumentModel) {
        self.model = model
    }

    // MARK: - What is on a page

    /// The page's paragraphs, or nil while they are still being read.
    func paragraphs(onPage index: Int) -> [Paragraph]? {
        fresh(index) ? paragraphs[index] : nil
    }

    func pictures(onPage index: Int) -> [PagePicture]? {
        fresh(index) ? pictures[index] : nil
    }

    func links(onPage index: Int) -> [PageLink]? {
        fresh(index) ? links[index] : nil
    }

    /// Whether what is held for a page describes the page as it now stands.
    private func fresh(_ index: Int) -> Bool {
        readAt[index] == model.revision
    }

    /// Reads a page's paragraphs, pictures and links, unless they are
    /// already the current ones or a read is already out for that page.
    func read(page index: Int) async {
        guard index >= 0, index < model.pageCount, !fresh(index), !reading.contains(index) else { return }
        reading.insert(index)
        defer { reading.remove(index) }
        let revision = model.revision
        guard let core = await model.readyEngine() else { return }
        // A page the core cannot segment, or whose pictures it cannot walk,
        // simply has nothing of that kind to edit: an empty list, not an
        // error the person can do nothing about.
        let found = try? await core.paragraphs(page: index)
        let pictures = (try? await Self.pictures(onPage: index, from: core)) ?? []
        let links = (try? await Self.links(onPage: index, from: core)) ?? []
        // The document may have changed while the three calls were out.
        guard revision == model.revision else { return }
        paragraphs[index] = found ?? []
        self.pictures[index] = pictures
        self.links[index] = links
        readAt[index] = revision
    }

    private static func pictures(onPage index: Int, from core: Core) async throws -> [PagePicture] {
        struct Args: Encodable { let page: Int }
        struct Answer: Decodable { let images: [PagePicture] }
        let reply = try await core.call(op: "images.list", args: Args(page: index))
        return try reply.decode(Answer.self).images
    }

    private static func links(onPage index: Int, from core: Core) async throws -> [PageLink] {
        struct Args: Encodable { let page: Int }
        struct Answer: Decodable { let links: [PageLink] }
        let reply = try await core.call(op: "links.list", args: Args(page: index))
        return try reply.decode(Answer.self).links
    }

    // MARK: - Text

    /// Opens the paragraph a tap landed in, if any. The boxes are in the
    /// page's stored space, which is what `point` is in too.
    func paragraph(at point: CGPoint, onPage index: Int) -> Paragraph? {
        guard let found = paragraphs(onPage: index) else { return nil }
        // The smallest box that holds the point: paragraphs can nest when a
        // page puts one inside another's bounds (a pull quote in a column).
        return found
            .filter { $0.storedRect.contains(point) }
            .min { $0.storedRect.area < $1.storedRect.area }
    }

    /// Opens a paragraph for editing: the field on the page starts from the
    /// text the core read, tashkeel and all.
    func begin(editing paragraph: Paragraph, onPage index: Int) {
        placing = nil
        placingArmed = false
        draft = paragraph.text
        editing = Editing(page: index, paragraph: paragraph)
    }

    /// Opens the field for a new line at a point on the page.
    func beginLine(at point: CGPoint, onPage index: Int) {
        editing = nil
        draft = ""
        placing = Placing(page: index, point: point)
    }

    /// Closes the field without writing anything.
    func cancel() {
        editing = nil
        placing = nil
        draft = ""
    }

    /// Which way the line being typed runs, so the field and the core agree
    /// about where it grows from the point that was tapped. An empty draft
    /// follows the document, which is what a person about to type Arabic in
    /// an Arabic document expects.
    var draftIsRightToLeft: Bool {
        if let editing { return editing.paragraph.isRightToLeft }
        if let first = draft.unicodeScalars.first(where: { $0.properties.isAlphabetic }) {
            return Self.isRightToLeftScalar(first)
        }
        return model.isRightToLeft
    }

    /// Arabic, Hebrew, Syriac, Thaana and the Arabic supplements: the ranges
    /// Unicode gives a right-to-left letter.
    static func isRightToLeftScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0590...0x08FF, 0xFB1D...0xFDFF, 0xFE70...0xFEFF, 0x10800...0x10FFF, 0x1E800...0x1EFFF:
            true
        default:
            false
        }
    }

    /// Replaces the open paragraph with `text`, reflowed and shaped by the
    /// core in the chosen face. Nothing is written when the text is the same.
    func commit() async {
        guard let editing, !working else { return }
        let text = draft
        guard text != editing.paragraph.text else {
            cancel()
            return
        }
        guard let face = font.bytes else {
            error = "The bundled font is missing."
            return
        }
        working = true
        let page = editing.page
        let index = editing.paragraph.index
        do {
            let result = try await model.applyEdit(undoManager: undoManager) { core in
                try await core.replaceParagraph(page: page, paragraph: index, text: text, font: face)
            }
            notice = Self.notice(for: result)
            cancel()
            edits += 1
        } catch {
            self.error = PagesModel.describe(error)
        }
        working = false
    }

    /// What is worth telling the person about a replacement: nothing when it
    /// simply fitted.
    static func notice(for result: ParagraphReplacement) -> LocalizedStringKey? {
        if result.overflowed { return "The new text is longer than the space it had; the rest is past the page." }
        if result.shrunk { return "The new text was made smaller to fit the space it had." }
        return nil
    }

    /// Draws a line of text where the finger landed, in the chosen face,
    /// size and colour. The point is where the line starts, so an Arabic
    /// line grows leftwards from it, as the core does with the same point.
    func addLine() async {
        guard let placing, !working else { return }
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            cancel()
            return
        }
        guard let face = font.bytes else {
            error = "The bundled font is missing."
            return
        }
        working = true
        let page = placing.page
        let point = placing.point
        let size = size
        let hex = color.hex
        do {
            try await model.applyEdit(undoManager: undoManager) { core in
                try await core.addText(page: page, x: Float(point.x), y: Float(point.y),
                                       size: size, text: trimmed, font: face, color: hex)
            }
            cancel()
            placingArmed = false
            edits += 1
        } catch {
            self.error = PagesModel.describe(error)
        }
        working = false
    }

    /// The text of a paragraph as the core reads it back from the saved
    /// bytes, for the round-trip the tests make and for nothing else.
    func text(ofParagraph index: Int, onPage page: Int) async -> String? {
        guard let core = await model.readyEngine() else { return nil }
        return try? await core.paragraphs(page: page).first { $0.index == index }?.text
    }

    // MARK: - Pictures

    /// Puts a PNG or JPEG on the page, upright in `shown` (the page's shown
    /// space, as `PageSpace` measures it).
    func addPicture(_ bytes: Data, in shown: CGRect, onPage index: Int) async {
        guard !working else { return }
        struct Args: Encodable { let page: Int; let matrix: [Float] }
        await change(op: "images.add", args: Args(page: index, matrix: PageSpace.uprightMatrix(in: shown)), blobs: [bytes])
    }

    /// Takes a picture the person chose: PNG and JPEG go to the core as they
    /// are, anything else it does not read is turned into a PNG first, so a
    /// HEIC photo from the camera can be placed like any other. It goes in
    /// the place of the picked picture when Replace asked for it, and
    /// otherwise waits to be dragged out on the page.
    func choose(picture bytes: Data, forPage index: Int? = nil) async {
        guard let picture = PendingPicture.of(bytes, page: index) else {
            error = "That picture could not be read."
            replacingPicture = false
            return
        }
        if replacingPicture, let picked, let page = selectedPicture?.page {
            replacingPicture = false
            await replace(picked, onPage: page, with: picture.bytes)
            return
        }
        mode = .pictures
        pendingPicture = picture
    }

    /// The picked picture, if its page's list still has it.
    var picked: PagePicture? {
        guard let reference = selectedPicture else { return nil }
        return pictures(onPage: reference.page)?.first { $0.id == reference.id }
    }

    /// The picked link, if its page's list still has it.
    var pickedLink: PageLink? {
        guard let reference = selectedLink else { return nil }
        return links(onPage: reference.page)?.first { $0.id == reference.id }
    }

    /// What the layers over the pages must be redrawn for: the mode, what is
    /// picked, the field, and the revision each page's lists were read at.
    var signature: String {
        let pages = readAt.keys.sorted().map { "\($0):\(readAt[$0] ?? -1)" }.joined(separator: ",")
        return [
            mode.rawValue,
            selectedPicture.map { "\($0.page).\($0.id)" } ?? "",
            selectedLink.map { "\($0.page).\($0.id)" } ?? "",
            editing.map { "e\($0.page).\($0.paragraph.index)" } ?? "",
            placing.map { "p\($0.page).\(Int($0.point.x)).\(Int($0.point.y))" } ?? "",
            cropping ? "crop" : "",
            placingArmed ? "arm" : "",
            pendingPicture != nil ? "pending" : "",
            "\(model.revision)",
            pages,
        ].joined(separator: "|")
    }

    /// Writes the chosen picture where it was dragged out, then lets go of it.
    func placePending(in shown: CGRect, onPage index: Int) async {
        guard let pending = pendingPicture else { return }
        await addPicture(pending.bytes, in: shown, onPage: index)
        pendingPicture = nil
    }

    /// Turns the picked picture a quarter clockwise, about the middle of
    /// what shows of it.
    func turn(_ picture: PagePicture, onPage index: Int) async {
        await transform(picture, onPage: index,
                        matrix: EditGeometry.quarterTurn(picture.matrix, clip: picture.clip))
    }

    /// Moves, resizes or turns the picked picture: `matrix` takes the unit
    /// square onto the page as shown. `clip` is the part of it that shows.
    func transform(_ picture: PagePicture, onPage index: Int, matrix: [Float], clip: [Float]? = nil) async {
        struct Args: Encodable { let page: Int; let id: String; let matrix: [Float]; let clip: [Float]? }
        await change(op: "images.transform", args: Args(page: index, id: picture.id, matrix: matrix, clip: clip))
    }

    /// Puts other bytes in the place of a picture, fitted inside what showed.
    func replace(_ picture: PagePicture, onPage index: Int, with bytes: Data) async {
        struct Args: Encodable { let page: Int; let id: String }
        await change(op: "images.replace", args: Args(page: index, id: picture.id), blobs: [bytes])
        selectedPicture = nil
    }

    func delete(_ picture: PagePicture, onPage index: Int) async {
        struct Args: Encodable { let page: Int; let id: String }
        await change(op: "images.delete", args: Args(page: index, id: picture.id))
        selectedPicture = nil
    }

    // MARK: - Links

    /// Adds a link over `rect` (the page's shown space) going to an address
    /// or to a page. The core refuses anything but http, https and mailto,
    /// and anything that hides itself.
    func addLink(rect: CGRect, to destination: LinkTo, onPage index: Int) async {
        struct Args: Encodable { let page: Int; let rect: [Float]; let to: LinkTo }
        await change(op: "links.add", args: Args(page: index, rect: rect.asCoreRect, to: destination))
    }

    func update(_ link: PageLink, onPage index: Int, rect: CGRect? = nil, to destination: LinkTo? = nil) async {
        struct Args: Encodable { let page: Int; let id: String; let rect: [Float]?; let to: LinkTo? }
        await change(op: "links.update", args: Args(page: index, id: link.id, rect: rect?.asCoreRect, to: destination))
    }

    func remove(_ link: PageLink, onPage index: Int) async {
        struct Args: Encodable { let page: Int; let id: String }
        await change(op: "links.remove", args: Args(page: index, id: link.id))
        selectedLink = nil
    }

    // MARK: - Plumbing

    /// One tool operation on the open document, with the busy flag, the
    /// error and the step of undo every change here shares.
    private func change<A: Encodable>(op: String, args: A, blobs: [Data] = []) async {
        guard !working else { return }
        working = true
        do {
            try await model.apply(op, args: args, blobs: blobs, undoManager: undoManager)
            edits += 1
        } catch {
            self.error = PagesModel.describe(error)
        }
        working = false
    }

    func clearError() {
        error = nil
    }

    func clearNotice() {
        notice = nil
    }
}

/// A picture on a page, as `images.list` answers: `matrix` takes the unit
/// square onto the page as shown (points, y down), `clip` is the part of it
/// that shows, and `shared` marks one the core will not edit because the
/// bytes that draw it draw it elsewhere too.
struct PagePicture: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let matrix: [Float]
    let clip: [Float]
    let pixels: [Int]
    let inline: Bool
    let inForm: Bool
    let shared: Bool

    /// Whether the core will take a change to it.
    var isEditable: Bool { !shared }

    /// The picture's own proportions, from its pixels.
    var aspect: CGFloat {
        guard pixels.count == 2, pixels[1] > 0 else { return 1 }
        return CGFloat(pixels[0]) / CGFloat(pixels[1])
    }
}

/// A link on a page, as `links.list` answers: `rect` is `[x, y, width,
/// height]` in the page's shown space.
struct PageLink: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let rect: [Float]
    let to: LinkTo

    var shownRect: CGRect {
        guard rect.count == 4 else { return .zero }
        return CGRect(x: CGFloat(rect[0]), y: CGFloat(rect[1]), width: CGFloat(rect[2]), height: CGFloat(rect[3]))
    }
}

/// Where a link goes: an address, or a page (zero-based). Neither, for a
/// link the file gives nowhere to go.
struct LinkTo: Codable, Equatable, Sendable {
    var uri: String?
    var page: Int?

    /// Whether there is anywhere to go at all.
    var isSomewhere: Bool { uri != nil || page != nil }
}

/// The faces a new line or a replaced paragraph can be drawn in — the same
/// three the desktop offers, each bundled with the app under SIL OFL 1.1
/// and proven by the core to survive shaping, subsetting and embedding.
enum EditFace: String, CaseIterable, Identifiable {
    case amiri
    case cairo
    case inter

    var id: String { rawValue }

    /// A font's name is not translated.
    var name: String {
        switch self {
        case .amiri: "Amiri"
        case .cairo: "Cairo"
        case .inter: "Inter"
        }
    }

    /// The file the face ships as, in the app's bundle.
    var resource: String {
        switch self {
        case .amiri: "Amiri-Regular"
        case .cairo: "Cairo-Variable"
        case .inter: "Inter-Variable"
        }
    }

    /// The face's bytes from the app's bundle, read once.
    var bytes: Data? {
        EditFaceStore.bytes(of: self)
    }
}

/// The bundled faces, each read once and kept: a face is a megabyte or so,
/// and an edit asks for the same one again and again.
private enum EditFaceStore {
    nonisolated(unsafe) private static var cache: [EditFace: Data] = [:]
    private static let lock = NSLock()

    static func bytes(of face: EditFace) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        if let held = cache[face] { return held }
        guard let url = Bundle.main.url(forResource: face.resource, withExtension: "ttf"),
              let data = try? Data(contentsOf: url) else { return nil }
        cache[face] = data
        return data
    }
}

extension Paragraph {
    /// The paragraph's box in the page's stored space, which is where the
    /// core answers it and where a tap is converted to.
    var storedRect: CGRect {
        CGRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: CGFloat(height))
    }

    var isRightToLeft: Bool { direction == "rtl" }
}

extension CGRect {
    /// `[x, y, width, height]`, as the core takes a link's rectangle.
    var asCoreRect: [Float] {
        [Float(minX), Float(minY), Float(width), Float(height)]
    }

    var area: CGFloat { width * height }
}
