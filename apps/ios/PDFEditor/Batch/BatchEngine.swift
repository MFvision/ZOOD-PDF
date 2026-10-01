import CoreGraphics
import Foundation
import SwiftUI
import UIKit
import WarraqCore

/// A file as the steps pass it along.
struct BatchDoc: Sendable, Equatable {
    var bytes: Data
    /// The password it opens with now: the batch's, or the one Protect gave it.
    var password: String?
    /// "pdf" until Export makes something else of it.
    var fileExtension = "pdf"
}

/// Why a file of the batch was not done, in the interface's words. A broken
/// file is one of these, never a crash: the core answers hostile bytes with
/// an error, and the rest of the batch goes on.
enum BatchFailure: Error, Equatable, Sendable {
    /// The file could not be read from where it is.
    case unreadable
    /// Not a PDF the core can open.
    case notPDF
    /// Protected, and no password was given for the batch.
    case needsPassword
    /// Protected, and the batch's password does not open it.
    case wrongPassword
    case deleteAll
    case noPages
    case compressProtected
    case compressSigned
    case hiddenProtected
    case noText
    /// Protect's new password is missing or too long.
    case protectPassword
    /// The core refused the step; its message.
    case core(String)
    /// The result could not be written.
    case write(String)

    var message: LocalizedStringKey {
        switch self {
        case .unreadable: "The file could not be read."
        case .notPDF: "This file is not a PDF that can be opened."
        case .needsPassword: "This file is protected. Type its password under Passwords and run it again."
        case .wrongPassword: "The batch's password does not open this file."
        case .deleteAll: "Deleting those pages would leave no page."
        case .noPages: "This file has none of those pages."
        case .compressProtected: "A protected file is not compressed: its protection would be lost."
        case .compressSigned: "A signed file is not compressed: its signature would break."
        case .hiddenProtected: "Hidden information is not removed from a protected file."
        case .noText: "This file has no text to export."
        case .protectPassword: "The new password is missing or too long."
        case let .core(message): "The step failed: \(message)"
        case let .write(message): "The result could not be written: \(message)"
        }
    }

    /// The same, as plain words in English, for the report and the logs.
    var code: String {
        switch self {
        case .unreadable: "unreadable"
        case .notPDF: "notPDF"
        case .needsPassword: "needsPassword"
        case .wrongPassword: "wrongPassword"
        case .deleteAll: "deleteAll"
        case .noPages: "noPages"
        case .compressProtected: "compressProtected"
        case .compressSigned: "compressSigned"
        case .hiddenProtected: "hiddenProtected"
        case .noText: "noText"
        case .protectPassword: "protectPassword"
        case .core: "core"
        case .write: "write"
        }
    }
}

/// What a step may use besides the file.
struct BatchContext: Sendable {
    /// The original's name, without its extension: `{file}` in a header, an export's title.
    var name: String
    /// Protect's passwords, typed for this run and never kept.
    var openPassword: String?
    var ownerPassword: String?
    /// The languages OCR reads in, as the scanner's settings have them.
    var languages: [String]
    var now: Date
    var locale: Locale
}

/// The steps themselves: each one core operation (or two), on bytes, off
/// the main thread. Nothing here writes a file.
enum BatchEngine {
    /// Opens `bytes` to find what they open with: no password, the batch's, or neither.
    static func opening(_ bytes: Data, password: String?) async -> Result<String?, BatchFailure> {
        do {
            let core = try await Core.open(bytes: bytes)
            await core.close()
            return .success(nil)
        } catch CoreError.password {
            guard let password, !password.isEmpty else { return .failure(.needsPassword) }
            do {
                let core = try await Core.open(bytes: bytes, password: password)
                await core.close()
                return .success(password)
            } catch {
                return .failure(.wrongPassword)
            }
        } catch {
            return .failure(.notPDF)
        }
    }

    static func run(_ step: BatchStep, on doc: BatchDoc, context: BatchContext) async throws -> BatchDoc {
        do {
            switch step.kind {
            case .ocr: return try await ocr(doc, scope: step.ocrScope, context: context)
            case .compress: return try await compress(doc, level: step.compressLevel)
            case .rotate: return try await rotate(doc, step: step)
            case .deletePages: return try await deletePages(doc, step: step)
            case .extractPages: return try await extractPages(doc, step: step)
            case .pageMarks: return try await pageMarks(doc, step: step, context: context)
            case .removeHidden: return try await removeHidden(doc, kinds: step.hiddenKinds)
            case .protect: return try await protect(doc, step: step, context: context)
            case .export: return try await export(doc, format: step.exportFormat, context: context)
            }
        } catch let failure as BatchFailure {
            throw failure
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as CoreError {
            throw BatchFailure.core(error.message)
        } catch {
            throw BatchFailure.core(error.localizedDescription)
        }
    }

    // MARK: - Pages

    /// Opens the file with the core, runs `body` on it, and closes it.
    private static func withCore<R: Sendable>(_ doc: BatchDoc, _ body: (Core) async throws -> R) async throws -> R {
        let core = try await Core.open(bytes: doc.bytes, password: doc.password)
        do {
            let result = try await body(core)
            await core.close()
            return result
        } catch {
            await core.close()
            throw error
        }
    }

    private static func pages(_ step: BatchStep, count: Int) throws -> [Int] {
        guard let pages = BatchPages.parse(step.pages, count: count) else { throw BatchFailure.noPages }
        return pages
    }

    private struct PagesArgs: Encodable { let pages: [Int] }
    private struct RotateArgs: Encodable { let pages: [Int]; let quarterTurns: Int }

    static func rotate(_ doc: BatchDoc, step: BatchStep) async throws -> BatchDoc {
        try await withCore(doc) { core in
            let chosen = try pages(step, count: await core.pageCount)
            if chosen.isEmpty { return doc }
            _ = try await core.call(op: "pages.rotate", args: RotateArgs(pages: chosen, quarterTurns: step.quarterTurns))
            return BatchDoc(bytes: try await core.save(), password: doc.password, fileExtension: doc.fileExtension)
        }
    }

    static func deletePages(_ doc: BatchDoc, step: BatchStep) async throws -> BatchDoc {
        try await withCore(doc) { core in
            let count = await core.pageCount
            let chosen = try pages(step, count: count)
            if chosen.isEmpty { return doc }
            if chosen.count >= count { throw BatchFailure.deleteAll }
            _ = try await core.call(op: "pages.delete", args: PagesArgs(pages: chosen))
            return BatchDoc(bytes: try await core.save(), password: doc.password, fileExtension: doc.fileExtension)
        }
    }

    static func extractPages(_ doc: BatchDoc, step: BatchStep) async throws -> BatchDoc {
        try await withCore(doc) { core in
            let count = await core.pageCount
            let chosen = try pages(step, count: count)
            if chosen.isEmpty { throw BatchFailure.noPages }
            if chosen.count == count { return doc }
            let reply = try await core.call(op: "pages.extract", args: PagesArgs(pages: chosen))
            guard let bytes = reply.blobs.first, !bytes.isEmpty else { throw BatchFailure.core("pages.extract answered no file") }
            // A new file of those pages, made without the original's protection.
            return BatchDoc(bytes: bytes, password: nil, fileExtension: "pdf")
        }
    }

    // MARK: - Compress, hidden information, protection

    static func compress(_ doc: BatchDoc, level: BatchStep.CompressLevel) async throws -> BatchDoc {
        struct Args: Encodable { let password: String?; let imageDpi: Float?; let jpegQuality: Int }
        struct Answer: Decodable { let refused: String?; let unchanged: Bool? }
        let reply = try await Core.callStatic(op: "compress.file",
                                              args: Args(password: doc.password, imageDpi: level.imageDPI, jpegQuality: level.jpegQuality),
                                              blobs: [doc.bytes])
        let answer: Answer = try reply.decode()
        switch answer.refused {
        case "protected"?: throw BatchFailure.compressProtected
        case "signed"?: throw BatchFailure.compressSigned
        case let other?: throw BatchFailure.core(other)
        case nil: break
        }
        // Already as small as it gets: the file itself, not a rewrite of it.
        guard answer.unchanged != true, let bytes = reply.blobs.first, !bytes.isEmpty else { return doc }
        return BatchDoc(bytes: bytes, password: doc.password, fileExtension: doc.fileExtension)
    }

    static func removeHidden(_ doc: BatchDoc, kinds: [String]) async throws -> BatchDoc {
        struct Args: Encodable { let password: String?; let remove: [String] }
        let reply = try await Core.callStatic(op: "redact.scrub", args: Args(password: doc.password, remove: kinds), blobs: [doc.bytes])
        if reply.object["refused"] != nil { throw BatchFailure.hiddenProtected }
        guard let bytes = reply.blobs.first, !bytes.isEmpty else { throw BatchFailure.core("redact.scrub answered no file") }
        return BatchDoc(bytes: bytes, password: doc.password, fileExtension: doc.fileExtension)
    }

    static func protect(_ doc: BatchDoc, step: BatchStep, context: BatchContext) async throws -> BatchDoc {
        guard let open = context.openPassword, Protect.isUsable(open) else { throw BatchFailure.protectPassword }
        struct Args: Encodable {
            let password: String?
            let openPassword: String
            let ownerPassword: String?
            let permissions: Protect.Permissions
        }
        let owner = context.ownerPassword.flatMap { $0.isEmpty ? nil : $0 }
        let args = Args(password: doc.password, openPassword: open, ownerPassword: owner,
                        permissions: Protect.Permissions(print: step.allowPrint, copy: step.allowCopy, change: step.allowChange))
        let reply = try await Core.callStatic(op: "protect.set", args: args, blobs: [doc.bytes])
        guard let bytes = reply.blobs.first, !bytes.isEmpty else { throw BatchFailure.core("protect.set answered no file") }
        return BatchDoc(bytes: bytes, password: open, fileExtension: doc.fileExtension)
    }

    // MARK: - Page marks

    /// The step's mark as the page-marks sheet would make it: the same form,
    /// read in the interface's digits and calendar.
    static func markForm(_ step: BatchStep, locale: Locale) -> MarkSpec.Form {
        var form = MarkSpec.Form()
        form.kind = step.mark
        switch step.mark {
        case .watermark: form.watermarkText = step.markText
        case .header, .footer: form.slots = ["", step.markText, ""]
        default: break
        }
        if locale.language.languageCode?.identifier == "ar" {
            form.numerals = .arabic
            form.calendar = .hijri
        }
        return form
    }

    static func pageMarks(_ doc: BatchDoc, step: BatchStep, context: BatchContext) async throws -> BatchDoc {
        let count = try await withCore(doc) { await $0.pageCount }
        let chosen = try pages(step, count: count)
        if chosen.isEmpty { return doc }
        let form = markForm(step, locale: context.locale)
        guard let font = form.font.bytes else { throw BatchFailure.core("the bundled font is missing") }
        struct Args: Encodable {
            let password: String?
            let mark: [String: JSONValue]
            let pages: [Int]
            let replace = true
            let fontBlob = 1
        }
        let args = Args(password: doc.password,
                        mark: MarkSpec.spec(of: form, fileName: context.name, now: context.now, locale: context.locale),
                        pages: chosen.count == count ? [] : chosen)
        let reply = try await Core.callStatic(op: "marks.add", args: args, blobs: [doc.bytes, font])
        guard let bytes = reply.blobs.first, !bytes.isEmpty else { throw BatchFailure.core("marks.add answered no file") }
        return BatchDoc(bytes: bytes, password: doc.password, fileExtension: doc.fileExtension)
    }

    // MARK: - OCR

    /// Pages are drawn for Vision at up to 300 dpi, the long side at most this
    /// many pixels (an A4 page at about 225 dpi): Vision reads it as well, in
    /// half the time.
    static let ocrLongSide: Float = 2600

    private struct LayerWord: Encodable { let text: String; let bbox: [Float] }
    private struct LayerPage: Encodable { let index: Int; let words: [LayerWord]; let angle: Float }
    private struct LayerArgs: Encodable { let password: String?; let pages: [LayerPage]; let modified: String }

    /// Each page with no text of its own (or every page) drawn by the core,
    /// read by Vision (the scanner's recognizer), and the words written back
    /// by the core as an invisible, shaped text layer — what the scanner does.
    static func ocr(_ doc: BatchDoc, scope: BatchStep.OCRScope, context: BatchContext) async throws -> BatchDoc {
        let wanted = TextRecognizer.languages(chosen: context.languages, supported: TextRecognizer.supportedLanguages())
        let layers: [LayerPage] = try await withCore(doc) { core in
            var layers: [LayerPage] = []
            for index in 0..<(await core.pageCount) {
                try Task.checkCancellation()
                if scope == .blank {
                    let own = try await core.extractText(page: index)
                    if !own.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
                }
                let size = try await core.pageSize(index)
                let scale = min(300 / 72, ocrLongSide / max(1, max(size.width, size.height)))
                let page = try await core.renderPage(index, scale: scale)
                guard let image = UIImage.from(rgba: page.rgba, width: page.width, height: page.height)?.cgImage else { continue }
                let recognition = try await recognize(image, languages: wanted)
                let words = recognition.words.map { word in
                    LayerWord(text: word.text, bbox: [Float(word.box.minX) / scale, Float(word.box.minY) / scale,
                                                      Float(word.box.maxX) / scale, Float(word.box.maxY) / scale])
                }
                if !words.isEmpty { layers.append(LayerPage(index: index, words: words, angle: 0)) }
            }
            return layers
        }
        // Nothing to read: the file goes on as it was.
        if layers.isEmpty { return doc }
        let font = try ScanExporter.fontData()
        let reply = try await Core.callStatic(op: "ocr.add_text_layer",
                                              args: LayerArgs(password: doc.password, pages: layers, modified: ScanExporter.pdfDate(context.now)),
                                              blobs: [doc.bytes, font])
        guard let bytes = reply.blobs.first, !bytes.isEmpty else { return doc }
        return BatchDoc(bytes: bytes, password: doc.password, fileExtension: doc.fileExtension)
    }

    /// Vision holds its thread for the whole page: a queue of its own.
    private static func recognize(_ image: CGImage, languages: [String]) async throws -> Recognition {
        let held = HeldImage(image: image)
        return try await withCheckedThrowingContinuation { continuation in
            ocrQueue.async {
                do {
                    continuation.resume(returning: try TextRecognizer.recognize(held.image, languages: languages))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static let ocrQueue = DispatchQueue(label: "app.warraq.ios.batch.ocr", qos: .utility)

    /// A CGImage is immutable; this only says so to the compiler.
    private struct HeldImage: @unchecked Sendable { let image: CGImage }

    // MARK: - Export

    static func export(_ doc: BatchDoc, format: BatchStep.ExportFormat, context: BatchContext) async throws -> BatchDoc {
        try await withCore(doc) { core in
            switch format {
            case .word:
                let pages = try await DocxWriter.pages(of: core)
                guard pages.contains(where: { $0.paragraphs.contains { !$0.text.isEmpty } }) else { throw BatchFailure.noText }
                return BatchDoc(bytes: DocxWriter.docx(pages: pages, title: context.name), password: nil, fileExtension: "docx")
            case .text:
                var out = ""
                var any = false
                let count = await core.pageCount
                for index in 0..<count {
                    let text = DocxWriter.clean(try await core.extractText(page: index))
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { any = true }
                    if index > 0 { out += "\n\n" }
                    out += String(localized: "Page \(index + 1)", locale: context.locale) + "\n\n" + text
                }
                guard any else { throw BatchFailure.noText }
                return BatchDoc(bytes: Data(out.utf8), password: nil, fileExtension: "txt")
            }
        }
    }
}
