import Foundation
import Observation
import PDFKit
import WarraqCore

/// One hit of a search, as the core answered it: the page, the words, the
/// words around them on the line, and the glyphs' boxes in stored space.
struct SearchHit: Decodable, Identifiable, Equatable, Sendable {
    let page: Int
    let text: String
    let before: String
    let after: String
    let rects: [StoredRect]

    var id: String { "\(page):\(before)|\(text)|\(after):\(rects.first.map { "\($0.x),\($0.y)" } ?? "")" }
}

/// Search in the open document, answered by the core's `view.search` —
/// diacritics ignored, alef, taa marbuta and yaa forms unified, digits in
/// either script — with the hits highlighted by PDFKit and walked with
/// next and previous.
@MainActor @Observable
final class DocumentSearch {
    var query = ""
    private(set) var hits: [SearchHit] = []
    private(set) var total = 0
    private(set) var current = 0
    private(set) var searching = false
    /// The hits as PDFKit selections, for its highlight drawing; one per
    /// hit, nil where PDFKit found no glyphs in the box.
    private(set) var selections: [PDFSelection?] = []
    private var task: Task<Void, Never>?

    var hasHits: Bool { !hits.isEmpty }
    var currentHit: SearchHit? { hits.indices.contains(current) ? hits[current] : nil }
    var currentSelection: PDFSelection? { selections.indices.contains(current) ? selections[current] : nil }
    var highlighted: [PDFSelection] { selections.compactMap { $0 } }

    /// Runs the search, cancelling one still running.
    func run(in model: DocumentModel) {
        task?.cancel()
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, let core = model.engine else {
            clear()
            return
        }
        searching = true
        task = Task {
            struct Args: Encodable { let query: String }
            struct Answer: Decodable { let matches: [SearchHit]; let total: Int }
            do {
                let reply = try await core.call(op: "view.search", args: Args(query: query))
                let answer: Answer = try reply.decode()
                guard !Task.isCancelled else { return }
                hits = answer.matches
                total = answer.total
                current = 0
                // PDFKit draws every hit it can; past a thousand, the list still names them.
                selections = hits.prefix(1000).map { Self.selection(for: $0, in: model.pdf) }
            } catch {
                hits = []
                total = 0
                selections = []
            }
            searching = false
        }
    }

    func clear() {
        task?.cancel()
        hits = []
        total = 0
        current = 0
        selections = []
        searching = false
    }

    func next() {
        guard !hits.isEmpty else { return }
        current = (current + 1) % hits.count
    }

    func previous() {
        guard !hits.isEmpty else { return }
        current = (current - 1 + hits.count) % hits.count
    }

    func go(to index: Int) {
        guard hits.indices.contains(index) else { return }
        current = index
    }

    /// The PDFKit selection covering a hit's boxes: the glyphs PDFKit
    /// finds inside them, which is what its highlight draws and what
    /// `go(to:)` scrolls to.
    static func selection(for hit: SearchHit, in pdf: PDFDocument?) -> PDFSelection? {
        guard let pdf, let page = pdf.page(at: hit.page), !hit.rects.isEmpty else { return nil }
        let frame = PageSpace.Frame(page: page)
        var whole: PDFSelection?
        for rect in hit.rects {
            let user = PageSpace.userRect(fromStored: rect.cgRect, in: frame).insetBy(dx: -0.5, dy: -0.5)
            guard let part = page.selection(for: user), !part.string.isNilOrEmpty else { continue }
            if let whole {
                whole.add(part)
            } else {
                whole = part
            }
        }
        return whole
    }

    /// The hits' boxes on a page in user space, for a view that draws them
    /// itself where PDFKit finds no glyphs (a scan's invisible text layer).
    static func userRects(of hits: [SearchHit], on pageIndex: Int, in pdf: PDFDocument?) -> [CGRect] {
        guard let pdf, let page = pdf.page(at: pageIndex) else { return [] }
        let frame = PageSpace.Frame(page: page)
        return hits.filter { $0.page == pageIndex }
            .flatMap(\.rects)
            .map { PageSpace.userRect(fromStored: $0.cgRect, in: frame) }
    }
}

private extension String? {
    var isNilOrEmpty: Bool { self?.isEmpty ?? true }
}
