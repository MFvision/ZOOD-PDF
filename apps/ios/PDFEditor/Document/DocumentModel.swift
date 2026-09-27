import Foundation
import Observation
import PDFKit
import WarraqCore

/// One open document: the bytes as read from disk, the bytes as edited by
/// the core (an incremental update on top of the original — nothing on disk
/// changes until `save()`), PDFKit's document for drawing them, and the
/// core's view of them for what PDFKit cannot read: Arabic in logical
/// order, the tool operations, search.
///
/// Every tool in the app edits through `apply(_:args:blobs:undoManager:)`:
/// the core makes the change, the model takes the new bytes and reloads
/// PDFKit, and the undo manager gets a step back to the bytes before.
@MainActor @Observable
final class DocumentModel: Identifiable, Hashable {
    enum State: Equatable {
        case loading
        /// Encrypted: ask for the password (`wrong` after a wrong one).
        case needsPassword(wrong: Bool)
        case ready
        case failed(code: String, message: String)
    }

    let id = UUID()
    /// Where the file is, when the model owns the file (opened from the
    /// Library). Nil inside a `DocumentGroup` scene, which saves itself.
    let url: URL?
    let name: String
    /// The picture this document was made from, when it was opened from a
    /// photo (the scanner offers to enhance and read it).
    var sourceImage: CGImage?
    private(set) var original: Data
    private(set) var edited: Data?
    private(set) var state: State = .loading
    private(set) var pdf: PDFDocument?
    private(set) var metadata: Metadata?
    private(set) var pageCount = 0
    /// The page on screen, zero-based; the view keeps it.
    var currentPage = 0
    /// True when most of the first page reads right-to-left: the pages are
    /// then ordered right-to-left too.
    private(set) var isRightToLeft = false
    private var pageTexts: [Int: String] = [:]
    private var core: Core?
    /// The password the document opened with, for static operations that
    /// take the bytes and need it too.
    private(set) var password: String?
    private var holdsSecurityScope = false
    /// Counts the edits, so views that draw the bytes know to look again.
    private(set) var revision = 0

    /// The bytes as they stand: edited, or the original.
    var bytes: Data { edited ?? original }
    var isEdited: Bool { edited != nil }
    var isReady: Bool { state == .ready }

    /// Reads the file, keeping access to a security-scoped URL (one chosen
    /// in Files) while the model lives.
    init(url: URL) throws {
        let scoped = url.startAccessingSecurityScopedResource()
        var readError: NSError?
        var bytes = Data()
        var innerError: (any Error)?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &readError) { readURL in
            do {
                bytes = try Data(contentsOf: readURL, options: .mappedIfSafe)
            } catch {
                innerError = error
            }
        }
        if let error = readError ?? (innerError as NSError?) {
            if scoped { url.stopAccessingSecurityScopedResource() }
            throw error
        }
        self.url = url
        self.name = url.deletingPathExtension().lastPathComponent
        self.original = bytes
        self.holdsSecurityScope = scoped
    }

    /// From bytes already in hand (a `DocumentGroup` scene, a test).
    init(bytes: Data, name: String) {
        self.url = nil
        self.name = name
        self.original = bytes
    }

    // MARK: - Loading

    /// Opens the bytes in the core and in PDFKit. With an encrypted file
    /// the state becomes `.needsPassword` until the right one is given.
    func load(password: String? = nil) async {
        state = .loading
        do {
            let core = try await Core.open(bytes: bytes, password: password)
            self.core = core
            self.password = password
            metadata = try await core.metadata()
            pageCount = await core.pageCount
            pageTexts.removeAll()
            if pageCount > 0 {
                let lines = try await core.textLines(page: 0)
                let rtl = lines.count { $0.isRightToLeft }
                isRightToLeft = rtl * 2 > lines.count
                pageTexts[0] = lines.map(\.text).joined(separator: "\n")
            }
            loadPDFKit()
            state = .ready
        } catch CoreError.password {
            state = .needsPassword(wrong: password != nil)
        } catch let error as CoreError {
            state = .failed(code: error.code, message: error.message)
        } catch {
            state = .failed(code: "E_OTHER", message: error.localizedDescription)
        }
    }

    private func loadPDFKit() {
        let document = PDFDocument(data: bytes)
        if let document, document.isLocked, let password {
            document.unlock(withPassword: password)
        }
        pdf = document
    }

    /// The page's text in logical order, from the core, cached.
    func text(ofPage index: Int) async -> String? {
        if let text = pageTexts[index] { return text }
        guard let core = await readyEngine(), index >= 0, index < pageCount else { return nil }
        guard let text = try? await core.extractText(page: index) else { return nil }
        pageTexts[index] = text
        return text
    }

    /// The text already read for a page, without waiting.
    func cachedText(ofPage index: Int) -> String? {
        pageTexts[index]
    }

    /// The pages holding `query`, the core's Arabic-aware way.
    func search(_ query: String) async throws -> [Int] {
        guard let core = await readyEngine() else { throw CoreError.closed }
        return try await core.search(query)
    }

    /// The core itself, for a tool that reads more than the model caches.
    /// Right after an undo it may still be reopening on the restored
    /// bytes: `readyEngine()` waits for that.
    var engine: Core? { core }

    /// The core once it matches the bytes (an undo reopens it off the
    /// main thread; anything that reads or edits waits for that first).
    func readyEngine() async -> Core? {
        await reopening?.value
        return core
    }

    /// The reopen an undo or redo started, so the next edit waits for it.
    private var reopening: Task<Void, Never>?

    // MARK: - Editing

    /// Runs a tool operation and takes the result: the core's incremental
    /// bytes become the edited document, PDFKit reloads, and the undo
    /// manager learns how to go back.
    @discardableResult
    func apply<A: Encodable>(_ op: String, args: A, blobs: [Data] = [], undoManager: UndoManager? = nil) async throws -> Reply {
        // Encoded here, before anything crosses into the core's actor.
        let json = String(decoding: try JSONEncoder().encode(args), as: UTF8.self)
        return try await apply(op, json: json, blobs: blobs, undoManager: undoManager)
    }

    /// `apply` with the arguments already as JSON (empty for none).
    @discardableResult
    func apply(_ op: String, json: String = "", blobs: [Data] = [], undoManager: UndoManager? = nil) async throws -> Reply {
        guard let core = await readyEngine() else { throw CoreError.closed }
        let before = edited
        let reply = try await core.call(op: op, args: json, blobs: blobs)
        let bytes = try await core.save()
        take(bytes: bytes)
        pageCount = await core.pageCount
        registerUndo(to: before, with: undoManager)
        return reply
    }

    /// Takes bytes a static operation answered — a mark added, appearances
    /// redrawn, another engine's changes rebased — as the edited document:
    /// the core reopens on them, PDFKit reloads, and undo gets a step back.
    func replace(bytes: Data, undoManager: UndoManager? = nil) async throws {
        try await replace(bytes: bytes, password: password, undoManager: undoManager)
    }

    /// `replace` for bytes whose protection changed: the core opens them
    /// with the new password (nil once the protection is removed), and
    /// undo brings the old one back with the old bytes.
    func replace(bytes: Data, password newPassword: String?, undoManager: UndoManager?) async throws {
        let before = edited
        let passwordBefore = password
        let core = try await Core.open(bytes: bytes, password: newPassword)
        self.core = core
        password = newPassword
        metadata = try? await core.metadata()
        pageCount = await core.pageCount
        take(bytes: bytes)
        registerUndo(to: before, passwordBefore: passwordBefore, with: undoManager)
    }

    /// Hands PDFKit's whole rewrite of the document — after annotations it
    /// added — to the core, which keeps only what changed as an incremental
    /// update on the bytes as they stand. When the core cannot (the
    /// protection differs), the rewrite is taken as it is.
    ///
    /// With `arabicFont`, the core then redraws text boxes and fields whose
    /// words PDFKit wrote with a font that has no Arabic — shaped, in that
    /// face, with a ToUnicode that reads back (`forms.fix_appearances`) —
    /// before the bytes are taken, so the two are one step of undo.
    func commitPDFKitChanges(undoManager: UndoManager? = nil, arabicFont: Data? = nil) async throws {
        guard let pdf, let rewritten = pdf.dataRepresentation() else { throw CoreError.closed }
        struct Args: Encodable { let password: String? }
        let reply = try await Core.callStatic(op: "file.rebase", args: Args(password: password), blobs: [bytes, rewritten])
        let rebased = reply.object["rebased"] as? Bool ?? false
        var result = rebased ? (reply.blobs.first ?? rewritten) : rewritten
        if let arabicFont {
            let fixed = try await Core.callStatic(op: "forms.fix_appearances", args: Args(password: password), blobs: [result, arabicFont])
            let redrawn = (fixed.object["comments"] as? Int ?? 0) + (fixed.object["fields"] as? Int ?? 0)
            if redrawn > 0, let bytes = fixed.blobs.first {
                result = bytes
            }
        }
        try await replace(bytes: result, undoManager: undoManager)
    }

    private func take(bytes: Data) {
        edited = bytes == original ? nil : bytes
        pageTexts.removeAll()
        loadPDFKit()
        revision += 1
    }

    private func registerUndo(to before: Data?, with undoManager: UndoManager?) {
        registerUndo(to: before, passwordBefore: password, with: undoManager)
    }

    private func registerUndo(to before: Data?, passwordBefore: String?, with undoManager: UndoManager?) {
        guard let undoManager else { return }
        let after = edited
        let passwordAfter = password
        // The handler runs on the main actor, as the model does.
        undoManager.registerUndo(withTarget: self) { model in
            model.restore(before, password: passwordBefore, redoTo: after, password: passwordAfter, undoManager: undoManager)
        }
    }

    /// Goes back to the bytes before an edit (the core reopened on them),
    /// with the password they open with, and gives the undo manager the way
    /// forward again.
    func restore(_ bytes: Data?, password passwordBefore: String?, redoTo after: Data?, password passwordAfter: String?, undoManager: UndoManager) {
        password = passwordBefore
        take(bytes: bytes ?? original)
        undoManager.registerUndo(withTarget: self) { model in
            model.restore(after, password: passwordAfter, redoTo: bytes, password: passwordBefore, undoManager: undoManager)
        }
        let previous = reopening
        reopening = Task {
            await previous?.value
            await reopenCore()
        }
    }

    private func reopenCore() async {
        guard let core = try? await Core.open(bytes: bytes, password: password) else { return }
        self.core = core
        metadata = try? await core.metadata()
        pageCount = await core.pageCount
    }

    // MARK: - Saving

    /// Writes the edited bytes over the file, coordinated with anything else
    /// reading it. Only then do the original bytes change.
    func save() async throws {
        guard let url, let edited else { return }
        var writeError: NSError?
        var innerError: (any Error)?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &writeError) { writeURL in
            do {
                try edited.write(to: writeURL, options: .atomic)
            } catch {
                innerError = error
            }
        }
        if let error = writeError ?? (innerError as NSError?) {
            throw error
        }
        original = edited
        self.edited = nil
    }

    /// Lets go of the core and of the file.
    func close() {
        core = nil
        if holdsSecurityScope, let url {
            url.stopAccessingSecurityScopedResource()
            holdsSecurityScope = false
        }
    }

    // MARK: - Hashable

    nonisolated static func == (lhs: DocumentModel, rhs: DocumentModel) -> Bool {
        lhs.id == rhs.id
    }

    nonisolated func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}
