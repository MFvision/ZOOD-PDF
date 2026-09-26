import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import ZoodCore

struct DocumentScreen: View {
    let document: OpenedDocument
    @Environment(Library.self) private var library
    @State private var session: DocumentSession?

    var body: some View {
        Group {
            if let session {
                DocumentContent(session: session, initialTool: document.initialTool)
            } else {
                ProgressView()
            }
        }
        .task(id: document.id) {
            let s = DocumentSession(document: document, library: library)
            session = s
            await s.load()
        }
    }
}

enum DocSheet: Identifiable {
    case organize, protect, compress, convert, ai, autofill
    case share(URL)

    var id: String {
        switch self {
        case .organize: "organize"
        case .protect: "protect"
        case .compress: "compress"
        case .convert: "convert"
        case .ai: "ai"
        case .autofill: "autofill"
        case .share(let u): "share-\(u.path)"
        }
    }
}

/// Unified toolbar (title + "Page x of y · Edited", navigation, annotate, tools, share, save),
/// thumbnails rail on iPad, floating Pencil palette, drop-to-combine.
struct DocumentContent: View {
    @Bindable var session: DocumentSession
    let initialTool: ToolKind?

    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(Library.self) private var library
    @State private var showThumbnails = true
    @State private var sheet: DocSheet?
    @State private var dropped: [PDFFile] = []
    @State private var showDropChoice = false
    @State private var pickingCombine = false
    @State private var confirmLeave = false
    @State private var passwordField = ""
    @State private var didApplyInitialTool = false

    var body: some View {
        content
            .navigationTitle(Text(verbatim: FileNaming.baseName(session.name)))
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(session.isEdited)
            .toolbar { toolbar }
            .toast($session.toast)
            .sheet(item: $sheet) { sheetView($0) }
            .alert(
                Text("common.error"),
                isPresented: Binding(get: { session.errorMessage != nil }, set: { if !$0 { session.errorMessage = nil } })
            ) {
                Button("common.ok", role: .cancel) {}
            } message: {
                Text(verbatim: session.errorMessage ?? "")
            }
            .confirmationDialog(
                Text("doc.protection.title"),
                isPresented: Binding(get: { session.protectionDecision != nil }, set: { if !$0 { session.protectionDecision = nil } }),
                titleVisibility: .visible
            ) {
                if session.password != nil {
                    Button("doc.protection.keep") { Task { await session.resolveProtection(reprotect: true) } }
                }
                Button("doc.protection.remove", role: .destructive) { Task { await session.resolveProtection(reprotect: false) } }
                Button("common.cancel", role: .cancel) { session.protectionDecision = nil }
            } message: {
                Text("doc.protection.message")
            }
            .confirmationDialog(Text("drop.title"), isPresented: $showDropChoice, titleVisibility: .visible) {
                Button("drop.combine") {
                    let files = dropped
                    Task { for f in files { await session.append(f.url) } }
                }
                Button("drop.open") {
                    if let first = dropped.first {
                        if supportsMultipleWindows {
                            openWindow(id: "document", value: first.url)
                        }
                    }
                }
                Button("common.cancel", role: .cancel) {}
            }
            .confirmationDialog(Text("doc.unsaved.title"), isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("common.save") {
                    Task {
                        if await session.save() { dismiss() }
                    }
                }
                Button("doc.unsaved.discard", role: .destructive) { dismiss() }
                Button("common.cancel", role: .cancel) {}
            }
            .fileImporter(isPresented: $pickingCombine, allowedContentTypes: [.pdf], allowsMultipleSelection: true) { result in
                if case .success(let urls) = result {
                    Task { for u in urls { await session.append(u) } }
                }
            }
            .dropDestination(for: PDFFile.self) { files, _ in
                guard session.phase == .ready, !files.isEmpty else { return false }
                dropped = files
                showDropChoice = true
                return true
            }
            .onDisappear { session.stopReadingAloud() }
            .onChange(of: session.phase) { _, phase in
                guard phase == .ready, !didApplyInitialTool, let tool = initialTool else { return }
                didApplyInitialTool = true
                start(tool)
            }
    }

    @ViewBuilder private var content: some View {
        switch session.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView {
                Label("doc.openFailed", systemImage: "exclamationmark.triangle")
            } description: {
                Text(verbatim: message)
            }
        case .needsPassword(let wrong):
            passwordPrompt(wrong: wrong)
        case .ready:
            HStack(spacing: 0) {
                if sizeClass == .regular && showThumbnails {
                    ThumbnailRail(session: session)
                        .frame(width: 128)
                        .background(.ultraThinMaterial)
                        .accessibilityLabel(Text("doc.thumbnails"))
                    Divider()
                }
                ZStack(alignment: .bottom) {
                    PDFKitView(session: session)
                        .ignoresSafeArea(edges: .bottom)
                    if let tool = session.tool, tool != .eraser, tool != .textHighlight {
                        PencilCanvas(session: session)
                            .ignoresSafeArea(edges: .bottom)
                    }
                    if session.tool != nil {
                        PencilPalette(session: session)
                            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                    } else if let reader = session.reader {
                        ReadAloudBar(reader: reader) {
                            withAnimation(reduceMotion ? nil : .default) { session.stopReadingAloud() }
                        }
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                    }
                    if session.isBusy {
                        ProgressView().padding(20).glass()
                    }
                }
            }
            .background(Color(uiColor: .secondarySystemBackground))
        }
    }

    private func passwordPrompt(wrong: Bool) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.doc").font(.system(size: 48)).foregroundStyle(.secondary)
            Text("doc.password.title").font(.title3.bold())
            Text(verbatim: session.name).foregroundStyle(.secondary)
            SecureField("doc.password.placeholder", text: $passwordField)
                .textContentType(.password)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 320)
                .onSubmit(unlock)
                .accessibilityIdentifier("doc.password")
            if wrong {
                Text("engine.error.wrongPassword").foregroundStyle(.red).font(.callout)
            }
            Button("doc.password.open", action: unlock).buttonStyle(.borderedProminent)
                .disabled(passwordField.isEmpty)
        }
        .padding(32)
        .glass(Theme.radiusLarge)
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppBackdrop())
    }

    private func unlock() {
        let pw = passwordField
        Task { await session.unlock(with: pw) }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if session.isEdited {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    confirmLeave = true
                } label: {
                    Label("common.back", systemImage: "chevron.backward")
                }
            }
        }
        if sizeClass == .regular {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    withAnimation(reduceMotion ? nil : .default) { showThumbnails.toggle() }
                } label: {
                    Label("doc.toggleThumbnails", systemImage: "sidebar.leading")
                }
            }
        }
        ToolbarItem(placement: .principal) {
            VStack(spacing: 0) {
                Text(verbatim: FileNaming.baseName(session.name)).font(.headline).lineLimit(1)
                statusLine.font(.caption).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("doc.title")
            .draggable(PDFFile(url: session.url))
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if session.phase == .ready {
                if sizeClass == .regular {
                    Button {
                        session.goTo(page: max(session.pageIndex - 1, 0))
                    } label: {
                        Label("doc.previousPage", systemImage: "chevron.up")
                    }
                    .disabled(session.pageIndex == 0)
                    Button {
                        session.goTo(page: min(session.pageIndex + 1, session.pageCount - 1))
                    } label: {
                        Label("doc.nextPage", systemImage: "chevron.down")
                    }
                    .disabled(session.pageIndex >= session.pageCount - 1)
                }
                Button {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.3)) {
                        session.tool = session.tool == nil ? .pen : nil
                    }
                } label: {
                    Label("doc.annotate", systemImage: session.tool == nil ? "pencil.tip.crop.circle" : "pencil.tip.crop.circle.fill")
                }
                .accessibilityIdentifier("doc.annotate")
                toolsMenu
                Button {
                    Task { if let url = await session.shareURL() { sheet = .share(url) } }
                } label: {
                    Label("common.share", systemImage: "square.and.arrow.up")
                }
                Button("common.save") { Task { await session.save() } }
                    .fontWeight(.semibold)
                    .disabled(!session.isEdited || session.isBusy)
                    .accessibilityIdentifier("doc.save")
            }
        }
    }

    private var statusLine: Text {
        let pages = Text("doc.pageOf \(session.pageIndex + 1) \(session.pageCount)")
        return session.isEdited ? pages + Text(verbatim: " · ") + Text("doc.edited") : pages
    }

    private var toolsMenu: some View {
        Menu {
            Button { sheet = .organize } label: { Label { Text(ToolKind.organize.title) } icon: { Image(systemName: ToolKind.organize.symbol) } }
                .accessibilityIdentifier("doc.tool.organize")
            Button { pickingCombine = true } label: { Label("doc.combineWith", systemImage: ToolKind.combine.symbol) }
            Button { sheet = .compress } label: { Label { Text(ToolKind.compress.title) } icon: { Image(systemName: ToolKind.compress.symbol) } }
            Button { sheet = .protect } label: { Label { Text(ToolKind.protect.title) } icon: { Image(systemName: ToolKind.protect.symbol) } }
            Button { sheet = .convert } label: { Label { Text(ToolKind.convert.title) } icon: { Image(systemName: ToolKind.convert.symbol) } }
            Button { sheet = .ai } label: { Label { Text(ToolKind.ai.title) } icon: { Image(systemName: ToolKind.ai.symbol) } }
            Button { start(.readAloud) } label: {
                Label { Text(ToolKind.readAloud.title) } icon: { Image(systemName: ToolKind.readAloud.symbol) }
            }
            .disabled(session.reader != nil)
            Button { sheet = .autofill } label: {
                Label { Text(ToolKind.fillForm.title) } icon: { Image(systemName: ToolKind.fillForm.symbol) }
            }
            if supportsMultipleWindows {
                Divider()
                Button {
                    openWindow(id: "document", value: session.recentID.map { DeepLink.openRecent(id: $0).url } ?? session.url)
                } label: {
                    Label("recents.openNewWindow", systemImage: "macwindow.badge.plus")
                }
            }
        } label: {
            Label("doc.tools", systemImage: "square.grid.2x2")
        }
        .accessibilityIdentifier("doc.tools")
    }

    private func start(_ tool: ToolKind) {
        switch tool {
        case .edit: session.tool = .pen
        case .organize: sheet = .organize
        case .protect: sheet = .protect
        case .compress: sheet = .compress
        case .convert: sheet = .convert
        case .ai: sheet = .ai
        case .fillForm: sheet = .autofill
        case .readAloud:
            session.tool = nil
            withAnimation(reduceMotion ? nil : .default) { session.startReadingAloud() }
        default: break
        }
    }

    @ViewBuilder private func sheetView(_ s: DocSheet) -> some View {
        switch s {
        case .organize: OrganizeView(session: session)
        case .protect: ProtectSheet(session: session)
        case .compress: CompressSheet(session: session)
        case .convert: ConvertSheet(session: session)
        case .ai: AIAssistantSheet(session: session)
        case .autofill: AutofillSheet(session: session)
        case .share(let url): ActivityView(items: [url]).ignoresSafeArea()
        }
    }
}

/// UIActivityViewController (Share sheet, Save to Files, Print, AirDrop).
struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
