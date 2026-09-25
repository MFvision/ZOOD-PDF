import Observation
import PDFKit
import SwiftUI
import ZoodCore
import ZoodEngine

/// One open document: PDFKit shows and annotates it, the Rust engine owns the bytes.
///
/// * The original file is untouched until Save.
/// * Organize/Protect/Combine-with run in the engine (incremental updates appended to the
///   original bytes; protection is a whole rewrite by design) and PDFKit reloads from the result.
/// * PDFKit writes whole files, so before any engine step or Save its output goes through
///   `doc.rebase`: only objects PDFKit changed are appended (same approach as the web viewer).
@MainActor @Observable
final class DocumentSession {
    enum Phase: Equatable {
        case loading
        case needsPassword(wrong: Bool)
        case ready
        case failed(String)
    }

    enum Tool: String, CaseIterable, Identifiable {
        case pen, marker, highlighter, eraser, textHighlight
        var id: String { rawValue }
    }

    enum UndoStep {
        case annotation(PDFPage, PDFAnnotation)
        case engine(Data)
    }

    /// PDFKit's save dropped or changed the encryption; the user decides.
    struct ProtectionDecision: Identifiable {
        let id = UUID()
        let unprotectedBytes: Data
        let then: PendingAction
    }

    enum PendingAction { case save, engineStep }

    let url: URL
    let recentID: String?
    let library: Library
    let pdfView = PDFView()

    private(set) var phase: Phase = .loading
    private(set) var name: String
    private(set) var pdf: PDFDocument?
    private(set) var info: DocInfo?
    private(set) var isEdited = false
    private(set) var isBusy = false
    private(set) var revision = 0
    private(set) var canUndo = false
    var pageIndex = 0
    var errorMessage: String?
    var toast: Toast?
    var protectionDecision: ProtectionDecision?

    // Annotate mode (nil = reading).
    var tool: Tool?
    var inkColor: InkColor = .blue
    var inkWidth: CGFloat = 3

    private var engine: WarraqEngine?
    private(set) var bytes = Data()
    private(set) var password: String?
    private var pdfkitDirty = false
    private var undo: [UndoStep] = [] {
        didSet { canUndo = !undo.isEmpty }
    }
    private static let undoByteBudget = 300_000_000

    init(document: OpenedDocument, library: Library) {
        url = document.url
        recentID = document.recentID
        self.library = library
        name = document.url.lastPathComponent
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.backgroundColor = .clear
        pdfView.pageShadowsEnabled = true
    }

    var pageCount: Int { pdf?.pageCount ?? 0 }
    var isProtected: Bool { info?.encrypted ?? false }

    // MARK: - Loading

    func load() async {
        phase = .loading
        do {
            let data = try await DocumentLibrary.read(url)
            let check = try WarraqEngine.isEncrypted(data)
            bytes = data
            if check.needsPassword {
                phase = .needsPassword(wrong: false)
                return
            }
            try await open(data, password: nil)
        } catch let e as WarraqError {
            phase = .failed(EngineMessages.text(for: e))
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func unlock(with password: String) async {
        do {
            try await open(bytes, password: password)
        } catch let e as WarraqError where e.code == "wrong_password" || e.code == "password_required" {
            phase = .needsPassword(wrong: true)
        } catch let e as WarraqError {
            phase = .failed(EngineMessages.text(for: e))
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func open(_ data: Data, password: String?) async throws {
        let engine = try WarraqEngine(data: data, password: password)
        let info = try await engine.info()
        self.engine = engine
        self.info = info
        self.password = password
        self.bytes = data
        try show(data, keepPage: false)
        phase = .ready
    }

    /// Point PDFKit at `data` (after load or an engine step).
    private func show(_ data: Data, keepPage: Bool) throws {
        guard let doc = PDFDocument(data: data) else { throw DocumentLibrary.LibraryError.unreadable(name) }
        if doc.isLocked, let password { _ = doc.unlock(withPassword: password) }
        let page = keepPage ? min(pageIndex, max(doc.pageCount - 1, 0)) : 0
        pdf = doc
        pdfView.document = doc
        if let p = doc.page(at: page) { pdfView.go(to: p) }
        pageIndex = page
        pdfkitDirty = false
        revision += 1
    }

    // MARK: - Annotations (PDFKit side)

    func didAdd(_ annotation: PDFAnnotation, on page: PDFPage) {
        undo.append(.annotation(page, annotation))
        pdfkitDirty = true
        isEdited = true
    }

    func didRemove(_ annotation: PDFAnnotation, on page: PDFPage) {
        pdfkitDirty = true
        isEdited = true
    }

    func undoLast() async {
        guard let step = undo.popLast() else { return }
        switch step {
        case .annotation(let page, let annotation):
            page.removeAnnotation(annotation)
            pdfkitDirty = true
        case .engine(let previous):
            do {
                let e = try WarraqEngine(data: previous, password: password)
                engine = e
                info = try await e.info()
                bytes = previous
                try show(previous, keepPage: true)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        isEdited = true
    }

    /// Fold PDFKit's edits into the engine through `doc.rebase` (incremental).
    /// Throws `NeedsDecision` when the rebase would change the protection.
    private func flushPDFKit(then action: PendingAction) async throws {
        guard pdfkitDirty, let pdf, let engine else { return }
        guard let edited = pdf.dataRepresentation() else { throw DocumentLibrary.LibraryError.unreadable(name) }
        let result = try await engine.rebase(edited: edited)
        if result.info.mode == .protectionChanged {
            protectionDecision = ProtectionDecision(unprotectedBytes: result.bytes, then: action)
            throw NeedsDecision()
        }
        bytes = result.bytes
        pdfkitDirty = false
        // PDFKit already shows these annotations; keep its document (no reload flicker).
    }

    struct NeedsDecision: Error {}

    /// The user chose how to save a protected file after marking it up.
    func resolveProtection(reprotect: Bool) async {
        guard let decision = protectionDecision else { return }
        protectionDecision = nil
        do {
            var out = decision.unprotectedBytes
            if reprotect, let password {
                // Whole rewrite with the password the user typed (AES-256), permissions kept.
                let plain = try WarraqEngine(data: out)
                out = try await plain.protect(
                    userPassword: password, ownerPassword: password, permissions: info?.permissions ?? Permissions())
            }
            let e = try WarraqEngine(data: out, password: reprotect ? password : nil)
            engine = e
            info = try await e.info()
            if !reprotect { password = nil }
            bytes = out
            pdfkitDirty = false
            try show(out, keepPage: true)
            if decision.then == .save { _ = await save() }
        } catch {
            errorMessage = (error as? WarraqError).map(EngineMessages.text(for:)) ?? error.localizedDescription
        }
    }

    // MARK: - Engine steps

    /// Run one engine operation that returns the new file; PDFKit reloads from it.
    func apply(_ op: @escaping @Sendable (WarraqEngine) async throws -> Data) async -> Bool {
        guard let engine else { return false }
        isBusy = true
        defer { isBusy = false }
        do {
            try await flushPDFKit(then: .engineStep)
            let before = bytes
            let out = try await op(engine)
            // Annotation steps are now baked into `before`; undo restores whole files.
            undo.removeAll { if case .annotation = $0 { true } else { false } }
            undo.append(.engine(before))
            trimUndo()
            bytes = out
            info = try await engine.info()
            try show(out, keepPage: true)
            isEdited = true
            return true
        } catch is NeedsDecision {
            return false
        } catch let e as WarraqError {
            errorMessage = EngineMessages.text(for: e)
            return false
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func trimUndo() {
        var total = 0
        var kept: [UndoStep] = []
        for step in undo.reversed() {
            if case .engine(let d) = step {
                total += d.count
                if total > Self.undoByteBudget { break }
            }
            kept.append(step)
        }
        undo = kept.reversed()
    }

    func rotate(_ pages: [Int], by degrees: Int) async {
        _ = await apply { try await $0.rotate(pages: pages, degrees: degrees).bytes }
    }

    func delete(_ pages: [Int]) async {
        guard pages.count < pageCount else {
            errorMessage = String(localized: "organize.error.deleteAll")
            return
        }
        _ = await apply { try await $0.delete(pages: pages).bytes }
    }

    func move(_ pages: [Int], to index: Int) async {
        _ = await apply { try await $0.move(pages: pages, to: index).bytes }
    }

    func insertBlank(at index: Int) async {
        _ = await apply { try await $0.insertBlank(at: index).bytes }
    }

    func insertFile(_ fileURL: URL, at index: Int, password: String? = nil) async {
        do {
            let data = try await DocumentLibrary.read(fileURL)
            _ = await apply { try await $0.insert(from: data, at: index, password: password).bytes }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Combine with a dropped/picked PDF: its pages are appended as an incremental update.
    func append(_ fileURL: URL) async {
        await insertFile(fileURL, at: pageCount)
        if errorMessage == nil { toast = Toast(message: String(localized: "combine.appended")) }
    }

    /// Selected pages as a new file in Documents (the open document is unchanged).
    func extract(_ pages: [Int]) async -> URL? {
        guard let engine else { return nil }
        do {
            try await flushPDFKit(then: .engineStep)
            let data = try await engine.extract(pages: pages)
            let base = FileNaming.baseName(name)
            let suffix = String(localized: "organize.extract.suffix \(PageRanges.format(pages))")
            let url = try DocumentLibrary.saveNew(data, name: "\(base) (\(suffix))")
            await library.record(url: url, data: data)
            return url
        } catch is NeedsDecision {
            return nil
        } catch {
            errorMessage = (error as? WarraqError).map(EngineMessages.text(for:)) ?? error.localizedDescription
            return nil
        }
    }

    func protect(user: String, owner: String, permissions: Permissions) async -> Bool {
        let previousPassword = password
        // PDFKit must unlock the new file when it reloads inside `apply`.
        password = owner.isEmpty ? user : owner
        let ok = await apply { try await $0.protect(userPassword: user, ownerPassword: owner, permissions: permissions) }
        if !ok { password = previousPassword }
        if ok {
            // A new engine document opened with the new password keeps later steps encrypted.
            if let e = try? WarraqEngine(data: bytes, password: password) {
                engine = e
                info = try? await e.info()
            }
            if let recentID { await library.updateAfterSave(recentID: recentID, data: bytes, protected: true) }
        }
        return ok
    }

    func removeProtection(ownerPassword: String?) async -> Bool {
        let ok = await apply { try await $0.removeProtection(ownerPassword: ownerPassword) }
        if ok {
            password = nil
            if let e = try? WarraqEngine(data: bytes) {
                engine = e
                info = try? await e.info()
            }
        }
        return ok
    }

    // MARK: - Save

    /// Write the file back (incremental update on the original bytes).
    @discardableResult
    func save() async -> Bool {
        isBusy = true
        defer { isBusy = false }
        do {
            try await flushPDFKit(then: .save)
            try await DocumentLibrary.write(bytes, to: url)
            isEdited = false
            toast = Toast(message: String(localized: "doc.saved"))
            if let recentID {
                await library.updateAfterSave(recentID: recentID, data: bytes, protected: info?.encrypted ?? false)
            }
            return true
        } catch is NeedsDecision {
            return false
        } catch {
            errorMessage = (error as? WarraqError).map(EngineMessages.text(for:)) ?? error.localizedDescription
            return false
        }
    }

    /// Current bytes including PDFKit edits, for Share/Compress/Convert/AI (no write).
    func currentBytes() async -> Data? {
        do {
            try await flushPDFKit(then: .engineStep)
            return bytes
        } catch {
            return nil
        }
    }

    /// A shareable copy of the current state.
    func shareURL() async -> URL? {
        guard let data = await currentBytes() else { return nil }
        return try? DocumentLibrary.temporaryCopy(data, name: name)
    }

    func goTo(page index: Int) {
        guard let pdf, let page = pdf.page(at: index) else { return }
        pdfView.go(to: page)
        pageIndex = index
    }
}

/// Localised messages for engine error codes (the engine's own messages are English).
enum EngineMessages {
    static func text(for error: WarraqError) -> String {
        switch error.code {
        case "password_required": String(localized: "engine.error.passwordRequired")
        case "wrong_password": String(localized: "engine.error.wrongPassword")
        case "permission_denied": String(localized: "engine.error.permissionDenied")
        case "parse_error": String(localized: "engine.error.parse")
        case "invalid_params": String(localized: "engine.error.params \(error.message)")
        default: String(localized: "engine.error.other \(error.message)")
        }
    }
}
