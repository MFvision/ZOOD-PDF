import SwiftUI
import WarraqCore

/// A bookmark of the document's outline, as the core lists it: a flat
/// list in reading order, each entry with its depth, its title (Arabic
/// read right), the page or nothing for a heading, and how many entries
/// under it are its children.
struct OutlineEntry: Decodable, Sendable {
    let title: String
    let depth: Int
    let page: Int?
    let outside: Bool
    let open: Bool
    let children: Int
}

/// The outline as a tree, built from the flat list by depth.
struct OutlineNode: Identifiable {
    let id: Int
    let entry: OutlineEntry
    let kids: [OutlineNode]

    /// `List(children:)` wants nil for a leaf.
    var optionalKids: [OutlineNode]? { kids.isEmpty ? nil : kids }

    static func tree(from entries: [OutlineEntry]) -> [OutlineNode] {
        var index = 0
        func take(depth: Int) -> [OutlineNode] {
            var nodes: [OutlineNode] = []
            while index < entries.count, entries[index].depth == depth {
                let id = index
                let entry = entries[index]
                index += 1
                let kids = entry.children > 0 ? take(depth: depth + 1) : []
                nodes.append(OutlineNode(id: id, entry: entry, kids: kids))
            }
            // Entries deeper than expected (a damaged outline) are skipped.
            while index < entries.count, entries[index].depth > depth {
                index += 1
            }
            return nodes
        }
        return take(depth: 0)
    }
}

/// The document's outline (its bookmarks) as a tree; tapping an entry
/// goes to its page. Read by the core (`outline.list`), which reads the
/// titles' encodings PDFKit gets wrong.
struct OutlineSheet: View {
    let model: DocumentModel
    @Environment(\.dismiss) private var dismiss
    @State private var nodes: [OutlineNode]?
    @State private var failed = false

    var body: some View {
        AppSheet(title: "Outline") {
            Group {
                if let nodes {
                    if nodes.isEmpty {
                        EmptyState(symbol: "list.bullet.indent", title: "No outline", message: "This document carries no bookmarks.")
                    } else {
                        List(nodes, children: \.optionalKids) { node in
                            row(node)
                        }
                        .listStyle(.plain)
                        .accessibilityIdentifier("outline.list")
                    }
                } else if failed {
                    EmptyState(symbol: "list.bullet.indent", title: "No outline", message: "The outline could not be read.")
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .task {
            struct Args: Encodable { let password: String? }
            struct Answer: Decodable { let bookmarks: [OutlineEntry] }
            do {
                let reply = try await Core.callStatic(op: "outline.list", args: Args(password: model.password), blobs: [model.bytes])
                let answer: Answer = try reply.decode()
                nodes = OutlineNode.tree(from: answer.bookmarks)
            } catch {
                failed = true
            }
        }
    }

    @ViewBuilder
    private func row(_ node: OutlineNode) -> some View {
        let entry = node.entry
        if let page = entry.page, !entry.outside {
            Button {
                model.currentPage = page
                dismiss()
            } label: {
                HStack {
                    Text(entry.title)
                        .foregroundStyle(Surface.label)
                    Spacer()
                    Text(page + 1, format: .number)
                        .font(TextStyle.caption)
                        .tabularNumbers()
                        .foregroundStyle(Surface.secondaryLabel)
                }
            }
            .accessibilityIdentifier("outline.\(node.id)")
        } else {
            HStack {
                Text(entry.title)
                    .foregroundStyle(entry.outside ? Surface.secondaryLabel : Surface.label)
                if entry.outside {
                    Spacer()
                    Image(systemName: "arrow.up.forward.square")
                        .foregroundStyle(Surface.tertiaryLabel)
                        .accessibilityLabel(Text("Leads outside the document"))
                }
            }
            .accessibilityIdentifier("outline.\(node.id)")
        }
    }
}
