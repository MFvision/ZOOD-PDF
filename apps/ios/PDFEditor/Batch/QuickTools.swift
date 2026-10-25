import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import WarraqCore

/// The desktop's quick tools (its ring and right-click menu) on the iPhone:
/// choose a PDF, tap a tool, and it runs at once — no "are you sure". A
/// window comes up only when the tool needs something from you (a password,
/// which pages, the watermark's words), with the page shown as it will be.
enum QuickTool: String, CaseIterable, Identifiable, Sendable {
    case compress, word, excel, powerPoint, text, jpg, webp
    case split, keepPages, deletePages, rotate, resizeA4
    case pageNumbers, watermark, unlock, protect, removeHidden, ocr

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .compress: "Compress"
        case .word: "To Word"
        case .excel: "To Excel"
        case .powerPoint: "To PowerPoint"
        case .text: "To text"
        case .jpg: "To JPG"
        case .webp: "To WebP"
        case .split: "Split into pages"
        case .keepPages: "Keep some pages"
        case .deletePages: "Delete pages"
        case .rotate: "Rotate"
        case .resizeA4: "Resize to A4"
        case .pageNumbers: "Page numbers"
        case .watermark: "Watermark"
        case .unlock: "Unlock"
        case .protect: "Protect"
        case .removeHidden: "Remove hidden info"
        case .ocr: "Make searchable (OCR)"
        }
    }

    var symbol: String {
        switch self {
        case .compress: "arrow.down.right.and.arrow.up.left"
        case .word: "doc.text"
        case .excel: "tablecells"
        case .powerPoint: "rectangle.on.rectangle"
        case .text: "text.alignleft"
        case .jpg: "photo"
        case .webp: "photo.stack"
        case .split: "scissors"
        case .keepPages: "doc.on.clipboard"
        case .deletePages: "trash"
        case .rotate: "rotate.right"
        case .resizeA4: "arrow.up.left.and.arrow.down.right"
        case .pageNumbers: "number"
        case .watermark: "drop"
        case .unlock: "lock.open"
        case .protect: "lock"
        case .removeHidden: "eye.slash"
        case .ocr: "text.viewfinder"
        }
    }

    /// What the tool asks for before it runs, if anything.
    enum Input { case none, pages, words, newPassword }

    var input: Input {
        switch self {
        case .keepPages, .deletePages: .pages
        case .watermark: .words
        case .protect: .newPassword
        default: .none
        }
    }

    static var groups: [(LocalizedStringKey, [QuickTool])] { [
        ("Convert", [.word, .excel, .powerPoint, .jpg, .webp, .text]),
        ("Pages", [.split, .keepPages, .deletePages, .rotate, .resizeA4]),
        ("Make smaller and mark", [.compress, .pageNumbers, .watermark, .ocr]),
        ("Protect", [.unlock, .protect, .removeHidden]),
    ] }
}

/// What a tool made: files to share, and PDFs to keep in My files.
struct QuickResult: Identifiable {
    let id = UUID()
    let tool: QuickTool
    let files: [URL]
    let note: String?
}

enum QuickRunner {
    struct Input: Sendable {
        var name: String
        var bytes: Data
        var password: String?
        var pages = ""
        var words = ""
        var newPassword = ""
    }

    private struct ResizeArgs: Encodable { let pages: [Int]; let width: Float; let height: Float }
    private struct PagesArgs: Encodable { let pages: [Int] }
    private struct PasswordArgs: Encodable { let password: String? }

    @MainActor
    static func run(_ tool: QuickTool, _ input: Input) async throws -> QuickResult {
        let folder = try Exporter.folder()
        func write(_ data: Data, _ suffix: String, _ ext: String) throws -> URL {
            let url = folder.appending(path: "\(input.name)\(suffix).\(ext)")
            try data.write(to: url)
            return url
        }
        let core = try await Core.open(bytes: input.bytes, password: input.password)
        defer { Task { await core.close() } }
        let context = BatchContext(name: input.name, openPassword: input.newPassword.isEmpty ? nil : input.newPassword,
                                   ownerPassword: nil, languages: PageOCR.languages, now: .now, locale: .current)
        let doc = BatchDoc(bytes: input.bytes, password: input.password)
        func step(_ kind: BatchStep.Kind, _ configure: (inout BatchStep) -> Void = { _ in }) async throws -> QuickResult {
            var step = BatchStep(kind: kind)
            configure(&step)
            let out = try await BatchEngine.run(step, on: doc, context: context)
            return QuickResult(tool: tool, files: [try write(out.bytes, suffixes[tool] ?? "", out.fileExtension)], note: nil)
        }
        switch tool {
        case .compress:
            let result = try await step(.compress) { $0.compressLevel = .balanced }
            let after = (try? result.files[0].resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            let format = { (bytes: Int) in ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }
            return QuickResult(tool: tool, files: result.files, note: "\(format(input.bytes.count)) → \(format(after))")
        case .word:
            let data = DocxLayout.docx(pages: try await DocxLayout.pages(of: core), title: input.name)
            return QuickResult(tool: tool, files: [try write(data, "", "docx")], note: nil)
        case .excel:
            let sheets = try await OfficeExport.sheets(core: core) { String(localized: "Page \($0)") }
            return QuickResult(tool: tool, files: [try write(OfficeExport.xlsx(sheets), "", "xlsx")], note: nil)
        case .powerPoint:
            return QuickResult(tool: tool, files: [try write(try await OfficeExport.powerPoint(core: core), "", "pptx")], note: nil)
        case .text:
            var out = ""
            for page in 0..<(await core.pageCount) {
                if page > 0 { out += "\n\n" }
                out += try await core.extractText(page: page)
            }
            return QuickResult(tool: tool, files: [try write(Data(out.utf8), "", "txt")], note: nil)
        case .jpg, .webp:
            let format = tool == .jpg ? "jpeg" : "webp"
            let pictures = try await OfficeExport.pictures(core: core, format: format)
            let digits = max(2, String(pictures.count).count)
            let files = try pictures.enumerated().map { index, data in
                try write(data, " " + String(format: "%0\(digits)d", index + 1), tool == .jpg ? "jpg" : "webp")
            }
            return QuickResult(tool: tool, files: files, note: String(localized: "\(files.count) pictures."))
        case .split:
            let count = await core.pageCount
            var files: [URL] = []
            for page in 0..<min(count, 300) {
                let reply = try await core.call(op: "pages.extract", args: PagesArgs(pages: [page]))
                if let bytes = reply.blobs.first {
                    files.append(try write(bytes, " - " + String(localized: "page \(page + 1)"), "pdf"))
                }
            }
            return QuickResult(tool: tool, files: files, note: String(localized: "\(files.count) files, one for each page."))
        case .keepPages:
            return try await step(.extractPages) { $0.pages = input.pages }
        case .deletePages:
            return try await step(.deletePages) { $0.pages = input.pages }
        case .rotate:
            return try await step(.rotate) { $0.quarterTurns = 1; $0.pages = "" }
        case .resizeA4:
            let count = await core.pageCount
            _ = try await core.call(op: "pages.resize", args: ResizeArgs(pages: Array(0..<count), width: 595.28, height: 841.89))
            return QuickResult(tool: tool, files: [try write(try await core.save(), suffixes[tool] ?? "", "pdf")], note: nil)
        case .pageNumbers:
            return try await step(.pageMarks) { $0.markKind = MarkSpec.Kind.pageNumber.rawValue; $0.pages = "" }
        case .watermark:
            return try await step(.pageMarks) { $0.markKind = MarkSpec.Kind.watermark.rawValue; $0.markText = input.words; $0.pages = "" }
        case .unlock:
            let reply = try await Core.callStatic(op: "protect.remove", args: PasswordArgs(password: input.password), blobs: [input.bytes])
            guard let bytes = reply.blobs.first else { throw CoreError.badReply("protect.remove answered no file") }
            return QuickResult(tool: tool, files: [try write(bytes, suffixes[tool] ?? "", "pdf")], note: nil)
        case .protect:
            return try await step(.protect)
        case .removeHidden:
            return try await step(.removeHidden)
        case .ocr:
            return try await step(.ocr) { $0.ocrScope = .blank }
        }
    }

    /// The new file's name after the original's: "Lease (compressed).pdf".
    @MainActor static var suffixes: [QuickTool: String] {
        [.compress: String(localized: " (compressed)"), .keepPages: String(localized: " (some pages)"),
         .deletePages: String(localized: " (pages deleted)"), .rotate: String(localized: " (rotated)"),
         .resizeA4: " (A4)", .pageNumbers: String(localized: " (numbered)"), .watermark: String(localized: " (watermark)"),
         .unlock: String(localized: " (unlocked)"), .protect: String(localized: " (protected)"),
         .removeHidden: String(localized: " (cleaned)"), .ocr: String(localized: " (searchable)")]
    }
}

/// The Quick tools screen.
struct QuickToolsView: View {
    let library: LibraryModel
    @Environment(\.dismiss) private var dismiss
    @State private var chosen: LocalDocument?
    @State private var imported: URL?
    @State private var importing = false
    @State private var makingFrom = false
    @State private var making = false
    @State private var made: URL?
    @State private var working: QuickTool?
    @State private var asking: QuickTool?
    @State private var input = QuickRunner.Input(name: "", bytes: Data())
    @State private var needsPassword = false
    @State private var result: QuickResult?
    @State private var error: LocalizedStringKey?

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: Space.x4)]

    private var file: URL? { imported ?? chosen?.url }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.x6) {
                    filePicker
                    if let result { resultCard(result) }
                    makePDFCard
                    ForEach(QuickTool.groups.indices, id: \.self) { index in
                        let (title, tools) = QuickTool.groups[index]
                        VStack(alignment: .leading, spacing: Space.x3) {
                            Text(title).themeFont(.headline).foregroundStyle(Surface.secondaryLabel)
                            LazyVGrid(columns: columns, spacing: Space.x4) {
                                ForEach(tools) { tool in tile(tool) }
                            }
                        }
                    }
                }
                .padding(Space.x5)
            }
            .themedGround()
            .navigationTitle("Quick tools")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("quick.done")
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf]) { picked in
                if case let .success(url) = picked {
                    imported = url
                    chosen = nil
                    result = nil
                }
            }
            .fileImporter(isPresented: $makingFrom, allowedContentTypes: MakePDF.types) { picked in
                if case let .success(url) = picked { Task { await makePDF(from: url) } }
            }
            .sheet(item: $asking) { tool in
                QuickInputSheet(tool: tool, file: file, input: $input) {
                    asking = nil
                    Task { await run(tool, asked: true) }
                }
                .appEnvironment()
            }
            .alert("This file is protected", isPresented: $needsPassword) {
                SecureField("Password", text: Binding(get: { input.password ?? "" }, set: { input.password = $0 }))
                Button("Open") { if let tool = working ?? asking { Task { await run(tool, asked: true) } } }
                Button("Cancel", role: .cancel) { working = nil }
            } message: {
                Text("Type its password to use it.")
            }
            .alert("Quick tools", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
        }
    }

    private var filePicker: some View {
        VStack(alignment: .leading, spacing: Space.x3) {
            Text("1. Choose a PDF").themeFont(.headline)
            Menu {
                ForEach(library.documents.prefix(30)) { document in
                    Button(document.name) {
                        chosen = document
                        imported = nil
                        result = nil
                        input.password = nil
                    }
                }
                Divider()
                Button("From Files…", systemImage: "folder") { importing = true }
            } label: {
                HStack {
                    Image(systemName: "doc.richtext")
                    Text(verbatim: file?.deletingPathExtension().lastPathComponent ?? String(localized: "Choose a PDF…"))
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                }
                .padding(Space.x4)
                .background(Surface.groupedCell, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            }
            .foregroundStyle(Surface.label)
            .accessibilityIdentifier("quick.file")
            Text("2. Tap a tool: it runs at once and makes a new file. Your PDF stays as it is.")
                .font(TextStyle.caption)
                .foregroundStyle(Surface.secondaryLabel)
        }
    }

    /// A PDF from a Word, Excel or PowerPoint file, a web page or text.
    private var makePDFCard: some View {
        VStack(alignment: .leading, spacing: Space.x3) {
            Button {
                makingFrom = true
            } label: {
                HStack(spacing: Space.x3) {
                    if making { ProgressView() } else { Image(systemName: "doc.badge.plus").font(.system(size: 22)) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Make a PDF from another file").themeFont(.headline)
                        Text("Word, Excel, PowerPoint, a web page or text").font(TextStyle.caption).foregroundStyle(Surface.secondaryLabel)
                    }
                    Spacer()
                }
                .padding(Space.x4)
                .background(Surface.groupedCell, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            }
            .buttonStyle(.pressable)
            .foregroundStyle(Surface.label)
            .disabled(making)
            .accessibilityIdentifier("quick.makePDF")
            if let made {
                HStack {
                    ShareLink(item: made) { Label(made.lastPathComponent, systemImage: "square.and.arrow.up").lineLimit(1) }
                    Spacer()
                    Button("Open") {
                        if let bytes = try? Data(contentsOf: made),
                           (try? library.adopt(bytes: bytes, name: made.deletingPathExtension().lastPathComponent, open: true)) != nil {
                            dismiss()
                        }
                    }
                }
                .padding(.horizontal, Space.x2)
            }
        }
    }

    private func makePDF(from url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        making = true
        defer { making = false }
        do {
            let data = try await MakePDF.pdf(from: url)
            let target = try Exporter.folder().appending(path: url.deletingPathExtension().lastPathComponent + ".pdf")
            try data.write(to: target)
            made = target
        } catch {
            self.error = "This file could not be turned into a PDF on this iPhone."
        }
    }

    private func tile(_ tool: QuickTool) -> some View {
        Button {
            Task { await run(tool, asked: false) }
        } label: {
            VStack(spacing: Space.x3) {
                if working == tool {
                    ProgressView().frame(height: 28)
                } else {
                    Image(systemName: tool.symbol).font(.system(size: 24)).frame(height: 28)
                }
                Text(tool.title)
                    .font(TextStyle.caption.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 92)
            .background(Surface.groupedCell, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(.pressable)
        .foregroundStyle(file == nil ? Surface.tertiaryLabel : Surface.label)
        .disabled(file == nil || working != nil)
        .accessibilityIdentifier("quick.\(tool.rawValue)")
    }

    private func resultCard(_ result: QuickResult) -> some View {
        VStack(alignment: .leading, spacing: Space.x3) {
            Label { Text("Done: ") + Text(result.tool.title) } icon: { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                .themeFont(.headline)
            if let note = result.note { Text(note).font(TextStyle.caption).foregroundStyle(Surface.secondaryLabel) }
            ForEach(result.files.prefix(6), id: \.self) { url in
                ShareLink(item: url) { Label(url.lastPathComponent, systemImage: "square.and.arrow.up").lineLimit(1) }
            }
            if result.files.count > 1 {
                ShareLink(items: result.files) { Label("Share all \(result.files.count) files", systemImage: "square.and.arrow.up.on.square") }
            }
            let pdfs = result.files.filter { $0.pathExtension.lowercased() == "pdf" }
            if !pdfs.isEmpty {
                Button {
                    for url in pdfs {
                        if let bytes = try? Data(contentsOf: url) {
                            _ = try? library.adopt(bytes: bytes, name: url.deletingPathExtension().lastPathComponent, open: false)
                        }
                    }
                    if pdfs.count == 1, let url = pdfs.first, let bytes = try? Data(contentsOf: url) {
                        _ = bytes
                        dismiss()
                        if let saved = library.documents.first(where: { $0.name == url.deletingPathExtension().lastPathComponent }) {
                            library.open(saved)
                        }
                    }
                } label: {
                    Label(pdfs.count == 1 ? "Keep in My files and open" : "Keep \(pdfs.count) files in My files", systemImage: "tray.and.arrow.down")
                }
                .accessibilityIdentifier("quick.keep")
            }
        }
        .padding(Space.x5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.groupedCell, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .accessibilityIdentifier("quick.result")
    }

    private func run(_ tool: QuickTool, asked: Bool) async {
        guard let file else { return }
        let scoped = file.startAccessingSecurityScopedResource()
        defer { if scoped { file.stopAccessingSecurityScopedResource() } }
        guard let bytes = try? Data(contentsOf: file) else {
            error = "The file could not be read."
            return
        }
        input.name = file.deletingPathExtension().lastPathComponent
        input.bytes = bytes
        if !asked, tool.input != .none {
            asking = tool
            return
        }
        working = tool
        defer { if !needsPassword { working = nil } }
        do {
            result = try await QuickRunner.run(tool, input)
        } catch CoreError.password {
            needsPassword = true
        } catch let failure as BatchFailure {
            error = failure.message
        } catch {
            self.error = PagesModel.describe(error)
        }
    }
}

/// What a tool needs before it runs, over the page it will change.
struct QuickInputSheet: View {
    let tool: QuickTool
    let file: URL?
    @Binding var input: QuickRunner.Input
    let run: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var preview: UIImage?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ZStack {
                        if let preview {
                            Image(uiImage: preview).resizable().scaledToFit()
                                .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
                        } else {
                            ProgressView().frame(height: 220)
                        }
                        if tool == .watermark, !input.words.isEmpty {
                            Text(input.words)
                                .font(.system(size: 34, weight: .bold))
                                .foregroundStyle(.gray.opacity(0.45))
                                .rotationEffect(.degrees(-35))
                                .lineLimit(1)
                                .minimumScaleFactor(0.3)
                                .padding(Space.x8)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: 260)
                    .accessibilityIdentifier("quick.preview")
                }
                Section {
                    switch tool.input {
                    case .pages:
                        TextField("Pages, like 1-3, 5", text: $input.pages)
                            .keyboardType(.numbersAndPunctuation)
                            .accessibilityIdentifier("quick.pages")
                    case .words:
                        TextField("The watermark's words", text: $input.words)
                            .accessibilityIdentifier("quick.words")
                    case .newPassword:
                        SecureField("New password", text: $input.newPassword)
                            .accessibilityIdentifier("quick.password")
                    case .none:
                        EmptyView()
                    }
                } footer: {
                    Text("A new file is made; your PDF stays as it is.")
                }
            }
            .navigationTitle(tool.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Go", action: run)
                        .disabled(!ready)
                        .accessibilityIdentifier("quick.go")
                }
            }
            .task { preview = Self.firstPage(of: input.bytes) }
        }
        .presentationDetents([.medium, .large])
    }

    private var ready: Bool {
        switch tool.input {
        case .pages: !input.pages.trimmingCharacters(in: .whitespaces).isEmpty && BatchPages.parse(input.pages, count: .max) != nil
        case .words: !input.words.trimmingCharacters(in: .whitespaces).isEmpty
        case .newPassword: !input.newPassword.isEmpty
        case .none: true
        }
    }

    static func firstPage(of bytes: Data) -> UIImage? {
        guard let document = PDFDocument(data: bytes), let page = document.page(at: 0) else { return nil }
        let bounds = page.bounds(for: .cropBox)
        let scale = 520 / max(bounds.width, bounds.height)
        return page.thumbnail(of: CGSize(width: bounds.width * scale, height: bounds.height * scale), for: .cropBox)
    }
}
