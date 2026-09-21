import PDFKit
import SwiftUI
import WarraqCore

/// A document on screen: PDFKit draws the pages; the toolbar's title block
/// names the file and the page; Info shows what the core read; Share hands
/// the bytes as they stand to the share sheet; Save appears once there is
/// something to save.
///
/// The page view is one accessibility element whose value is the current
/// page's text in logical order from the core — so VoiceOver reads Arabic
/// as it is read, which PDFKit alone does not promise.
struct DocumentView: View {
    @Bindable var model: DocumentModel
    @Environment(\.undoManager) private var undoManager
    @State private var showingInfo = false
    @State private var saveError: String?
    @State private var pageText: String?
    @State private var showingScanner = false
    @State private var scanSaved: URL?

    var body: some View {
        content
            .navigationTitle(model.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .toolbarRole(.editor)
            .sheet(isPresented: $showingInfo) {
                DocumentInfoSheet(model: model)
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
            .alert("Saved to My documents", isPresented: Binding(get: { scanSaved != nil }, set: { if !$0 { scanSaved = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(verbatim: scanSaved?.lastPathComponent ?? "")
            }
            .alert("Could not save", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(saveError ?? "")
            }
            .task(id: model.id) {
                if model.state == .loading {
                    await model.load()
                }
            }
            .task(id: textKey) {
                pageText = await model.text(ofPage: model.currentPage)
            }
    }

    /// When the page's text must be read again: another page, an edit, or
    /// the document just became ready.
    private struct TextKey: Hashable {
        let page: Int
        let edited: Bool
        let ready: Bool
    }

    private var textKey: TextKey {
        TextKey(page: model.currentPage, edited: model.isEdited, ready: model.isReady)
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
            if let pdf = model.pdf {
                PDFKitView(document: pdf, displaysRTL: model.isRightToLeft, currentPage: $model.currentPage)
                    .ignoresSafeArea(edges: .bottom)
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
                Button("Save", systemImage: "square.and.arrow.down") {
                    Task {
                        do {
                            try await model.save()
                        } catch {
                            saveError = error.localizedDescription
                        }
                    }
                }
                .accessibilityIdentifier("document.save")
            }
            ShareLink(item: SharedPDF(model: model), preview: SharePreview(model.name, image: Image(systemName: "doc.richtext")))
                .disabled(!model.isReady)
                .accessibilityIdentifier("document.share")
            Button("Info", systemImage: "info.circle") {
                showingInfo = true
            }
            .disabled(!model.isReady)
            .accessibilityIdentifier("document.info")
        }
    }

    private var status: Text? {
        guard model.isReady else { return nil }
        let page = Text("Page \(model.currentPage + 1) of \(model.pageCount)")
        return model.isEdited ? page + Text(verbatim: " — ") + Text("Edited") : page
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

/// What the core read from the file: its own information, and which engine
/// draws it.
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
                    LabeledContent("Protected") {
                        model.metadata?.encrypted == true ? Text("Yes") : Text("No")
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

    private func row(_ label: LocalizedStringKey, _ value: String?) -> some View {
        LabeledContent(label) {
            Text(value?.isEmpty == false ? value! : "—")
                .foregroundStyle(value?.isEmpty == false ? Surface.label : Surface.tertiaryLabel)
                .multilineTextAlignment(.trailing)
        }
    }
}
