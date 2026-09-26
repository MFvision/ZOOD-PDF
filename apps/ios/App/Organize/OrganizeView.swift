import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import ZoodCore

/// Organize pages through the engine (`pages.*`): rotate, reorder (drag), delete, insert
/// blank/file, extract. Every step is an incremental update; Undo restores the previous file.
struct OrganizeView: View {
    @Bindable var session: DocumentSession
    @Environment(\.dismiss) private var dismiss
    @State private var selection: Set<Int> = []
    @State private var insertingFile = false
    @State private var extracted: URL?
    @State private var rangeText = ""
    @State private var rangeError: String?

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 16)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    rangeField
                    LazyVGrid(columns: columns, spacing: 18) {
                        ForEach(0..<session.pageCount, id: \.self) { index in
                            PageCell(session: session, index: index, selected: selection.contains(index))
                                .onTapGesture { toggle(index) }
                                .draggable(String(index))
                                .dropDestination(for: String.self) { items, _ in
                                    guard let from = items.first.flatMap(Int.init) else { return false }
                                    let moving = selection.contains(from) ? selection.sorted() : [from]
                                    guard !moving.contains(index) else { return false }
                                    // pages.move's `to` counts the pages that are not moving:
                                    // land where the target page was (after it when moving forward).
                                    let restBefore = (0..<index).filter { !moving.contains($0) }.count
                                    let to = restBefore + (from < index ? 1 : 0)
                                    Task {
                                        await session.move(moving, to: to)
                                        selection = []
                                    }
                                    return true
                                }
                                .contextMenu { pageMenu(index) }
                        }
                    }
                }
                .padding(16)
            }
            .background(AppBackdrop())
            .navigationTitle(Text(ToolKind.organize.title))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("common.undo") { Task { await session.undoLast() } }.disabled(!session.canUndo)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("common.done") { dismiss() }
                }
                ToolbarItemGroup(placement: .bottomBar) { bottomBar }
            }
            .fileImporter(isPresented: $insertingFile, allowedContentTypes: [.pdf]) { result in
                if case .success(let url) = result {
                    let at = (selection.max() ?? (session.pageCount - 1)) + 1
                    Task { await session.insertFile(url, at: at) }
                }
            }
            .sheet(item: Binding(get: { extracted.map(IdentifiedURL.init) }, set: { extracted = $0?.url })) { item in
                ActivityView(items: [item.url])
            }
            .overlay { if session.isBusy { ProgressView().padding(20).glass() } }
            .onChange(of: session.revision) { _, _ in
                selection = selection.filter { $0 < session.pageCount }
            }
        }
    }

    private var rangeField: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                TextField("organize.range.placeholder", text: $rangeText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(selectRange)
                    .accessibilityIdentifier("organize.range")
                Button("organize.range.select", action: selectRange).disabled(rangeText.isEmpty)
            }
            if let rangeError { Text(verbatim: rangeError).font(.caption).foregroundStyle(.red) }
            Text("organize.selected \(selection.count)").font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var bottomBar: some View {
        let pages = selection.sorted()
        Button { Task { await session.rotate(pages, by: -90) } } label: { Label("organize.rotateLeft", systemImage: "rotate.left") }
            .disabled(pages.isEmpty)
        Button { Task { await session.rotate(pages, by: 90) } } label: { Label("organize.rotateRight", systemImage: "rotate.right") }
            .disabled(pages.isEmpty)
        Spacer()
        Menu {
            Button("organize.insertBlank", systemImage: "doc.badge.plus") {
                let at = (selection.max() ?? (session.pageCount - 1)) + 1
                Task { await session.insertBlank(at: at) }
            }
            Button("organize.insertFile", systemImage: "doc.on.doc") { insertingFile = true }
        } label: {
            Label("organize.insert", systemImage: "plus.rectangle.on.rectangle")
        }
        Button {
            Task { extracted = await session.extract(pages) }
        } label: {
            Label("organize.extract", systemImage: "square.and.arrow.up.on.square")
        }
        .disabled(pages.isEmpty)
        Spacer()
        Button(role: .destructive) {
            Task {
                await session.delete(pages)
                selection = []
            }
        } label: {
            Label("organize.delete", systemImage: "trash")
        }
        .disabled(pages.isEmpty)
    }

    @ViewBuilder private func pageMenu(_ index: Int) -> some View {
        Button("organize.rotateRight", systemImage: "rotate.right") { Task { await session.rotate([index], by: 90) } }
        Button("organize.insertBlankAfter", systemImage: "doc.badge.plus") { Task { await session.insertBlank(at: index + 1) } }
        Button("organize.extract", systemImage: "square.and.arrow.up.on.square") { Task { extracted = await session.extract([index]) } }
        Button("organize.delete", systemImage: "trash", role: .destructive) { Task { await session.delete([index]) } }
    }

    private func toggle(_ index: Int) {
        if selection.contains(index) { selection.remove(index) } else { selection.insert(index) }
    }

    private func selectRange() {
        do {
            selection = Set(try PageRanges.parse(rangeText, pageCount: session.pageCount))
            rangeError = nil
        } catch {
            rangeError = error.localizedMessage
        }
    }
}

extension PageRanges.ParseError {
    var localizedMessage: String {
        switch self {
        case .empty: String(localized: "range.error.empty")
        case .invalid(let t): String(localized: "range.error.invalid \(t)")
        case .outOfRange(let p, let n): String(localized: "range.error.outOfRange \(p) \(n)")
        case .reversed(let t): String(localized: "range.error.reversed \(t)")
        }
    }
}

struct IdentifiedURL: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// One page thumbnail (rendered by PDFKit) with its number in the locale's digits.
struct PageCell: View {
    let session: DocumentSession
    let index: Int
    let selected: Bool
    @State private var image: UIImage?

    var body: some View {
        VStack(spacing: 6) {
            Group {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                } else {
                    Color(uiColor: .systemBackground)
                }
            }
            .frame(height: 140)
            .frame(maxWidth: .infinity)
            .background(Color(uiColor: .systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: selected ? 3 : 1))
            .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
            Text(index + 1, format: .number).font(.caption.monospacedDigit())
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(selected ? Color.accentColor : Color.clear, in: Capsule())
                .foregroundStyle(selected ? Color.white : Color.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("organize.pageLabel \(index + 1)"))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .task(id: "\(session.revision)-\(index)") {
            guard let page = session.pdf?.page(at: index) else { return }
            image = page.thumbnail(of: CGSize(width: 220, height: 280), for: .cropBox)
        }
    }
}
