import SwiftUI
import WarraqCore

/// A bookmark of the document's outline, as the core lists it: the title
/// (Arabic read right), the page, or nothing for a heading, and its children.
struct OutlineEntry: Decodable, Identifiable, Sendable {
    let title: String
    let page: Int?
    let outside: Bool
    let children: [OutlineEntry]

    var id: String { "\(title)@\(page ?? -1)#\(children.count)" }

    var hasChildren: Bool { !children.isEmpty }
}

/// The document's outline (its bookmarks) as a tree; tapping an entry
/// goes to its page. Read by the core (`outline.list`), which reads the
/// titles' encodings PDFKit gets wrong.
struct OutlineSheet: View {
    let model: DocumentModel
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [OutlineEntry]?
    @State private var failed = false

    var body: some View {
        AppSheet(title: "Outline") {
            Group {
                if let entries {
                    if entries.isEmpty {
                        EmptyState(symbol: "list.bullet.indent", title: "No outline", message: "This document carries no bookmarks.")
                    } else {
                        List(entries, children: \.optionalChildren) { entry in
                            row(entry)
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
                entries = answer.bookmarks
            } catch {
                failed = true
            }
        }
    }

    @ViewBuilder
    private func row(_ entry: OutlineEntry) -> some View {
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
            .accessibilityIdentifier("outline.\(page)")
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
        }
    }
}

private extension OutlineEntry {
    var optionalChildren: [OutlineEntry]? { hasChildren ? children : nil }
}
