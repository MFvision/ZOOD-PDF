import Foundation
import Observation
import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import WarraqCore

/// The pages of a document as things to organize: each operation is one
/// of the core's `pages.*` ops on the open document — an incremental update
/// the original bytes wait under until Save — with a step of undo.
@MainActor @Observable
final class PagesModel {
    let model: DocumentModel
    var selection: Set<Int> = []
    private(set) var working = false
    /// What went wrong, shown once: one of the app's own messages (a key
    /// of the String Catalog) or the core's.
    var error: LocalizedStringKey?
    /// A file that came out (extracted or split pages), ready to share.
    var produced: [URL] = []
    weak var undoManager: UndoManager?
    /// The interface's language, for the words in a produced file's name.
    var locale: Locale = .current

    init(model: DocumentModel) {
        self.model = model
    }

    var pageCount: Int { model.pageCount }
    var selected: [Int] { selection.sorted() }

    // MARK: - Reordering

    /// The `pages.reorder` order when the pages `moving` (in their current
    /// places) drop before `target` (a current index, or `count` for the
    /// end): `order[k]` is the current index of the page that becomes page k.
    static func order(moving: [Int], before target: Int, count: Int) -> [Int] {
        let moving = moving.filter { $0 >= 0 && $0 < count }.sorted()
        guard !moving.isEmpty else { return Array(0..<count) }
        let movingSet = Set(moving)
        let staying = (0..<count).filter { !movingSet.contains($0) }
        // Where the target lands among the pages that stay.
        let place = staying.filter { $0 < target }.count
        var order = staying
        order.insert(contentsOf: moving, at: place)
        return order
    }

    func move(_ pages: [Int], before target: Int) {
        let order = Self.order(moving: pages, before: target, count: pageCount)
        guard order != Array(0..<pageCount) else { return }
        struct Args: Encodable { let order: [Int] }
        run("pages.reorder", Args(order: order)) { [weak self] in
            self?.selection = []
        }
    }

    // MARK: - Turning, deleting, inserting

    func rotate(_ pages: [Int], quarterTurns: Int) {
        guard !pages.isEmpty else { return }
        struct Args: Encodable { let pages: [Int]; let quarterTurns: Int }
        run("pages.rotate", Args(pages: pages, quarterTurns: quarterTurns))
    }

    func delete(_ pages: [Int]) {
        guard !pages.isEmpty, pages.count < pageCount else {
            error = "A document keeps at least one page."
            return
        }
        struct Args: Encodable { let pages: [Int] }
        run("pages.delete", Args(pages: pages)) { [weak self] in
            self?.selection = []
        }
    }

    /// A blank page after `after` (or first, for -1), the size of its neighbour.
    func insertBlank(after: Int) {
        struct Args: Encodable { let at: Int; let like: Int }
        run("pages.insert_blank", Args(at: after + 1, like: max(after, 0)))
    }

    /// Another PDF's pages at `at`.
    func insert(pdf bytes: Data, password: String? = nil, at: Int) {
        struct Args: Encodable { let at: Int; let password: String? }
        run("pages.insert_file", Args(at: at, password: password), blobs: [bytes])
    }

    /// Pictures as pages at `at`: the core makes a PDF of them first
    /// (`create.images`, each upright by its EXIF orientation), then inserts it.
    func insert(pictures: [Data], at: Int) {
        guard !pictures.isEmpty else { return }
        working = true
        Task {
            do {
                struct Args: Encodable { let paper = "own"; let orientation = "auto" }
                let made = try await Core.callStatic(op: "create.images", args: Args(), blobs: pictures)
                guard let pdf = made.blobs.first else { throw CoreError.badReply("create.images answered no file") }
                struct Insert: Encodable { let at: Int; let password: String? }
                try await model.apply("pages.insert_file", args: Insert(at: at, password: nil), blobs: [pdf], undoManager: undoManager)
            } catch {
                self.error = Self.describe(error)
            }
            working = false
        }
    }

    // MARK: - Taking pages out

    /// The chosen pages as a new file, in that order, written beside the
    /// document's name.
    func extract(_ pages: [Int]) {
        guard !pages.isEmpty else { return }
        working = true
        Task {
            do {
                let url = try await extractFile(pages, name: "\(model.name) – \(String(localized: "pages", locale: locale)) \(pages.map { String($0 + 1) }.joined(separator: ","))")
                produced = [url]
            } catch {
                self.error = Self.describe(error)
            }
            working = false
        }
    }

    /// Every `every` pages a file: "name 1.pdf", "name 2.pdf", …
    func split(every: Int) {
        let step = max(every, 1)
        guard pageCount > step else {
            error = "There is nothing to split at that size."
            return
        }
        working = true
        Task {
            do {
                var files: [URL] = []
                var start = 0
                var part = 1
                while start < pageCount {
                    let pages = Array(start..<min(start + step, pageCount))
                    files.append(try await extractFile(pages, name: "\(model.name) \(part)"))
                    start += step
                    part += 1
                }
                produced = files
            } catch {
                self.error = Self.describe(error)
            }
            working = false
        }
    }

    private func extractFile(_ pages: [Int], name: String) async throws -> URL {
        guard let core = await model.readyEngine() else { throw CoreError.closed }
        struct Args: Encodable { let pages: [Int] }
        let reply = try await core.call(op: "pages.extract", args: Args(pages: pages))
        guard let bytes = reply.blobs.first else { throw CoreError.badReply("pages.extract answered no file") }
        let folder = FileManager.default.temporaryDirectory.appending(path: "pages-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: "\(name).pdf")
        try bytes.write(to: url)
        return url
    }

    // MARK: - Cropping

    struct Margins: Encodable, Equatable {
        var top: Float = 0
        var right: Float = 0
        var bottom: Float = 0
        var left: Float = 0
    }

    func crop(_ pages: [Int], margins: Margins) {
        guard !pages.isEmpty else { return }
        struct Args: Encodable { let pages: [Int]; let margins: Margins }
        run("pages.crop", Args(pages: pages, margins: margins))
    }

    // MARK: - Running an operation

    private func run<A: Encodable>(_ op: String, _ args: A, blobs: [Data] = [], then: (() -> Void)? = nil) {
        working = true
        Task {
            do {
                try await model.apply(op, args: args, blobs: blobs, undoManager: undoManager)
                then?()
            } catch {
                self.error = Self.describe(error)
            }
            working = false
        }
    }

    /// An error as the interface says it: the app's own words for the
    /// core's common refusals, else the message as it came.
    static func describe(_ error: any Error) -> LocalizedStringKey {
        if let core = error as? CoreError {
            switch core {
            case .password: return "That file needs its password."
            case .parse: return "That is not a PDF this app can read."
            default: return LocalizedStringKey(core.message)
            }
        }
        if let refusal = error as? Exporter.Refusal {
            return refusal.message
        }
        return LocalizedStringKey(error.localizedDescription)
    }
}
