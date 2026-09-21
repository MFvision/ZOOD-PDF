import PDFKit
import SwiftUI
import WarraqCore

/// A document on screen: PDFKit draws the pages; the toolbar's title block
/// names the file and the page; around it the find bar, the markup bar,
/// the thumbnails, and the sheets — pages, outline, export, protect, info.
/// Everything that changes the document goes through the model, so undo,
/// the edited state and Save are one thing everywhere.
///
/// The page view is one accessibility element whose value is the current
/// page's text in logical order from the core — so VoiceOver reads Arabic
/// as it is read, which PDFKit alone does not promise.
struct DocumentView: View {
    @Bindable var model: DocumentModel
    @Environment(\.undoManager) private var undoManager
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(ViewSettingsKey.layout) private var layout: PageLayout = .continuous
    @AppStorage(ViewSettingsKey.night) private var night = false
    @State private var search = DocumentSearch()
    @State private var host = PDFViewHost()
    @State private var thumbnails = PageThumbnailCache()
    @State private var editor: AnnotationEditor?
    @State private var pagesModel: PagesModel?
    @State private var showingSearch = false
    @State private var showingThumbnails = false
    @State private var readerMode = false
    @State private var markup = false
    @State private var showingInfo = false
    @State private var showingOutline = false
    @State private var showingGoTo = false
    @State private var showingPages = false
    @State private var showingExport = false
    @State private var showingProtect = false
    @State private var showingMarks = false
    @State private var showingStamps = false
    @State private var showingSignature = false
    @State private var placingSignature: UIImage?
    @State private var saveError: String?
    @State private var pageText: String?
    @State private var stampsAdded = 0

    private var compact: Bool { sizeClass == .compact }

    var body: some View {
        VStack(spacing: 0) {
            if showingSearch, model.isReady, !readerMode {
                SearchBar(search: search, model: model) {
                    closeSearch()
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            if markup, let editor {
                MarkupBar(editor: editor, undoManager: undoManager,
                          openStamps: { showingStamps = true },
                          openSignature: { showingSignature = true },
                          done: finishMarkup)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            HStack(spacing: 0) {
                if showingThumbnails, model.isReady, !compact {
                    ThumbnailsSidebar(model: model, cache: thumbnails, width: 150, horizontal: false)
                    Divider()
                }
                ZStack {
                    content
                    if let image = placingSignature {
                        SignaturePlacer(image: image, model: model, host: host, undoManager: undoManager) {
                            placingSignature = nil
                        }
                        .transition(.opacity)
                    }
                }
            }
            if showingThumbnails, model.isReady, compact {
                Divider()
                ThumbnailsSidebar(model: model, cache: thumbnails, width: 72, horizontal: true)
                    .frame(height: 132)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(Motion.travel(reduceMotion: reduceMotion), value: showingSearch)
        .animation(Motion.travel(reduceMotion: reduceMotion), value: markup)
        .animation(Motion.travel(reduceMotion: reduceMotion), value: showingThumbnails)
        .navigationTitle(model.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .toolbarRole(.editor)
        .focusedSceneValue(\.documentActions, actions)
        .sheet(isPresented: $showingInfo) {
            DocumentInfoSheet(model: model)
        }
        .sheet(isPresented: $showingOutline) {
            OutlineSheet(model: model)
        }
        .sheet(isPresented: $showingGoTo) {
            GoToPageSheet(model: model)
        }
        .sheet(isPresented: $showingPages) {
            if let pagesModel {
                PagesGridView(pages: pagesModel, cache: thumbnails)
            }
        }
        .sheet(isPresented: $showingExport) {
            ExportSheet(model: model)
        }
        .sheet(isPresented: $showingProtect) {
            ProtectSheet(model: model, undoManager: undoManager)
        }
        .sheet(isPresented: $showingMarks) {
            if let editor {
                AnnotationsListSheet(model: model, editor: editor)
            }
        }
        .sheet(isPresented: $showingStamps) {
            StampSheet(model: model, undoManager: undoManager) {
                stampsAdded += 1
            }
        }
        .sheet(isPresented: $showingSignature) {
            SignatureSheet(store: SignatureStore()) { image in
                editor?.tool = nil
                placingSignature = image
            }
        }
        .sheet(item: Binding(get: { editor?.pending }, set: { editor?.pending = $0 })) { placement in
            if let editor {
                NoteSheet(placement: placement, editor: editor)
            }
        }
        .alert("Could not save", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveError ?? "")
        }
        .alert("Could not add the mark", isPresented: Binding(get: { editor?.error != nil }, set: { if !$0 { editor?.clearError() } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(editor?.error ?? "")
        }
        .sensoryFeedback(.success, trigger: editor?.commits ?? 0)
        .sensoryFeedback(.success, trigger: stampsAdded)
        .task(id: model.id) {
            if editor == nil {
                editor = AnnotationEditor(model: model)
                pagesModel = PagesModel(model: model)
            }
            if model.state == .loading {
                await model.load()
            }
        }
        .task(id: textKey) {
            pageText = await model.text(ofPage: model.currentPage)
        }
        .onChange(of: undoManager, initial: true) { _, manager in
            editor?.undoManager = manager
            pagesModel?.undoManager = manager
        }
        .onChange(of: model.revision) {
            // The bytes changed: the hits' selections belong to the old pages.
            if showingSearch { search.run(in: model) }
        }
        .onChange(of: search.current) {
            if let hit = search.currentHit { model.currentPage = hit.page }
        }
    }

    /// When the page's text must be read again: another page, an edit, or
    /// the document just became ready.
    private struct TextKey: Hashable {
        let page: Int
        let edited: Bool
        let ready: Bool
        let revision: Int
    }

    private var textKey: TextKey {
        TextKey(page: model.currentPage, edited: model.isEdited, ready: model.isReady, revision: model.revision)
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            ProgressView("Opening…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Surface.underPage)
        case let .needsPassword(wrong):
            PasswordPrompt(wrong: wrong) { password in
                await model.load(password: password)
            }
        case let .failed(code, message):
            EmptyState(symbol: "doc.questionmark", title: "Cannot open this file", message: "\(code): \(message)")
                .background(Surface.underPage)
        case .ready:
            if readerMode {
                ReaderModeView(model: model)
            } else if let pdf = model.pdf {
                PDFKitView(document: pdf, displaysRTL: model.isRightToLeft, layout: layout, night: night,
                           editor: editor, host: host,
                           highlights: search.highlighted, currentHighlight: showingSearch ? search.currentSelection : nil,
                           currentPage: $model.currentPage)
                    .ignoresSafeArea(edges: showingThumbnails && compact ? [] : .bottom)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text("Page \(model.currentPage + 1) of \(model.pageCount)"))
                    .accessibilityValue(Text(pageText ?? ""))
                    .accessibilityIdentifier("document.page")
            } else {
                // The core read it; PDFKit could not draw it.
                EmptyState(symbol: "doc.questionmark", title: "Cannot draw this file", message: "The pages could not be drawn on this device.")
                    .background(Surface.underPage)
            }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            ToolbarStatus(title: model.name, subtitle: status)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if model.isEdited, model.url != nil {
                Button("Save", systemImage: "square.and.arrow.down", action: save)
                    .keyboardShortcut("s", modifiers: .command)
                    .accessibilityIdentifier("document.save")
            }
            if !readerMode {
                Button("Find", systemImage: "magnifyingglass") {
                    if showingSearch { closeSearch() } else { showingSearch = true }
                }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(!model.isReady)
                .accessibilityIdentifier("document.search")
                Button("Markup", systemImage: markup ? "pencil.tip.crop.circle.fill" : "pencil.tip.crop.circle") {
                    if markup { finishMarkup() } else { markup = true }
                }
                .disabled(!model.isReady)
                .accessibilityIdentifier("document.markup")
            }
            if !compact {
                Button("Pages", systemImage: "square.grid.2x2") { showingPages = true }
                    .disabled(!model.isReady)
                    .accessibilityIdentifier("document.pages")
                Button("Thumbnails", systemImage: showingThumbnails ? "sidebar.leading" : "sidebar.leading") {
                    showingThumbnails.toggle()
                }
                .disabled(!model.isReady)
                .accessibilityIdentifier("document.thumbnails.toggle")
            }
            moreMenu
            if !compact {
                ShareLink(item: SharedPDF(model: model), preview: SharePreview(model.name, image: Image(systemName: "doc.richtext")))
                    .disabled(!model.isReady)
                    .accessibilityIdentifier("document.share")
            }
            Button("Info", systemImage: "info.circle") {
                showingInfo = true
            }
            .disabled(!model.isReady)
            .accessibilityIdentifier("document.info")
        }
        if compact {
            ToolbarItemGroup(placement: .bottomBar) {
                Button("Thumbnails", systemImage: "rectangle.grid.1x2") { showingThumbnails.toggle() }
                    .disabled(!model.isReady)
                    .accessibilityIdentifier("document.thumbnails.toggle")
                Spacer()
                Button("Pages", systemImage: "square.grid.2x2") { showingPages = true }
                    .disabled(!model.isReady)
                    .accessibilityIdentifier("document.pages")
                Spacer()
                Button("Reader mode", systemImage: readerMode ? "doc.plaintext.fill" : "doc.plaintext") { readerMode.toggle() }
                    .disabled(!model.isReady)
                    .accessibilityIdentifier("document.reader.toggle")
                Spacer()
                Button("Night mode", systemImage: night ? "moon.fill" : "moon") { night.toggle() }
                    .disabled(!model.isReady)
                    .accessibilityIdentifier("document.night.toggle")
                Spacer()
                Button("Go to page", systemImage: "number") { showingGoTo = true }
                    .disabled(!model.isReady)
                    .accessibilityIdentifier("document.goto")
            }
        }
    }

    private var moreMenu: some View {
        Menu {
            Picker("Layout", selection: $layout) {
                ForEach(PageLayout.allCases) { item in
                    Label(item.title, systemImage: item.symbol).tag(item)
                }
            }
            .pickerStyle(.inline)
            Toggle("Night mode", systemImage: "moon", isOn: $night)
            Toggle("Reader mode", systemImage: "doc.plaintext", isOn: $readerMode)
            if compact {
                Toggle("Thumbnails", systemImage: "rectangle.grid.1x2", isOn: $showingThumbnails)
            }
            Divider()
            Button("Outline", systemImage: "list.bullet.indent") { showingOutline = true }
                .accessibilityIdentifier("document.outline")
            Button("Go to page…", systemImage: "number") { showingGoTo = true }
                .keyboardShortcut("g", modifiers: [.command, .option])
            Button("Marks", systemImage: "pencil.and.outline") { showingMarks = true }
                .accessibilityIdentifier("document.marks")
            if compact {
                Button("Pages", systemImage: "square.grid.2x2") { showingPages = true }
            }
            Divider()
            Button("Export…", systemImage: "square.and.arrow.up.on.square") { showingExport = true }
                .keyboardShortcut("e", modifiers: [.command, .shift])
                .accessibilityIdentifier("document.export")
            Button("Protect…", systemImage: model.password != nil || model.metadata?.encrypted == true ? "lock.fill" : "lock") { showingProtect = true }
                .keyboardShortcut("l", modifiers: [.command, .shift])
                .accessibilityIdentifier("document.protect")
            if compact {
                ShareLink(item: SharedPDF(model: model), preview: SharePreview(model.name, image: Image(systemName: "doc.richtext")))
                    .accessibilityIdentifier("document.share")
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
        .disabled(!model.isReady)
        .accessibilityIdentifier("document.more")
    }

    private var status: Text? {
        guard model.isReady else { return nil }
        let page = Text("Page \(model.currentPage + 1) of \(model.pageCount)")
        return model.isEdited ? page + Text(verbatim: " — ") + Text("Edited") : page
    }

    // MARK: - Actions

    private var actions: DocumentActions {
        DocumentActions(canSave: model.isEdited && model.url != nil, perform: perform)
    }

    /// The menu bar's and the keyboard's way in.
    private func perform(_ action: DocumentAction) {
        switch action {
        case .find: if !readerMode { showingSearch = true }
        case .goToPage: showingGoTo = true
        case .nextPage: model.currentPage = min(model.currentPage + 1, max(model.pageCount - 1, 0))
        case .previousPage: model.currentPage = max(model.currentPage - 1, 0)
        case .toggleThumbnails: showingThumbnails.toggle()
        case .toggleNight: night.toggle()
        case .toggleReader: readerMode.toggle()
        case .showPages: showingPages = true
        case .export: showingExport = true
        case .protect: showingProtect = true
        case .save: save()
        }
    }

    private func closeSearch() {
        showingSearch = false
        search.clear()
    }

    private func finishMarkup() {
        editor?.commitInk()
        editor?.tool = nil
        markup = false
    }

    private func save() {
        Task {
            do {
                try await model.save()
            } catch {
                saveError = error.localizedDescription
            }
        }
    }
}

/// The bytes as they stand, offered to the share sheet as a PDF file
/// carrying the document's name.
struct SharedPDF: Transferable {
    let model: DocumentModel

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .pdf) { shared in
            let (bytes, name) = await MainActor.run { (shared.model.bytes, shared.model.name) }
            let folder = FileManager.default.temporaryDirectory.appending(path: "share-\(UUID().uuidString)", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appending(path: "\(name).pdf")
            try bytes.write(to: url)
            return SentTransferredFile(url)
        }
    }
}

/// Asks for a document's password; says when the one given was wrong.
struct PasswordPrompt: View {
    let wrong: Bool
    let open: (String) async -> Void
    @State private var password = ""
    @State private var opening = false

    var body: some View {
        VStack(spacing: Space.x5) {
            Image(systemName: "lock.doc")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Surface.secondaryLabel)
            Text("This document is protected")
                .font(TextStyle.title)
            (wrong ? Text("That password is not right. Try again.") : Text("Enter its password to open it."))
                .font(TextStyle.body)
                .foregroundStyle(Surface.secondaryLabel)
                .multilineTextAlignment(.center)
            SecureField("Password", text: $password)
                .textFieldStyle(.roundedBorder)
                .textContentType(.password)
                .submitLabel(.go)
                .onSubmit(submit)
                .frame(maxWidth: 320)
                .accessibilityIdentifier("document.password")
            Button(action: submit) {
                if opening {
                    ProgressView()
                } else {
                    Text("Open")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(password.isEmpty || opening)
            .keyboardShortcut(.defaultAction)
            .accessibilityIdentifier("document.password.open")
        }
        .padding(Space.x8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Surface.underPage)
    }

    private func submit() {
        guard !password.isEmpty, !opening else { return }
        opening = true
        Task {
            await open(password)
            opening = false
        }
    }
}

/// What the core read from the file: its own information, the marks on
/// it, and which engine draws it.
struct DocumentInfoSheet: View {
    let model: DocumentModel

    var body: some View {
        AppSheet(title: "Info") {
            List {
                Section("Document") {
                    row("Title", model.metadata?.title)
                    row("Author", model.metadata?.author)
                    row("Creator", model.metadata?.creator)
                    row("Producer", model.metadata?.producer)
                    LabeledContent("Pages") {
                        Text(model.pageCount, format: .number)
                            .tabularNumbers()
                    }
                    LabeledContent("Marks") {
                        Text(markCount, format: .number)
                            .tabularNumbers()
                            .accessibilityIdentifier("info.marks")
                    }
                    LabeledContent("Protected", value: model.password != nil || model.metadata?.encrypted == true ? String(localized: "Yes") : String(localized: "No"))
                    LabeledContent("Reading direction", value: model.isRightToLeft ? String(localized: "Right to left") : String(localized: "Left to right"))
                }
                Section("Engine") {
                    LabeledContent("Core", value: Core.version)
                    LabeledContent("Pages drawn by", value: model.metadata?.engine ?? "")
                }
            }
            .accessibilityIdentifier("document.infoList")
        }
    }

    /// The marks a person made (PDFKit's count of annotations that are not
    /// links or form fields).
    private var markCount: Int {
        guard let pdf = model.pdf else { return 0 }
        return (0..<pdf.pageCount).reduce(0) { total, index in
            total + (pdf.page(at: index)?.annotations.filter(\.isMarkup).count ?? 0)
        }
    }

    private func row(_ label: LocalizedStringKey, _ value: String?) -> some View {
        LabeledContent(label) {
            Text(value?.isEmpty == false ? value! : "—")
                .foregroundStyle(value?.isEmpty == false ? Surface.label : Surface.tertiaryLabel)
                .multilineTextAlignment(.trailing)
        }
    }
}
