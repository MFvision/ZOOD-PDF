import SwiftUI
import UniformTypeIdentifiers

/// Export and share: PDF, Word, each page as a picture, the text, a
/// compressed copy, PDF/A — then the share sheet (Files, AirDrop, Mail
/// and the rest) or print. Each choice makes its file first and says what
/// it made.
struct ExportSheet: View {
    let model: DocumentModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var working: Exporter.Format?
    @State private var result: ExportResult?
    @State private var error: LocalizedStringKey?
    @State private var imageDPI: Float? = 150
    @State private var showingCompress = false
    @State private var showingFileExporter = false
    @State private var cloudFile: CloudFile?

    struct CloudFile: Identifiable {
        let url: URL
        var id: URL { url }
    }

    struct ExportResult: Identifiable {
        let id = UUID()
        let format: Exporter.Format
        let files: [URL]
        let note: LocalizedStringKey?
    }

    var body: some View {
        AppSheet(title: "Export") {
            List {
                // What was just made comes first: the file to share, and a
                // word on it.
                if let result {
                    Section {
                        ForEach(result.files, id: \.self) { url in
                            ShareLink(item: url, preview: SharePreview(url.lastPathComponent)) {
                                Label(url.lastPathComponent, systemImage: "square.and.arrow.up")
                            }
                            .accessibilityIdentifier("export.share.\(url.pathExtension)")
                        }
                        if result.files.count > 1 {
                            ShareLink(items: result.files) {
                                Label("Share all \(result.files.count) files", systemImage: "square.and.arrow.up.on.square")
                            }
                            .accessibilityIdentifier("export.shareAll")
                        }
                    } header: {
                        Text("Ready to share")
                    } footer: {
                        if let note = result.note {
                            Text(note)
                                .accessibilityIdentifier("export.note")
                        }
                    }
                }
                Section("Format") {
                    row(.pdf, "PDF", "doc.richtext", "The document as it stands.")
                    row(.word, "Word", "doc.text", "Each page as it looks: its pictures behind, its text in boxes to edit, in its own fonts and colours.")
                    row(.wordText, "Word, text only", "text.justify.leading", "Flowing paragraphs in reading order, Arabic right-to-left.")
                    row(.excel, "Excel", "tablecells", "The tables on each page as sheets you can calculate with; numbers stay numbers.")
                    row(.powerPoint, "PowerPoint", "rectangle.on.rectangle", "Each page a slide, its text in boxes you can edit.")
                    row(.images, "Page pictures", "photo.on.rectangle", "A PNG of each page at 150 dpi.")
                    row(.jpg, "JPG pictures", "photo", "A JPG of each page at 150 dpi: small, for messages and the web.")
                    row(.webp, "WebP pictures", "photo.stack", "A WebP of each page at 150 dpi, without loss.")
                    row(.text, "Text", "text.alignright", "Every page's text in logical order.")
                    row(.compressed, "Compressed PDF", "arrow.down.right.and.arrow.up.left", "Pictures downsampled, streams recompressed, unused objects dropped.")
                    row(.pdfa, "PDF/A-2b", "checkmark.seal", "For archiving: written whole and validated.")
                }
                Section {
                    Button {
                        Exporter.print(model)
                    } label: {
                        Label("Print…", systemImage: "printer")
                    }
                    .accessibilityIdentifier("export.print")
                    Button {
                        showingFileExporter = true
                    } label: {
                        Label("Save a copy to Files…", systemImage: "folder")
                    }
                    .accessibilityIdentifier("export.files")
                    Button {
                        if let url = try? Exporter.pdf(model) { cloudFile = CloudFile(url: url) }
                    } label: {
                        Label("Save to OneDrive or Google Drive…", systemImage: "icloud.and.arrow.up")
                    }
                    .accessibilityIdentifier("export.cloud")
                }
            }
            .accessibilityIdentifier("export.list")
        }
        .alert("Compressed copy", isPresented: $showingCompress) {
            Button("Pictures at 150 dpi") { export(.compressed, dpi: 150) }
            Button("Pictures at 100 dpi") { export(.compressed, dpi: 100) }
            Button("Keep the pictures as they are") { export(.compressed, dpi: nil) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Downsampling pictures makes the file smallest; keeping them loses nothing.")
        }
        .alert("Could not export", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error ?? "")
        }
        .fullScreenCover(item: $cloudFile) { file in
            CloudView(open: { _ in }, saving: file.url)
                .appEnvironment()
        }
        .fileExporter(isPresented: $showingFileExporter, item: SharedPDF(model: model), contentTypes: [.pdf], defaultFilename: model.name) { _ in }
    }

    private func row(_ format: Exporter.Format, _ title: LocalizedStringKey, _ symbol: String, _ detail: LocalizedStringKey) -> some View {
        Button {
            if format == .compressed {
                showingCompress = true
            } else {
                export(format, dpi: nil)
            }
        } label: {
            HStack(spacing: Space.x4) {
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: Space.x1) {
                    Text(title)
                        .foregroundStyle(Surface.label)
                    Text(detail)
                        .font(TextStyle.caption)
                        .foregroundStyle(Surface.secondaryLabel)
                }
                Spacer()
                if working == format {
                    ProgressView()
                } else if result?.format == format {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }
        }
        .disabled(working != nil)
        .accessibilityIdentifier("export.\(format.rawValue)")
    }

    private func export(_ format: Exporter.Format, dpi: Float?) {
        working = format
        Task {
            do {
                switch format {
                case .pdf:
                    result = ExportResult(format: format, files: [try Exporter.pdf(model)], note: nil)
                case .word:
                    result = ExportResult(format: format, files: [try await Exporter.word(model)], note: nil)
                case .wordText:
                    result = ExportResult(format: format, files: [try await Exporter.word(model, layout: false)], note: "Text only: the layout is not carried over.")
                case .images:
                    let files = try Exporter.images(model)
                    result = ExportResult(format: format, files: files, note: "\(files.count) pictures.")
                case .text:
                    result = ExportResult(format: format, files: [try await Exporter.text(model, locale: locale)], note: nil)
                case .compressed:
                    let (url, report) = try await Exporter.compressed(model, imageDPI: dpi, jpegQuality: 75, locale: locale)
                    let before = ByteCountFormatter.string(fromByteCount: Int64(report.before), countStyle: .file)
                    let after = ByteCountFormatter.string(fromByteCount: Int64(report.after), countStyle: .file)
                    result = ExportResult(format: format, files: [url], note: "\(before) → \(after)")
                case .pdfa:
                    let (url, report) = try await Exporter.pdfA(model)
                    let level = report.level ?? "2b"
                    let total = report.findings?.total ?? 0
                    let findings = report.findings?.items.count ?? 0
                    result = ExportResult(format: format, files: [url],
                                          note: report.findings?.passed == true ? "PDF/A-\(level): all \(total) checks passed." : "PDF/A-\(level): \(findings) findings in \(total) checks.")
                case .excel:
                    result = ExportResult(format: format, files: [try await Exporter.excel(model)], note: nil)
                case .powerPoint:
                    result = ExportResult(format: format, files: [try await Exporter.powerPoint(model)], note: nil)
                case .jpg, .webp:
                    let files = try await Exporter.pictures(model, format: format == .jpg ? "jpeg" : "webp")
                    result = ExportResult(format: format, files: files, note: "\(files.count) pictures.")
                }
                #if DEBUG
                // A UI test asks for the files where it can read them.
                if let dir = UserDefaults.standard.string(forKey: "warraqExportDir"), !dir.isEmpty, let result {
                    let folder = URL(filePath: dir, directoryHint: .isDirectory)
                    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    for file in result.files {
                        let target = folder.appending(path: file.lastPathComponent)
                        try? FileManager.default.removeItem(at: target)
                        try? FileManager.default.copyItem(at: file, to: target)
                    }
                }
                #endif
            } catch {
                self.error = PagesModel.describe(error)
            }
            working = nil
        }
    }
}
