import Foundation
import PDFKit
import UIKit
import WarraqCore

/// What the document can become, and how: each format is one function
/// that writes a file into a folder of its own in the temporary directory
/// and answers its URL, for the share sheet, Files or print. On the main
/// actor, where the model lives; the core's work runs off it.
@MainActor
enum Exporter {
    enum Format: String, CaseIterable, Identifiable {
        case pdf
        case word
        case images
        case text
        case compressed
        case pdfa

        var id: String { rawValue }
    }

    /// A folder for one export's files.
    static func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "export-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// The bytes as they stand, as a file carrying the document's name.
    static func pdf(_ model: DocumentModel) throws -> URL {
        let url = try folder().appending(path: "\(model.name).pdf")
        try model.bytes.write(to: url)
        return url
    }

    /// Word: the core's paragraphs, `DocxWriter`.
    static func word(_ model: DocumentModel) async throws -> URL {
        guard let core = model.engine else { throw CoreError.closed }
        let pages = try await DocxWriter.pages(of: core)
        let data = DocxWriter.docx(pages: pages, title: model.name)
        let url = try folder().appending(path: "\(model.name).docx")
        try data.write(to: url)
        return url
    }

    /// Plain text: every page's lines in logical order, pages headed.
    static func text(_ model: DocumentModel) async throws -> URL {
        guard let core = model.engine else { throw CoreError.closed }
        var out = ""
        let count = await core.pageCount
        for index in 0..<count {
            let text = try await core.extractText(page: index)
            if index > 0 { out += "\n\n" }
            out += String(localized: "Page \(index + 1)") + "\n\n" + DocxWriter.clean(text)
        }
        let url = try folder().appending(path: "\(model.name).txt")
        try out.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    /// Each page as a PNG at 150 dpi, drawn by PDFKit.
    static func images(_ model: DocumentModel) throws -> [URL] {
        guard let pdf = model.pdf else { throw CoreError.closed }
        let folder = try folder()
        var urls: [URL] = []
        let width = 2
        for index in 0..<pdf.pageCount {
            guard let page = pdf.page(at: index) else { continue }
            let frame = PageSpace.Frame(page: page)
            let scale: CGFloat = 150 / 72
            let size = CGSize(width: frame.shownSize.width * scale, height: frame.shownSize.height * scale)
            let image = page.thumbnail(of: size, for: .cropBox)
            guard let png = image.pngData() else { continue }
            let number = String(format: "%0\(max(width, String(pdf.pageCount).count))d", index + 1)
            let url = folder.appending(path: "\(model.name) \(number).png")
            try png.write(to: url)
            urls.append(url)
        }
        return urls
    }

    struct CompressReport: Decodable, Sendable {
        let before: Int
        let after: Int
        let images: Int
        let refused: String?
    }

    /// A smaller copy through the core (`compress.file`): pictures
    /// downsampled to `imageDPI` when asked, streams recompressed, unused
    /// objects dropped. The open document is not changed.
    static func compressed(_ model: DocumentModel, imageDPI: Float?, jpegQuality: Int) async throws -> (url: URL, report: CompressReport) {
        struct Args: Encodable { let password: String?; let imageDpi: Float?; let jpegQuality: Int }
        let reply = try await Core.callStatic(op: "compress.file", args: Args(password: model.password, imageDpi: imageDPI, jpegQuality: jpegQuality), blobs: [model.bytes])
        let report: CompressReport = try reply.decode()
        if let refused = report.refused {
            throw CoreError.edit(refused)
        }
        guard let bytes = reply.blobs.first else { throw CoreError.badReply("compress.file answered no file") }
        let url = try folder().appending(path: "\(model.name) – \(String(localized: "compressed")).pdf")
        try bytes.write(to: url)
        return (url, report)
    }

    struct PDFAReport: Decodable, Sendable {
        struct Findings: Decodable, Sendable { let total: Int; let passed: Int }
        let level: String?
        let findings: Findings?
        let refused: String?
        let reasons: [String]?
    }

    /// PDF/A-2b through the core (`standards.pdfa`): a copy written whole
    /// and validated, the bundled Arabic face standing in for fonts the
    /// file does not carry.
    static func pdfA(_ model: DocumentModel) async throws -> (url: URL, report: PDFAReport) {
        guard let font = AppFonts.arabic else { throw CoreError.font("the bundled font is missing") }
        struct Face: Encodable { let name: String; let serif: Bool }
        struct Args: Encodable { let password: String?; let level: String; let now: String; let title: String?; let faces: [Face] }
        let now = ISO8601DateFormatter().string(from: .now)
        let args = Args(password: model.password, level: "2b", now: now, title: model.metadata?.title, faces: [Face(name: "Amiri", serif: true)])
        let reply = try await Core.callStatic(op: "standards.pdfa", args: args, blobs: [model.bytes, font])
        let report: PDFAReport = try reply.decode()
        if let refused = report.refused {
            throw CoreError.edit(refused == "signed" ? String(localized: "A signed document is not converted.") : String(localized: "This document cannot be PDF/A-2b: \((report.reasons ?? []).joined(separator: ", "))"))
        }
        guard let bytes = reply.blobs.first else { throw CoreError.badReply("standards.pdfa answered no file") }
        let url = try folder().appending(path: "\(model.name) – PDFA.pdf")
        try bytes.write(to: url)
        return (url, report)
    }

    /// Prints the bytes as they stand through the system's print panel.
    static func print(_ model: DocumentModel, from view: UIView?) {
        let controller = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.jobName = model.name
        info.outputType = .general
        controller.printInfo = info
        controller.printingItem = model.bytes
        controller.present(animated: true, completionHandler: nil)
    }
}
