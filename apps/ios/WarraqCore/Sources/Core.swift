import Foundation
internal import WarraqCoreFFI

/// The Rust core, one open document per instance: what Apple's frameworks
/// do not do — Arabic read in logical order from any PDF, the tool
/// operations (`pages.*`, `view.*`, `export.*`, …) and the incremental save
/// that leaves the original bytes untouched.
///
/// An actor, because the C handle is used from one thread at a time; every
/// method is `async` from the outside and runs off the main thread. Open
/// with `Core.open(bytes:password:)`; the handle closes itself when the
/// actor goes away, or earlier with `close()`.
///
/// Operations that need no open document — combining files, the Library's
/// index, OCR's text layer, exports of raw bytes — are `Core.callStatic`.
public actor Core {
    // Every use is actor-isolated; the marking only lets `deinit`, which
    // runs when nothing else can reach the actor, close the handle.
    nonisolated(unsafe) private var handle: OpaquePointer?

    /// The core's version ("0.1.0").
    public static var version: String {
        String(cString: warraq_version())
    }

    private init(handle: OpaquePointer) {
        self.handle = handle
    }

    deinit {
        if let handle {
            warraq_close(handle)
        }
    }

    // MARK: - Opening and closing

    /// Opens a PDF from its bytes. Throws `CoreError.password` for an
    /// encrypted file whose password is missing or wrong, `.parse` for what
    /// is not a PDF.
    public static func open(bytes: Data, password: String? = nil) async throws -> Core {
        try await Task.detached(priority: .userInitiated) {
            var handle: OpaquePointer?
            let reply = bytes.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> WarraqReply in
                let base = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self)
                return withOptionalCString(password) { cPassword in
                    warraq_open(base, buffer.count, cPassword, &handle)
                }
            }
            _ = try take(reply)
            guard let handle else { throw CoreError.other(code: "E_OTHER", message: "no handle") }
            return Core(handle: handle)
        }.value
    }

    /// Closes the document now. Every later call throws `.closed`.
    public func close() {
        if let handle {
            warraq_close(handle)
        }
        handle = nil
    }

    public var isOpen: Bool { handle != nil }

    // MARK: - Reading

    /// The number of pages.
    public var pageCount: Int {
        guard let handle else { return 0 }
        return warraq_page_count(handle)
    }

    /// The page's size in points, after its own rotation.
    public func pageSize(_ index: Int) throws -> PageSize {
        try reply { warraq_page_size($0, index) }.decode()
    }

    /// The page drawn by the core at `scale` (1 = 72 dpi); RGBA8 premultiplied
    /// over white. PDFKit draws the pages on screen; this is for what
    /// PDFKit does not draw — comparisons, exports and thumbnails of files
    /// PDFKit refuses.
    public func renderPage(_ index: Int, scale: Float) throws -> RenderedPage {
        let reply = try reply { warraq_render_page($0, index, scale) }
        struct Size: Decodable { let width: Int; let height: Int }
        let size: Size = try reply.decode()
        guard let rgba = reply.blobs.first, rgba.count == size.width * size.height * 4 else {
            throw CoreError.badReply("render_page answered \(reply.blobs.first?.count ?? 0) bytes for \(size.width)x\(size.height)")
        }
        return RenderedPage(width: size.width, height: size.height, rgba: rgba)
    }

    /// The page's text in logical order — Arabic read as it is read —
    /// lines joined by newlines.
    public func extractText(page index: Int) throws -> String {
        struct Text: Decodable { let text: String }
        let text: Text = try reply { warraq_extract_text($0, index) }.decode()
        return text.text
    }

    /// The page's lines with their boxes, for selection and highlights.
    public func textLines(page index: Int) throws -> [TextLine] {
        struct Lines: Decodable { let lines: [TextLine] }
        let lines: Lines = try reply { warraq_text_lines($0, index) }.decode()
        return lines.lines
    }

    /// The pages holding `query`, matched the Arabic-aware way: diacritics
    /// ignored, alef, taa marbuta and yaa forms unified, digits in either
    /// script.
    public func search(_ query: String) throws -> [Int] {
        struct Pages: Decodable { let pages: [Int] }
        let pages: Pages = try reply { handle in
            query.withCString { warraq_search(handle, $0) }
        }.decode()
        return pages.pages
    }

    /// The document's own information.
    public func metadata() throws -> Metadata {
        try reply { warraq_metadata($0) }.decode()
    }

    /// The page's paragraphs in device space.
    public func paragraphs(page index: Int) throws -> [Paragraph] {
        struct Paragraphs: Decodable { let paragraphs: [Paragraph] }
        let found: Paragraphs = try reply { warraq_paragraphs($0, index) }.decode()
        return found.paragraphs
    }

    // MARK: - Editing

    /// Draws a line of text at a point on the page (points from the top-left
    /// corner; `x` is where the line starts, so Arabic grows leftwards from
    /// it) in `font`, a TrueType or OpenType file the core subsets and embeds.
    ///
    /// `color` is "#rrggbb"; nil draws in the colour the page's own content
    /// leaves behind, which is black on nearly every page.
    public func addText(page index: Int, x: Float, y: Float, size: Float, text: String, font: Data, color: String? = nil) throws {
        _ = try reply { handle in
            text.withCString { cText in
                withOptionalCString(color) { cColor in
                    font.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
                        warraq_add_text_colored(handle, index, x, y, size, cText, cColor,
                                                buffer.baseAddress?.assumingMemoryBound(to: UInt8.self), buffer.count)
                    }
                }
            }
        }
    }

    /// Replaces a paragraph with reflowed, shaped text in `font`.
    public func replaceParagraph(page index: Int, paragraph: Int, text: String, font: Data) throws -> ParagraphReplacement {
        try reply { handle in
            text.withCString { cText in
                font.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
                    warraq_replace_paragraph(handle, index, paragraph, cText,
                                             buffer.baseAddress?.assumingMemoryBound(to: UInt8.self), buffer.count)
                }
            }
        }.decode()
    }

    /// One entry point for the tool operations (`packages/core/API.md`):
    /// `op` names one ("pages.rotate"), `args` is JSON, `blobs` carries
    /// bytes. What it answers is the operation's JSON and bytes.
    public func call(op: String, args: String = "", blobs: [Data] = []) throws -> Reply {
        try reply { handle in
            withBlobs(blobs) { blobPointer, count in
                op.withCString { cOp in
                    args.withCString { cArgs in
                        warraq_call(handle, cOp, cArgs, blobPointer, count)
                    }
                }
            }
        }
    }

    /// `call` with arguments encoded from a value.
    public func call<A: Encodable>(op: String, args: A, blobs: [Data] = []) throws -> Reply {
        let json = String(decoding: try JSONEncoder().encode(args), as: UTF8.self)
        return try call(op: op, args: json, blobs: blobs)
    }

    /// The document's bytes as edited: an incremental update appended to the
    /// original wherever that is possible, so the original bytes stay as
    /// they were and nothing is written until the person saves.
    public func save() throws -> Data {
        let reply = try reply { warraq_save($0) }
        guard let bytes = reply.blobs.first else {
            throw CoreError.badReply("save answered no bytes")
        }
        return bytes
    }

    // MARK: - Static operations

    /// A tool operation that needs no open document: combining files
    /// (`pages.combine`), the Library (`library.*`), OCR's text layer
    /// (`ocr.add_text_layer`), the standards, signatures, …
    public static func callStatic(op: String, args: String = "", blobs: [Data] = []) async throws -> Reply {
        try await Task.detached(priority: .userInitiated) {
            let reply = withBlobs(blobs) { blobPointer, count in
                op.withCString { cOp in
                    args.withCString { cArgs in
                        warraq_call_static(cOp, cArgs, blobPointer, count)
                    }
                }
            }
            return try take(reply)
        }.value
    }

    /// `callStatic` with arguments encoded from a value.
    public static func callStatic<A: Encodable>(op: String, args: A, blobs: [Data] = []) async throws -> Reply {
        let json = String(decoding: try JSONEncoder().encode(args), as: UTF8.self)
        return try await callStatic(op: op, args: json, blobs: blobs)
    }

    // MARK: - Plumbing

    /// Runs a C call on the open handle and takes its reply. A panic inside
    /// the core closes the handle: it may be half-changed.
    private func reply(_ body: (OpaquePointer) -> WarraqReply) throws -> Reply {
        guard let handle else { throw CoreError.closed }
        do {
            return try Core.take(body(handle))
        } catch let error as CoreError {
            if case .panic = error {
                close()
            }
            throw error
        }
    }

    /// Copies a reply's JSON and bytes out and frees it, or throws its error.
    private static func take(_ reply: WarraqReply) throws -> Reply {
        defer { warraq_free(reply) }
        let json = reply.json.map { String(cString: $0) } ?? "{}"
        guard reply.code == WARRAQ_OK else {
            struct Failure: Decodable { let code: String; let message: String }
            let failure = try? JSONDecoder().decode(Failure.self, from: Data(json.utf8))
            throw CoreError(code: reply.code,
                            codeName: failure?.code ?? "E_OTHER",
                            message: failure?.message ?? json)
        }
        var blobs: [Data] = []
        if let buffers = reply.blobs {
            blobs.reserveCapacity(reply.blob_count)
            for i in 0..<reply.blob_count {
                let buffer = buffers[i]
                if let ptr = buffer.ptr, buffer.len > 0 {
                    blobs.append(Data(bytes: ptr, count: buffer.len))
                } else {
                    blobs.append(Data())
                }
            }
        }
        return Reply(json: json, blobs: blobs)
    }
}

/// Lends `blobs` to a C call as an array of (pointer, length) pairs, valid
/// for the duration of `body`.
private func withBlobs<R>(_ blobs: [Data], _ body: (UnsafePointer<WarraqBlob>?, Int) -> R) -> R {
    if blobs.isEmpty {
        return body(nil, 0)
    }
    // Every Data must stay pinned while the pointers are in use: pin them
    // all, innermost last, then call.
    func pin(_ index: Int, _ pinned: inout [WarraqBlob]) -> R {
        if index == blobs.count {
            return pinned.withUnsafeBufferPointer { body($0.baseAddress, $0.count) }
        }
        return blobs[index].withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> R in
            pinned.append(WarraqBlob(ptr: buffer.baseAddress?.assumingMemoryBound(to: UInt8.self), len: buffer.count))
            return pin(index + 1, &pinned)
        }
    }
    var pinned: [WarraqBlob] = []
    pinned.reserveCapacity(blobs.count)
    return pin(0, &pinned)
}

private func withOptionalCString<R>(_ string: String?, _ body: (UnsafePointer<CChar>?) -> R) -> R {
    guard let string else { return body(nil) }
    return string.withCString { body($0) }
}
