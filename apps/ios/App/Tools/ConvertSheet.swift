import PDFKit
import SwiftUI
import ZoodCore

/// Convert on iOS: pages → PNG/JPEG pictures, or the document's text → .txt (engine
/// `text.plain` when available, otherwise PDFKit). Office formats are produced by the web and
/// desktop apps (see docs/STATUS.md). Results go to the Share sheet (Save to Files, Photos …).
struct ConvertSheet: View {
    let session: DocumentSession
    @Environment(\.dismiss) private var dismiss
    @State private var format: Format = .png
    @State private var dpi: Double = 150
    @State private var rangeText = ""
    @State private var working = false
    @State private var output: [URL] = []
    @State private var error: String?

    enum Format: String, CaseIterable, Identifiable {
        case png, jpeg, text
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("convert.format", selection: $format) {
                    Text("convert.format.png").tag(Format.png)
                    Text("convert.format.jpeg").tag(Format.jpeg)
                    Text("convert.format.text").tag(Format.text)
                }
                if format != .text {
                    Picker("convert.resolution", selection: $dpi) {
                        Text(verbatim: "72 dpi").tag(72.0)
                        Text(verbatim: "150 dpi").tag(150.0)
                        Text(verbatim: "300 dpi").tag(300.0)
                    }
                    TextField("convert.pages.placeholder", text: $rangeText)
                }
                if let error { Text(verbatim: error).foregroundStyle(.red) }
            }
            .navigationTitle(Text(ToolKind.convert.title))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("common.cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if working { ProgressView() } else { Button("convert.run", action: run) }
                }
            }
            .sheet(isPresented: Binding(get: { !output.isEmpty }, set: { if !$0 { output = [] } })) {
                ActivityView(items: output)
            }
        }
    }

    private func run() {
        error = nil
        working = true
        Task {
            defer { working = false }
            guard let data = await session.currentBytes() else { return }
            let base = FileNaming.sanitize(FileNaming.baseName(session.name))
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                if format == .text {
                    let text = await ThumbnailService.plainText(data, password: session.password, limit: .max) ?? ""
                    let url = dir.appendingPathComponent("\(base).txt")
                    try Data(text.utf8).write(to: url)
                    output = [url]
                    return
                }
                let pages: [Int] = rangeText.trimmingCharacters(in: .whitespaces).isEmpty
                    ? Array(0..<session.pageCount)
                    : try PageRanges.parse(rangeText, pageCount: session.pageCount)
                output = try await render(data, pages: pages, dir: dir, base: base)
            } catch let e as PageRanges.ParseError {
                error = e.localizedMessage
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func render(_ data: Data, pages: [Int], dir: URL, base: String) async throws -> [URL] {
        let fmt = format
        let scale = dpi / 72
        let password = session.password
        return try await Task.detached(priority: .userInitiated) { () -> [URL] in
            guard let doc = PDFDocument(data: data) else { return [] }
            if doc.isLocked, let password { _ = doc.unlock(withPassword: password) }
            var urls: [URL] = []
            for i in pages {
                guard let page = doc.page(at: i) else { continue }
                let box = page.bounds(for: .cropBox)
                let size = CGSize(width: box.width * scale, height: box.height * scale)
                // Cap at ~40 MP per page (hostile page sizes).
                guard size.width * size.height < 40_000_000 else { continue }
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                format.opaque = true
                let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
                    UIColor.white.setFill()
                    ctx.fill(CGRect(origin: .zero, size: size))
                    ctx.cgContext.translateBy(x: 0, y: size.height)
                    ctx.cgContext.scaleBy(x: scale, y: -scale)
                    page.draw(with: .cropBox, to: ctx.cgContext)
                }
                let ext = fmt == .png ? "png" : "jpg"
                let url = dir.appendingPathComponent(String(format: "%@ %03d.%@", base, i + 1, ext))
                let bytes = fmt == .png ? image.pngData() : image.jpegData(compressionQuality: 0.85)
                try bytes?.write(to: url)
                urls.append(url)
            }
            return urls
        }.value
    }
}
