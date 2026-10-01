import PDFKit
import SwiftUI
import UniformTypeIdentifiers
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
    @State private var edit: EditModel?
    @State private var pagesModel: PagesModel?
    @State private var editing = false
    @State private var showingMarksSheet = false
    @State private var pickingPicture = false
    @State private var showingSearch = false
    @State private var showingThumbnails = false
    @State private var thumbnailsForMarkup = false
    @State private var readerMode = false
    @State private var markup = false
    @State private var showingInfo = false
    @State private var showingOutline = false
    @State private var showingGoTo = false
    @State private var showingPages = false
    @State private var showingExport = false
    @State private var showingProtect = false
    @State private var showingSignatures = false
    @State private var showingMarks = false
    @State private var showingStamps = false
    @State private var showingSignature = false
    @State private var showingCrop = false
    @State private var placingSignature: UIImage?
    @State private var saveError: String?
    @State private var pageText: String?
    @State private var stampsAdded = 0
    @State private var showingScanner = false
    @State private var scanSaved: URL?

    private var compact: Bool { sizeClass == .compact }

    // The screen in four parts — the stack of bars and pages, the chrome
    // round it, the sheets and the alerts — each its own expression. Swift 6
    // gives up type-checking one long enough to hold all of them.
    var body: some View {
        alerts(on: sheets(on: chrome(on: stack)))
    }

    private var stack: some View {
        VStack(spacing: 0) {
            if showingSearch, model.isReady, !readerMode {
                SearchBar(search: search, model: model) {
                    closeSearch()
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            if editing, let edit {
                EditBar(edit: edit, undoManager: undoManager,
                        openPicture: { pickingPicture = true },
                        openMarks: { showingMarksSheet = true },
                        done: finishEditing)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if markup, let editor {
                MarkupBar(editor: editor, undoManager: undoManager,
                          openStamps: { showingStamps = true },
                          openSignature: { showingSignature = true },
                          openCrop: { showingCrop = true },
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
                .overlay(alignment: .bottom) {
                    // The floating pen palette, over the pages' foot. An
                    // overlay, so its width (more than an iPhone's) never
                    // sizes the pages, the stack and the bar above them.
                    if markup, let editor, editor.tool == .ink {
                        PenPalette(editor: editor)
                            .padding(.horizontal, Space.x5)
                            .padding(.bottom, Space.x5)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    // On iPhone the strip sits above the bottom bar, inside
                    // the safe area the bar leaves.
                    if showingThumbnails, model.isReady, compact {
                        VStack(spacing: 0) {
                            Divider()
                            ThumbnailsSidebar(model: model, cache: thumbnails, width: 72, horizontal: true)
                                .frame(height: 144)
                        }
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                if editing, let edit, !compact {
                    // The editor's inspector, where there is room beside the
                    // pages: what this page holds, and what can be done to it.
                    Divider()
                    EditInspector(edit: edit, openPicture: { pickingPicture = true })
                        .frame(width: 280)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
        }
    }

    /// The window round the pages: the motion, the title, the toolbar, and
    /// the work that keeps the models in step with the document.
    private func chrome(on view: some View) -> some View {
        view
            .animation(Motion.travel(reduceMotion: reduceMotion), value: editing)
            .animation(Motion.travel(reduceMotion: reduceMotion), value: showingSearch)
            .animation(Motion.travel(reduceMotion: reduceMotion), value: markup)
            .animation(Motion.travel(reduceMotion: reduceMotion), value: showingThumbnails)
            .navigationTitle(model.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .toolbarRole(.editor)
            .themedToolbar()
            .focusedSceneValue(\.documentActions, actions)
            .task(id: model.id) {
                if editor == nil {
                    editor = AnnotationEditor(model: model)
                    pagesModel = PagesModel(model: model)
                    edit = EditModel(model: model)
                }
                if model.state == .loading {
                    await model.load()
                }
            }
            // What the page holds, read as the editor opens, as the page
            // changes and again after each edit — reflowing a paragraph moves
            // the ones under it, and a picture changed changes the page's list.
            .task(id: editKey) {
                guard editing, let edit else { return }
                await edit.read(page: model.currentPage)
            }
            .task(id: textKey) {
                pageText = await model.text(ofPage: model.currentPage)
            }
            .onChange(of: undoManager, initial: true) { _, manager in
                editor?.undoManager = manager
                pagesModel?.undoManager = manager
                edit?.undoManager = manager
            }
            .onChange(of: model.revision) {
                // The bytes changed: the hits' selections belong to the old pages.
                if showingSearch { search.run(in: model) }
            }
            .onChange(of: search.current) {
                if let hit = search.currentHit { model.currentPage = hit.page }
            }
    }

    /// Everything the screen puts over itself.
    private func sheets(on view: some View) -> some View {
        view
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
        .sheet(isPresented: $showingSignatures) {
            SignaturesSheet(model: model, undoManager: undoManager)
        }
        .sheet(isPresented: $showingMarks) {
            if let editor {
                AnnotationsListSheet(model: model, editor: editor)
            }
        }
        .sheet(isPresented: $showingCrop) {
            if let pagesModel {
                CropSheet(pages: pagesModel, cache: thumbnails, page: model.currentPage)
            }
        }
        .sheet(isPresented: $showingMarksSheet) {
            PageMarksSheet(model: model, undoManager: undoManager)
        }
        .sheet(item: Binding(get: { edit?.draftLink }, set: { edit?.draftLink = $0 })) { draft in
            if let edit {
                LinkSheet(edit: edit, draft: draft, existing: edit.pickedLink)
            }
        }
        // The picture a new one is placed from, or a picked one replaced with.
        .fileImporter(isPresented: $pickingPicture, allowedContentTypes: [.image]) { result in
            choosePicture(result)
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
        // A document opened from a picture: the scanner enhances and reads it.
        .fullScreenCover(isPresented: $showingScanner) {
            if let image = model.sourceImage {
                ScanView(images: [image]) { url in
                    scanSaved = url
                }
                .appEnvironment()
            }
        }
    }

    /// What went wrong, said once, and the haptic on what went right.
    private func alerts(on view: some View) -> some View {
        view
            .alert("Could not save", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(saveError ?? "")
            }
            .alert("Saved to My documents", isPresented: Binding(get: { scanSaved != nil }, set: { if !$0 { scanSaved = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(verbatim: scanSaved?.lastPathComponent ?? "")
            }
            .alert("Could not add the mark", isPresented: Binding(get: { editor?.error != nil }, set: { if !$0 { editor?.clearError() } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(editor?.error ?? "")
            }
            .alert("Could not make that change", isPresented: Binding(get: { edit?.error != nil }, set: { if !$0 { edit?.clearError() } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(edit?.error ?? "")
            }
            .alert("The text was changed", isPresented: Binding(get: { edit?.notice != nil }, set: { if !$0 { edit?.clearNotice() } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(edit?.notice ?? "")
            }
            .sensoryFeedback(.success, trigger: editor?.commits ?? 0)
            .sensoryFeedback(.success, trigger: stampsAdded)
            .sensoryFeedback(.success, trigger: edit?.edits ?? 0)
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

    /// When the editor must read the page again.
    private struct EditKey: Hashable {
        let page: Int
        let revision: Int
        let editing: Bool
        let ready: Bool
    }

    private var editKey: EditKey {
        EditKey(page: model.currentPage, revision: model.revision, editing: editing, ready: model.isReady)
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
                           editor: editor, tool: editor?.tool, inkSignature: editor?.inkSignature ?? "",
                           edit: editing ? edit : nil, editSignature: editing ? (edit?.signature ?? "") : "",
                           host: host,
                           highlights: search.highlighted, currentHighlight: showingSearch ? search.currentSelection : nil,
                           currentPage: $model.currentPage)
                    // Night mode: the pages inverted, hues turned back so a
                    // blue heading stays blue (the system's own smart invert).
                    .colorInvert(if: night)
                    .hueRotation(.degrees(night ? 180 : 0))
                    .ignoresSafeArea(edges: showingThumbnails && compact ? [] : .bottom)
                    // One element while the pages are read, so VoiceOver gets
                    // the core's text of the page in logical order; a
                    // container while the editor is open, so the field over
                    // the paragraph is reachable.
                    .accessibilityElement(children: editing ? .contain : .ignore)
                    .accessibilityLabel(pageLabel)
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
            if model.sourceImage != nil {
                Button("Scan", systemImage: "doc.viewfinder") {
                    showingScanner = true
                }
                .accessibilityIdentifier("document.scan")
            }
            if model.isEdited, model.url != nil {
                Button("Save", systemImage: "square.and.arrow.down", action: save)
                    .keyboardShortcut("s", modifiers: .command)
                    .accessibilityIdentifier("document.save")
            }
            if !compact {
                findAndMarkup
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
            // The phone: the title block stays in the navigation bar, and
            // the tools sit under the thumb — the view modes in More.
            ToolbarItemGroup(placement: .bottomBar) {
                findAndMarkup
                Spacer()
                Button("Thumbnails", systemImage: "rectangle.grid.1x2") { showingThumbnails.toggle() }
                    .disabled(!model.isReady)
                    .accessibilityIdentifier("document.thumbnails.toggle")
                Spacer()
                Button("Pages", systemImage: "square.grid.2x2") { showingPages = true }
                    .disabled(!model.isReady)
                    .accessibilityIdentifier("document.pages")
            }
        }
    }

    @ViewBuilder
    private var findAndMarkup: some View {
        if !readerMode {
            Button("Find", systemImage: "magnifyingglass") {
                if showingSearch { closeSearch() } else { showingSearch = true }
            }
            .keyboardShortcut("f", modifiers: .command)
            .disabled(!model.isReady)
            .accessibilityIdentifier("document.search")
            Button("Markup", systemImage: markup ? "pencil.tip.crop.circle.fill" : "pencil.tip.crop.circle") {
                if markup { finishMarkup() } else { startMarkup() }
            }
            .disabled(!model.isReady)
            .accessibilityIdentifier("document.markup")
            Button("Edit", systemImage: editing ? "textformat.alt" : "textformat") {
                if editing { finishEditing() } else { startEditing() }
            }
            .keyboardShortcut("e", modifiers: [.command, .option])
            .disabled(!model.isReady)
            .accessibilityIdentifier("document.edit")
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
            Button("Page marks…", systemImage: "signature") { showingMarksSheet = true }
                .accessibilityIdentifier("document.pageMarks")
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
            Button("Signatures…", systemImage: "signature") { showingSignatures = true }
                .keyboardShortcut("d", modifiers: [.command, .shift])
                .accessibilityIdentifier("document.signatures")
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

    /// The page element's label: the page, and whether the document is edited.
    private var pageLabel: Text {
        let page = Text("Page \(model.currentPage + 1) of \(model.pageCount)")
        return model.isEdited ? page + Text(verbatim: ", ") + Text("Edited") : page
    }

    private var status: Text? {
        guard model.isReady else { return nil }
        let page = Text("Page \(model.currentPage + 1) of \(model.pageCount)")
        return model.isEdited ? page + Text(verbatim: " — ") + Text("Edited") : page
    }

    // MARK: - Actions

    private var actions: DocumentActions {
        DocumentActions(canSave: model.isEdited && model.url != nil,
                        typing: editing && (edit?.editing != nil || edit?.placing != nil),
                        perform: perform)
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

    /// Markup on iPad shows the numbered strip of pages beside the
    /// document, as the design target does; it goes back with Done.
    private func startMarkup() {
        if editing { finishEditing() }
        markup = true
        if !compact, !showingThumbnails {
            showingThumbnails = true
            thumbnailsForMarkup = true
        }
    }

    /// Edit PDF opens on the text, with the markup put away: the two lay
    /// their own gestures over the same pages, so only one is ever in hand.
    private func startEditing() {
        if markup { finishMarkup() }
        editing = true
    }

    private func finishEditing() {
        edit?.cancel()
        edit?.placingArmed = false
        edit?.selectedPicture = nil
        edit?.selectedLink = nil
        edit?.pendingPicture = nil
        editing = false
    }

    /// A picture chosen from Files, read while its security scope is held.
    private func choosePicture(_ result: Result<URL, any Error>) {
        guard let edit else { return }
        switch result {
        case let .success(url):
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let bytes = try? Data(contentsOf: url) else {
                edit.error = "That picture could not be read."
                return
            }
            Task { await edit.choose(picture: bytes, forPage: model.currentPage) }
        case .failure:
            // The person closed the picker: nothing to say.
            break
        }
    }

    private func finishMarkup() {
        editor?.commitInk()
        editor?.tool = nil
        markup = false
        if thumbnailsForMarkup {
            showingThumbnails = false
            thumbnailsForMarkup = false
        }
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
                .accessibilityIdentifier("document.password.hint")
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
                    LabeledContent("Protected") {
                        model.password != nil || model.metadata?.encrypted == true ? Text("Yes") : Text("No")
                    }
                    LabeledContent("Reading direction") {
                        model.isRightToLeft ? Text("Right to left") : Text("Left to right")
                    }
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

private extension View {
    @ViewBuilder
    func colorInvert(if inverted: Bool) -> some View {
        if inverted {
            colorInvert()
        } else {
            self
        }
    }
}
