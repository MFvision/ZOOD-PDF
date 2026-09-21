import PDFKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The pages as a grid: tap to select, drag a page (it lifts) and drop it
/// where it goes; rotate, delete, insert, extract, split, merge and crop
/// from the bar — each an incremental update through the core, undoable.
struct PagesGridView: View {
    @Bindable var pages: PagesModel
    let cache: PageThumbnailCache
    @Environment(\.dismiss) private var dismiss
    @Environment(\.undoManager) private var undoManager
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dragging: Int?
    @State private var dropTarget: Int?
    @State private var showingImporter = false
    @State private var importPassword = ""
    @State private var pendingImport: Data?
    @State private var showingMerge = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var showingCrop = false
    @State private var showingSplit = false
    @State private var splitEvery = 1
    @State private var confirmDelete = false

    private var model: DocumentModel { pages.model }
    private let columns = [GridItem(.adaptive(minimum: 110, maximum: 150), spacing: Space.x5, alignment: .top)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: Space.x6) {
                    ForEach(0..<max(pages.pageCount, 0), id: \.self) { page in
                        cell(page)
                    }
                }
                .padding(Space.x5)
                .animation(Motion.travel(reduceMotion: reduceMotion), value: pages.pageCount)
            }
            .background(Surface.grouped)
            .navigationTitle("Pages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    ToolbarStatus(title: String(localized: "Pages"), subtitle: status)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("pages.done")
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    bottomBar
                }
            }
            .overlay {
                if pages.working {
                    ProgressView()
                        .padding(Space.x6)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                }
            }
            .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.pdf], allowsMultipleSelection: showingMerge) { result in
                handleImport(result)
            }
            .onChange(of: photos) { _, items in
                guard !items.isEmpty else { return }
                Task {
                    var pictures: [Data] = []
                    for item in items {
                        if let data = try? await item.loadTransferable(type: Data.self) {
                            pictures.append(data)
                        }
                    }
                    photos = []
                    pages.insert(pictures: pictures, at: insertionPoint)
                }
            }
            .sheet(isPresented: $showingCrop) {
                CropSheet(pages: pages, cache: cache, page: pages.selected.first ?? model.currentPage)
            }
            .alert("Split into files", isPresented: $showingSplit) {
                TextField("Pages per file", value: $splitEvery, format: .number)
                    .keyboardType(.numberPad)
                Button("Split") { pages.split(every: splitEvery) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Every file takes this many pages, in order.")
            }
            .alert("That file needs its password", isPresented: Binding(get: { pendingImport != nil }, set: { if !$0 { pendingImport = nil } })) {
                SecureField("Password", text: $importPassword)
                Button("Insert") {
                    if let bytes = pendingImport {
                        pages.insert(pdf: bytes, password: importPassword, at: insertionPoint)
                    }
                    pendingImport = nil
                    importPassword = ""
                }
                Button("Cancel", role: .cancel) {
                    pendingImport = nil
                    importPassword = ""
                }
            }
            .confirmationDialog("Delete the selected pages?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete \(pages.selection.count) pages", role: .destructive) {
                    pages.delete(pages.selected)
                }
            }
            .alert("Could not change the pages", isPresented: Binding(get: { pages.error != nil }, set: { if !$0 { pages.error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(pages.error ?? "")
            }
            .sheet(isPresented: Binding(get: { !pages.produced.isEmpty }, set: { if !$0 { pages.produced = [] } })) {
                ProducedFilesSheet(files: pages.produced)
            }
        }
        .onAppear { pages.undoManager = undoManager }
        .sensoryFeedback(.impact(weight: .light), trigger: dragging != nil)
        .sensoryFeedback(.success, trigger: model.revision)
        .accessibilityIdentifier("pages.grid")
    }

    private var status: Text? {
        pages.selection.isEmpty
            ? Text("\(pages.pageCount) pages")
            : Text("\(pages.selection.count) of \(pages.pageCount) selected")
    }

    /// Where a new page goes: after the last selected page, else after
    /// the current one.
    private var insertionPoint: Int {
        (pages.selected.last ?? model.currentPage) + 1
    }

    // MARK: - Cells

    private func cell(_ page: Int) -> some View {
        let selected = pages.selection.contains(page)
        return Button {
            withAnimation(Motion.quick) {
                if selected { pages.selection.remove(page) } else { pages.selection.insert(page) }
            }
        } label: {
            PageThumbnail(model: model, cache: cache, page: page, width: 110, selected: selected, current: page == model.currentPage)
                .overlay(alignment: .topTrailing) {
                    if selected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.white, Color.accentColor)
                            .padding(Space.x2)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .opacity(dragging == page ? 0.35 : 1)
                .overlay(alignment: .leading) {
                    if dropTarget == page {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.accentColor)
                            .frame(width: 4)
                            .offset(x: -Space.x4)
                    }
                }
        }
        .buttonStyle(.pressable)
        .draggable(PageDragItem(page: page)) {
            PageThumbnail(model: model, cache: cache, page: page, width: 90)
                .onAppear { dragging = page }
        }
        .dropDestination(for: PageDragItem.self) { moved, _ in
            dropTarget = nil
            dragging = nil
            let indices = moved.map(\.page)
            let group = pages.selection.contains(indices.first ?? -1) ? pages.selected : indices
            pages.move(group, before: page)
            return true
        } isTargeted: { over in
            dropTarget = over ? page : (dropTarget == page ? nil : dropTarget)
        }
        .contextMenu {
            Button("Rotate right", systemImage: "rotate.right") { pages.rotate([page], quarterTurns: 1) }
            Button("Rotate left", systemImage: "rotate.left") { pages.rotate([page], quarterTurns: -1) }
            Button("Insert blank page after", systemImage: "doc.badge.plus") { pages.insertBlank(after: page) }
            Button("Extract this page", systemImage: "square.and.arrow.up") { pages.extract([page]) }
            Divider()
            Button("Delete", systemImage: "trash", role: .destructive) { pages.delete([page]) }
        }
        .accessibilityLabel(Text("Page \(page + 1)"))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("pages.cell.\(page)")
    }

    // MARK: - The bar

    @ViewBuilder
    private var bottomBar: some View {
        let chosen = pages.selection.isEmpty ? [model.currentPage] : pages.selected
        Button("Rotate", systemImage: "rotate.right") { pages.rotate(chosen, quarterTurns: 1) }
            .accessibilityIdentifier("pages.rotate")
        Spacer()
        Menu {
            Button("Blank page", systemImage: "doc") { pages.insertBlank(after: insertionPoint - 1) }
                .accessibilityIdentifier("pages.insertBlank")
            Button("Pages from a PDF…", systemImage: "doc.on.doc") {
                showingMerge = false
                showingImporter = true
            }
            .accessibilityIdentifier("pages.insertFile")
            PhotosPicker(selection: $photos, matching: .images) {
                Label("Pictures…", systemImage: "photo")
            }
            Button("Merge documents…", systemImage: "rectangle.stack.badge.plus") {
                showingMerge = true
                showingImporter = true
            }
            .accessibilityIdentifier("pages.merge")
        } label: {
            Label("Insert", systemImage: "plus")
        }
        .accessibilityIdentifier("pages.insert")
        Spacer()
        Menu {
            Button("Extract selected pages", systemImage: "square.and.arrow.up") { pages.extract(chosen) }
                .accessibilityIdentifier("pages.extract")
            Button("Split into files…", systemImage: "square.split.2x1") { showingSplit = true }
                .accessibilityIdentifier("pages.split")
            Button("Crop…", systemImage: "crop") { showingCrop = true }
                .accessibilityIdentifier("pages.crop")
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
        .accessibilityIdentifier("pages.more")
        Spacer()
        Button("Delete", systemImage: "trash", role: .destructive) {
            if pages.selection.count > 1 { confirmDelete = true } else { pages.delete(chosen) }
        }
        .disabled(pages.pageCount <= 1)
        .accessibilityIdentifier("pages.delete")
    }

    private func handleImport(_ result: Result<[URL], any Error>) {
        guard case let .success(urls) = result else { return }
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let bytes = try? Data(contentsOf: url) else { continue }
            // A protected file asks for its password first.
            if bytes.range(of: Data("/Encrypt".utf8)) != nil {
                pendingImport = bytes
                continue
            }
            pages.insert(pdf: bytes, at: showingMerge ? pages.pageCount : insertionPoint)
        }
    }
}

/// A page being dragged to a new place in the grid.
struct PageDragItem: Codable, Transferable {
    let page: Int

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .warraqPage)
    }
}

extension UTType {
    /// A page dragged inside the app (declared in the Info.plist).
    static let warraqPage = UTType(exportedAs: "app.warraq.page")
    /// A document dragged out of the Library to open in a window of its own.
    static let warraqDocumentReference = UTType(exportedAs: "app.warraq.document-reference")
}

/// Files an operation produced — extracted or split pages — to share or
/// keep in the Library.
struct ProducedFilesSheet: View {
    let files: [URL]
    @Environment(\.dismiss) private var dismiss
    @State private var saved = false

    var body: some View {
        AppSheet(title: "Files ready") {
            List {
                Section {
                    ForEach(files, id: \.self) { url in
                        ShareLink(item: url) {
                            Label(url.deletingPathExtension().lastPathComponent, systemImage: "doc.richtext")
                        }
                    }
                } footer: {
                    Text("Share a file, or keep them all in My documents.")
                }
                Section {
                    Button(saved ? "Kept in My documents" : "Keep in My documents", systemImage: saved ? "checkmark" : "folder.badge.plus") {
                        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                        for url in files {
                            let destination = LibraryModel().freeName(for: url.lastPathComponent, in: documents)
                            try? FileManager.default.copyItem(at: url, to: destination)
                        }
                        saved = true
                    }
                    .disabled(saved)
                    .accessibilityIdentifier("produced.keep")
                }
            }
            .accessibilityIdentifier("produced.list")
        }
    }
}
