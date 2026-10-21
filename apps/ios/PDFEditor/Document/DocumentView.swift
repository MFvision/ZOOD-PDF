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
    /// What the screen has open, kept across a fold (`DocumentScreen`).
    @State private var screen: DocumentScreen
    /// How wide the screen is: the half of an unfolded iPhone Duo beside the
    /// Library gets the phone's bars, not the inspectors.
    @State private var width: CGFloat = 0

    init(model: DocumentModel) {
        _model = Bindable(wrappedValue: model)
        _screen = State(initialValue: model.screen)
    }

    // The screen's state by its old names, so the view reads as before.
    private var search: DocumentSearch { screen.search }
    private var host: PDFViewHost { screen.host }
    private var thumbnails: PageThumbnailCache { screen.thumbnails }
    private var editor: AnnotationEditor? { get { screen.editor } nonmutating set { screen.editor = newValue } }
    private var edit: EditModel? { get { screen.edit } nonmutating set { screen.edit = newValue } }
    private var pagesModel: PagesModel? { get { screen.pagesModel } nonmutating set { screen.pagesModel = newValue } }
    private var editing: Bool { get { screen.editing } nonmutating set { screen.editing = newValue } }
    private var showingMarksSheet: Bool { get { screen.showingMarksSheet } nonmutating set { screen.showingMarksSheet = newValue } }
    private var pickingPicture: Bool { get { screen.pickingPicture } nonmutating set { screen.pickingPicture = newValue } }
    private var showingSearch: Bool { get { screen.showingSearch } nonmutating set { screen.showingSearch = newValue } }
    private var showingThumbnails: Bool { get { screen.showingThumbnails } nonmutating set { screen.showingThumbnails = newValue } }
    private var thumbnailsForMarkup: Bool { get { screen.thumbnailsForMarkup } nonmutating set { screen.thumbnailsForMarkup = newValue } }
    private var readerMode: Bool { get { screen.readerMode } nonmutating set { screen.readerMode = newValue } }
    private var markup: Bool { get { screen.markup } nonmutating set { screen.markup = newValue } }
    private var showingInfo: Bool { get { screen.showingInfo } nonmutating set { screen.showingInfo = newValue } }
    private var showingOutline: Bool { get { screen.showingOutline } nonmutating set { screen.showingOutline = newValue } }
    private var showingGoTo: Bool { get { screen.showingGoTo } nonmutating set { screen.showingGoTo = newValue } }
    private var showingPages: Bool { get { screen.showingPages } nonmutating set { screen.showingPages = newValue } }
    private var showingExport: Bool { get { screen.showingExport } nonmutating set { screen.showingExport = newValue } }
    private var showingProtect: Bool { get { screen.showingProtect } nonmutating set { screen.showingProtect = newValue } }
    private var showingCompare: Bool { get { screen.showingCompare } nonmutating set { screen.showingCompare = newValue } }
    private var showingSignatures: Bool { get { screen.showingSignatures } nonmutating set { screen.showingSignatures = newValue } }
    private var showingMarks: Bool { get { screen.showingMarks } nonmutating set { screen.showingMarks = newValue } }
    private var showingStamps: Bool { get { screen.showingStamps } nonmutating set { screen.showingStamps = newValue } }
    private var showingSignature: Bool { get { screen.showingSignature } nonmutating set { screen.showingSignature = newValue } }
    private var showingCrop: Bool { get { screen.showingCrop } nonmutating set { screen.showingCrop = newValue } }
    private var placingSignature: UIImage? { get { screen.placingSignature } nonmutating set { screen.placingSignature = newValue } }
    private var saveError: String? { get { screen.saveError } nonmutating set { screen.saveError = newValue } }
    private var pageText: String? { get { screen.pageText } nonmutating set { screen.pageText = newValue } }
    private var assistant: AIAssistant? { get { screen.assistant } nonmutating set { screen.assistant = newValue } }
    private var autofill: FormAutofillModel? { get { screen.autofill } nonmutating set { screen.autofill = newValue } }
    private var pendingAutofill: FormAutofillModel? { get { screen.pendingAutofill } nonmutating set { screen.pendingAutofill = newValue } }
    private var reader: ReadAloudController { screen.reader }
    private var stampsAdded: Int { get { screen.stampsAdded } nonmutating set { screen.stampsAdded = newValue } }
    private var showingScanner: Bool { get { screen.showingScanner } nonmutating set { screen.showingScanner = newValue } }
    private var scanSaved: URL? { get { screen.scanSaved } nonmutating set { screen.scanSaved = newValue } }
    private var tools: DocumentTools? { get { screen.tools } nonmutating set { screen.tools = newValue } }

    /// The phone's arrangement: a compact size class (iPhone, iPhone Duo
    /// folded), or a pane too narrow for an inspector beside the pages (the
    /// document on one half of an unfolded iPhone Duo, the Library on the other).
    private var compact: Bool { sizeClass == .compact || (width > 0 && width < 520) }

    /// The layout the pages are drawn in: Book (two pages side by side, one
    /// each side of the fold) wants a wide screen, and is Continuous elsewhere.
    private var shownLayout: PageLayout { layout == .book && compact ? .continuous : layout }

    private var layouts: [PageLayout] { PageLayout.allCases.filter { $0 != .book || !compact } }

    // The screen in four parts — the stack of bars and pages, the chrome
    // round it, the sheets and the alerts — each its own expression. Swift 6
    // gives up type-checking one long enough to hold all of them.
    var body: some View {
        toolSheets(on: alerts(on: sheets(on: chrome(on: stack))))
    }

    /// Redact's and Prepare form's sheets and questions, once they exist.
    @ViewBuilder
    private func toolSheets(on view: some View) -> some View {
        if let tools {
            view.modifier(DocumentToolSheets(tools: tools))
        } else {
            view
        }
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
            if let tools, tools.redacting {
                RedactBar(redact: tools.redact, undoManager: undoManager, inspectorShown: !compact,
                          openFind: { tools.showingFind = true },
                          openHidden: { tools.showingHidden = true },
                          openMarks: { tools.showingMarks = true },
                          apply: { tools.askToApply() },
                          done: { tools.finishRedact() })
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if let tools, tools.preparing {
                FormBar(form: tools.form, undoManager: undoManager, inspectorShown: !compact,
                        openFields: { tools.showingFields = true },
                        done: { tools.finishForm() })
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
                if let tools, tools.redacting, !compact {
                    Divider()
                    RedactMarksList(redact: tools.redact)
                        .frame(width: 280)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
                if let tools, tools.preparing, !compact {
                    Divider()
                    FormInspector(form: tools.form)
                        .frame(width: 300)
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
            .animation(Motion.travel(reduceMotion: reduceMotion), value: tools?.redacting)
            .animation(Motion.travel(reduceMotion: reduceMotion), value: tools?.preparing)
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
                    tools = DocumentTools(model: model)
                    tools?.undoManager = undoManager
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
                tools?.undoManager = manager
            }
            // The form's fields, read as Prepare form opens and after each change.
            .task(id: FormKey(preparing: tools?.preparing ?? false, revision: model.revision, ready: model.isReady)) {
                guard let tools, tools.preparing, model.isReady else { return }
                await tools.form.readFields()
            }
            .onChange(of: model.revision) {
                // The bytes changed: the hits' selections belong to the old pages.
                if showingSearch { search.run(in: model) }
            }
            .onChange(of: search.current) {
                if let hit = search.currentHit { model.currentPage = hit.page }
            }
            // Read aloud's bar, under the pages while it reads.
            .safeAreaInset(edge: .bottom) {
                if reader.isActive {
                    ReadAloudBar(reader: reader)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(Motion.travel(reduceMotion: reduceMotion), value: reader.isActive)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            // Read aloud stops when the document leaves the screen — not when
            // a fold puts it on the other screen (`DocumentScreen`).
            .onAppear { screen.appeared() }
            .onDisappear { screen.disappeared() }
    }

    /// Everything the screen puts over itself.
    private func sheets(on view: some View) -> some View {
        view
        .sheet(isPresented: $screen.showingInfo) {
            DocumentInfoSheet(model: model)
        }
        .sheet(isPresented: $screen.showingOutline) {
            OutlineSheet(model: model)
        }
        .sheet(isPresented: $screen.showingGoTo) {
            GoToPageSheet(model: model)
        }
        .sheet(isPresented: $screen.showingPages) {
            if let pagesModel {
                PagesGridView(pages: pagesModel, cache: thumbnails)
            }
        }
        .sheet(isPresented: $screen.showingExport) {
            ExportSheet(model: model)
        }
        .sheet(isPresented: $screen.showingProtect) {
            ProtectSheet(model: model, undoManager: undoManager)
        }
        .fullScreenCover(isPresented: $screen.showingCompare) {
            CompareView(model: model)
                .appEnvironment()
        }
        .sheet(isPresented: $screen.showingSignatures) {
            SignaturesSheet(model: model, undoManager: undoManager)
        }
        .sheet(isPresented: $screen.showingMarks) {
            if let editor {
                AnnotationsListSheet(model: model, editor: editor)
            }
        }
        .sheet(isPresented: $screen.showingCrop) {
            if let pagesModel {
                CropSheet(pages: pagesModel, cache: thumbnails, page: model.currentPage)
            }
        }
        .sheet(isPresented: $screen.showingMarksSheet) {
            PageMarksSheet(model: model, undoManager: undoManager)
        }
        .sheet(item: Binding(get: { edit?.draftLink }, set: { edit?.draftLink = $0 })) { draft in
            if let edit {
                LinkSheet(edit: edit, draft: draft, existing: edit.pickedLink)
            }
        }
        // The picture a new one is placed from, or a picked one replaced with.
        .fileImporter(isPresented: $screen.pickingPicture, allowedContentTypes: [.image]) { result in
            choosePicture(result)
        }
        .sheet(isPresented: $screen.showingStamps) {
            StampSheet(model: model, undoManager: undoManager) {
                stampsAdded += 1
            }
        }
        .sheet(isPresented: $screen.showingSignature) {
            SignatureSheet(store: SignatureStore()) { image in
                editor?.tool = nil
                reader.stop()
                placingSignature = image
            }
        }
        .sheet(item: Binding(get: { editor?.pending }, set: { editor?.pending = $0 })) { placement in
            if let editor {
                NoteSheet(placement: placement, editor: editor)
            }
        }
        // On-device AI: the assistant, then the autofill proposals to review.
        .sheet(item: $screen.assistant, onDismiss: {
            // Autofill's review comes up once the AI sheet has gone: one
            // sheet cannot be shown while another is still leaving.
            if let pending = pendingAutofill {
                pendingAutofill = nil
                autofill = pending
            }
        }) { assistant in
            AIPanel(assistant: assistant) {
                guard let engine = assistant.engine else { return }
                pendingAutofill = FormAutofillModel(model: model, engine: engine, profile: ProfileStore().load())
                self.assistant = nil
            }
        }
        .sheet(item: $screen.autofill) { autofill in
            AutofillReviewSheet(autofill: autofill)
        }
        // A document opened from a picture: the scanner enhances and reads it.
        .fullScreenCover(isPresented: $screen.showingScanner) {
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
            .alert("Cannot read aloud", isPresented: Binding(get: { reader.error != nil }, set: { if !$0 { reader.error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(reader.error ?? "")
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

    /// When Prepare form must read the form again.
    private struct FormKey: Hashable {
        let preparing: Bool
        let revision: Int
        let ready: Bool
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
                PDFKitView(document: pdf, displaysRTL: model.isRightToLeft, layout: shownLayout, night: night,
                           editor: editor, tool: editor?.tool, inkSignature: editor?.inkSignature ?? "",
                           edit: editing ? edit : nil, editSignature: editing ? (edit?.signature ?? "") : "",
                           redact: tools?.redacting == true ? tools?.redact : nil,
                           redactSignature: tools?.redacting == true ? (tools?.redact.signature ?? "") : "",
                           form: tools?.preparing == true ? tools?.form : nil,
                           formSignature: tools?.preparing == true ? (tools?.form.signature ?? "") : "",
                           host: host,
                           highlights: search.highlighted, currentHighlight: showingSearch ? search.currentSelection : nil,
                           currentPage: $model.currentPage, reader: reader)
                    // Night mode: the pages inverted, hues turned back so a
                    // blue heading stays blue (the system's own smart invert).
                    .colorInvert(if: night)
                    .hueRotation(.degrees(night ? 180 : 0))
                    .ignoresSafeArea(edges: showingThumbnails && compact ? [] : .bottom)
                    // One element while the pages are read, so VoiceOver gets
                    // the core's text of the page in logical order; a
                    // container while the editor is open, so the field over
                    // the paragraph is reachable.
                    .accessibilityElement(children: editing || tools?.redacting == true || tools?.preparing == true ? .contain : .ignore)
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
            aiAndReadAloud
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
            // Sign has a button of its own here (the owner looked for it in
            // vain under More); Thumbnails stays in More.
            ToolbarItemGroup(placement: .bottomBar) {
                findAndMarkup
                Spacer()
                Button("Sign", systemImage: "signature") { showingSignatures = true }
                    .disabled(!model.isReady)
                    .accessibilityIdentifier("document.sign")
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

    /// Read aloud, and the AI button — only where Apple's model (or the
    /// Debug fake) answers: nowhere else is there an AI button to press.
    @ViewBuilder
    private var aiAndReadAloud: some View {
        Button("Read aloud", systemImage: reader.isActive ? "speaker.slash" : "speaker.wave.2") {
            if reader.isActive {
                reader.stop()
            } else {
                reader.start(model, from: model.currentPage)
            }
        }
        .disabled(!model.isReady)
        .accessibilityIdentifier("document.readAloud")
        if AIEngines.availability().isAvailable {
            Button("AI", systemImage: "sparkles") {
                // Autofill writes PDFKit's document: no reading highlight in it.
                reader.stop()
                assistant = AIAssistant(model: model)
            }
            .disabled(!model.isReady)
            .accessibilityIdentifier("document.ai")
        }
    }

    private var moreMenu: some View {
        Menu {
            Picker("Layout", selection: $layout) {
                ForEach(layouts) { item in
                    Label(item.title, systemImage: item.symbol).tag(item)
                }
            }
            .pickerStyle(.inline)
            Toggle("Night mode", systemImage: "moon", isOn: $night)
            Toggle("Reader mode", systemImage: "doc.plaintext", isOn: $screen.readerMode)
            if compact {
                Toggle("Thumbnails", systemImage: "rectangle.grid.1x2", isOn: $screen.showingThumbnails)
                    .accessibilityIdentifier("document.thumbnails.toggle")
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
            Button("Redact", systemImage: "rectangle.dashed.badge.record") { startRedact() }
                .keyboardShortcut("r", modifiers: [.command, .option])
                .accessibilityIdentifier("document.redact")
            Button("Prepare form", systemImage: "rectangle.and.pencil.and.ellipsis") { startPrepare() }
                .keyboardShortcut("p", modifiers: [.command, .option])
                .accessibilityIdentifier("document.prepareForm")
            Button("Fill form…", systemImage: "character.textbox") { tools?.showingFill = true }
                .accessibilityIdentifier("document.fillForm")
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
            Button("Compare…", systemImage: "square.split.2x1") { showingCompare = true }
                .accessibilityIdentifier("document.compare")
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
        // Read aloud's highlight is a PDFKit annotation: a mark's commit
        // writes PDFKit's document, so the reading stops first.
        reader.stop()
        closeTools()
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
        reader.stop()
        closeTools()
        editing = true
    }

    /// Redact opens with the other tools put away: they lay their own
    /// gestures over the same pages. Its marks wait in its model.
    private func startRedact() {
        if markup { finishMarkup() }
        if editing { finishEditing() }
        tools?.finishForm(force: true)
        tools?.redacting = true
    }

    private func startPrepare() {
        if markup { finishMarkup() }
        if editing { finishEditing() }
        tools?.finishRedact(force: true)
        tools?.preparing = true
    }

    /// Redact and Prepare form put away; their marks and drafts are kept.
    private func closeTools() {
        tools?.finishRedact(force: true)
        tools?.finishForm(force: true)
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
