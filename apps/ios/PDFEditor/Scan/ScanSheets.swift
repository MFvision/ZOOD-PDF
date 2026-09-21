import SwiftUI

/// The enhancement, one page at a time or for all: colour, grey or black
/// and white; each pipeline step a switch; and a button held down to see
/// the photo as it was — the stage above the sheet shows the result of
/// every change the moment it is made.
struct EnhancePanel: View {
    @Bindable var session: ScanSession
    let pageID: UUID
    @State private var enhancement: Enhancement
    @State private var applyToAll = false

    init(session: ScanSession, pageID: UUID) {
        self.session = session
        self.pageID = pageID
        _enhancement = State(initialValue: session.page(pageID)?.enhancement ?? Enhancement())
    }

    var body: some View {
        AppSheet(title: "Enhance") {
            Form {
                Section {
                    Picker("Colour", selection: $enhancement.mode) {
                        Label("Colour", systemImage: "paintpalette").tag(ScanColorMode.color)
                        Label("Grey", systemImage: "circle.lefthalf.filled").tag(ScanColorMode.grey)
                        Label("Black and white", systemImage: "circle.fill").tag(ScanColorMode.blackAndWhite)
                    }
                    .pickerStyle(.segmented)
                    .labelStyle(.titleOnly)
                    .accessibilityIdentifier("enhance.mode")
                }
                Section {
                    Toggle("Level the page", isOn: $enhancement.deskew)
                        .accessibilityIdentifier("enhance.deskew")
                    Toggle("Even out shadows and stains", isOn: $enhancement.flattenLighting)
                        .accessibilityIdentifier("enhance.lighting")
                    Toggle("Smooth creases", isOn: $enhancement.smoothCreases)
                        .accessibilityIdentifier("enhance.creases")
                    Toggle("Sharpen", isOn: $enhancement.sharpen)
                        .accessibilityIdentifier("enhance.sharpen")
                    Toggle("Ink to black, paper to white", isOn: $enhancement.autoContrast)
                        .accessibilityIdentifier("enhance.contrast")
                    if session.mode == .book {
                        Toggle("Flatten the page's curve", isOn: $enhancement.flattenCurvature)
                            .accessibilityIdentifier("enhance.curvature")
                    }
                } header: {
                    Text("Steps")
                } footer: {
                    if let page = session.page(pageID) {
                        stepsFooter(page)
                    }
                }
                Section {
                    HoldToCompareButton(isHeld: $session.previewOriginal)
                    Toggle("Apply to every page", isOn: $applyToAll)
                        .accessibilityIdentifier("enhance.all")
                }
            }
            .accessibilityIdentifier("enhance.form")
        }
        .onChange(of: enhancement) { _, changed in
            if applyToAll {
                session.setEnhancementForAll(changed)
            } else {
                session.setEnhancement(changed, for: pageID)
            }
        }
        .onChange(of: applyToAll) { _, all in
            if all { session.setEnhancementForAll(enhancement) }
        }
        .onDisappear { session.previewOriginal = false }
        .sensoryFeedback(.selection, trigger: enhancement)
    }

    @ViewBuilder
    private func stepsFooter(_ page: ScanPage) -> some View {
        if page.skew != 0 || page.bow != nil {
            VStack(alignment: .leading, spacing: Space.x1) {
                if page.skew != 0 {
                    Text("Levelled by \(page.skew, format: .number.precision(.fractionLength(1)))°.")
                }
                if let bow = page.bow {
                    if bow >= 1.5 {
                        Text("The lines were bowed by \(Int(bow.rounded())) pixels; they are straightened column by column. The letters' squeeze near the gutter stays.")
                    } else {
                        Text("The lines are straight; nothing to flatten.")
                    }
                } else if session.mode == .book, page.enhancement.flattenCurvature, !page.isProcessing {
                    Text("Too few lines of text were found to measure the page's curve; it is left as it is.")
                }
            }
        } else {
            Text("Shadows, stains and uneven light are divided away; creases lighter than 82 % grey are smoothed. A fold that hides the ink cannot be brought back.")
        }
    }
}

/// Pressed and held, the stage shows the photo as it was, cut out but not
/// enhanced; let go, the enhanced page comes back. Feedback on touch-down.
struct HoldToCompareButton: View {
    @Binding var isHeld: Bool

    var body: some View {
        Label(isHeld ? "Showing the original" : "Hold to compare with the original", systemImage: isHeld ? "eye.fill" : "eye")
            .foregroundStyle(isHeld ? Color.accentColor : Surface.label)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in if !isHeld { isHeld = true } }
                    .onEnded { _ in isHeld = false }
            )
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(Text("Hold to see the photo before enhancement"))
            .accessibilityIdentifier("enhance.original")
    }
}

/// The text Vision read off the pages: read on demand, shown to copy,
/// share or keep as a note beside the scan, with the languages the device
/// reads named — and Arabic's absence said plainly where it is absent.
struct ScanTextSheet: View {
    @Bindable var session: ScanSession
    @State private var reading = false
    @State private var savedNote: URL?
    @State private var copied = 0

    var body: some View {
        AppSheet(title: "Text") {
            Group {
                if let text = session.recognizedText, !text.isEmpty {
                    ScrollView {
                        Text(text)
                            .font(TextStyle.body)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(Space.x5)
                            .accessibilityIdentifier("text.body")
                    }
                    .safeAreaInset(edge: .bottom) {
                        HStack(spacing: Space.x4) {
                            Button("Copy", systemImage: "doc.on.doc") {
                                UIPasteboard.general.string = text
                                copied += 1
                            }
                            .accessibilityIdentifier("text.copy")
                            ShareLink(item: text) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                            .accessibilityIdentifier("text.share")
                            Button("Save as note", systemImage: "note.text.badge.plus") {
                                savedNote = try? session.saveText(named: ScanSession.defaultName())
                            }
                            .accessibilityIdentifier("text.note")
                        }
                        .buttonStyle(.bordered)
                        .labelStyle(.titleAndIcon)
                        .padding(Space.x4)
                        .frame(maxWidth: .infinity)
                        .background(.bar)
                    }
                } else if reading || session.isBusy {
                    ProgressView("Reading the text…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if session.recognizedText != nil {
                    EmptyState(symbol: "text.page.slash", title: "No text was read", message: "Nothing on these pages was recognised as text.")
                } else {
                    ContentUnavailableView {
                        Label("Read the text", systemImage: "text.viewfinder")
                    } description: {
                        Text("Vision reads the words on every page. The PDF gets them as a searchable layer when it is saved.")
                    } actions: {
                        Button("Read text") {
                            reading = true
                            Task {
                                _ = await session.recognize()
                                reading = false
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("text.read")
                    }
                }
            }
            .safeAreaInset(edge: .top) {
                languagesLine
            }
        }
        .alert("Saved as a note", isPresented: Binding(get: { savedNote != nil }, set: { if !$0 { savedNote = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(savedNote?.lastPathComponent ?? "")
        }
        .sensoryFeedback(.success, trigger: copied)
    }

    private var languagesLine: some View {
        VStack(alignment: .leading, spacing: Space.x1) {
            Text("Reads: \(session.readingLanguageNames)")
            if !session.readsArabic {
                Text("Arabic is not among the languages this device's text recognition supports.")
                    .foregroundStyle(.orange)
            }
        }
        .font(TextStyle.caption)
        .foregroundStyle(Surface.secondaryLabel)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Space.x5)
        .padding(.vertical, Space.x3)
        .background(.bar)
        .accessibilityIdentifier("scan.languages")
    }
}

/// Saving: the file's name, whether to read the text into the PDF, and
/// which languages that reads.
struct SaveScanSheet: View {
    @Bindable var session: ScanSession
    let onSaved: (URL) -> Void
    @State private var name = ScanSession.defaultName()
    @State private var saving = false
    @State private var failure: String?

    var body: some View {
        AppSheet(title: "Save as PDF") {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .submitLabel(.done)
                        .accessibilityIdentifier("save.name")
                }
                Section {
                    Toggle("Recognise the text", isOn: $session.ocrEnabled)
                        .accessibilityIdentifier("save.ocr")
                } footer: {
                    VStack(alignment: .leading, spacing: Space.x1) {
                        Text("The words become an invisible, searchable layer over the pages. Reads: \(session.readingLanguageNames).")
                        if !session.readsArabic {
                            Text("Arabic is not among the languages this device's text recognition supports.")
                        }
                    }
                }
                Section {
                    Button {
                        save()
                    } label: {
                        HStack {
                            if saving {
                                ProgressView()
                                    .padding(.trailing, Space.x3)
                                Text(session.busyMessage ?? "Saving…")
                            } else {
                                Text("Save")
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(saving || session.pages.isEmpty)
                    .accessibilityIdentifier("save.confirm")
                }
                Section {
                    LabeledContent("Pages") {
                        Text(session.mode.composesOnePage ? 1 : session.pages.count, format: .number)
                            .tabularNumbers()
                    }
                    LabeledContent("Paper", value: "A4")
                }
            }
            .accessibilityIdentifier("save.form")
        }
        .interactiveDismissDisabled(saving)
        .alert("Could not save", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
    }

    private func save() {
        saving = true
        Task {
            do {
                let url = try await session.savePDF(named: name)
                saving = false
                onSaved(url)
            } catch {
                saving = false
                failure = error.localizedDescription
            }
        }
    }
}
