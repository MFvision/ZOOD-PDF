import SwiftUI
import UniformTypeIdentifiers

/// Export and share: PDF, Word, each page as a picture, the text, a
/// compressed copy, PDF/A — then the share sheet (Files, AirDrop, Mail
/// and the rest) or print. Each choice makes its file first and says what
/// it made.
struct ExportSheet: View {
    let model: DocumentModel
    @Environment(\.dismiss) private var dismiss
    @State private var working: Exporter.Format?
    @State private var result: ExportResult?
    @State private var error: String?
    @State private var imageDPI: Float? = 150
    @State private var showingCompress = false
    @State private var showingFileExporter = false

    struct ExportResult: Identifiable {
        let id = UUID()
        let format: Exporter.Format
        let files: [URL]
        let note: String?
    }

    var body: some View {
        AppSheet(title: "Export") {
            List {
                Section("Format") {
                    row(.pdf, "PDF", "doc.richtext", "The document as it stands.")
                    row(.word, "Word", "doc.text", "Flowing paragraphs in reading order, Arabic right-to-left.")
                    row(.images, "Page pictures", "photo.on.rectangle", "A PNG of each page at 150 dpi.")
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
                }
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
                    result = ExportResult(format: format, files: [try await Exporter.word(model)], note: String(localized: "Text only: the layout is not carried over."))
                case .images:
                    let files = try Exporter.images(model)
                    result = ExportResult(format: format, files: files, note: String(localized: "\(files.count) pictures."))
                case .text:
                    result = ExportResult(format: format, files: [try await Exporter.text(model)], note: nil)
                case .compressed:
                    let (url, report) = try await Exporter.compressed(model, imageDPI: dpi, jpegQuality: 75)
                    let before = ByteCountFormatter.string(fromByteCount: Int64(report.before), countStyle: .file)
                    let after = ByteCountFormatter.string(fromByteCount: Int64(report.after), countStyle: .file)
                    result = ExportResult(format: format, files: [url], note: String(localized: "\(before) → \(after)"))
                case .pdfa:
                    let (url, report) = try await Exporter.pdfA(model)
                    let passed = report.findings?.passed ?? 0
                    let total = report.findings?.total ?? 0
                    result = ExportResult(format: format, files: [url], note: String(localized: "PDF/A-\(report.level ?? "2b"): \(passed) of \(total) checks passed."))
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
