import PDFKit
import SwiftUI

/// Every mark in the document — kind, page, words — to go to or delete.
struct AnnotationsListSheet: View {
    let model: DocumentModel
    let editor: AnnotationEditor
    @Environment(\.dismiss) private var dismiss

    private struct Entry: Identifiable {
        let id: Int
        let page: Int
        let annotation: PDFAnnotation
    }

    private var entries: [Entry] {
        editor.annotations.enumerated().map { Entry(id: $0.offset, page: $0.element.page, annotation: $0.element.annotation) }
    }

    var body: some View {
        AppSheet(title: "Marks") {
            let list = entries
            if list.isEmpty {
                EmptyState(symbol: "pencil.and.outline", title: "No marks yet", message: "Highlights, notes, drawings and shapes you add appear here.")
            } else {
                List {
                    ForEach(list) { entry in
                        Button {
                            model.currentPage = entry.page
                            dismiss()
                        } label: {
                            HStack(spacing: Space.x4) {
                                Image(systemName: entry.annotation.kindSymbol)
                                    .foregroundStyle(Color(uiColor: entry.annotation.color))
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: Space.x1) {
                                    Text(entry.annotation.kindTitle)
                                        .font(TextStyle.body)
                                        .foregroundStyle(Surface.label)
                                    if let contents = entry.annotation.contents, !contents.isEmpty {
                                        Text(contents)
                                            .font(TextStyle.subheadline)
                                            .foregroundStyle(Surface.secondaryLabel)
                                            .lineLimit(2)
                                    }
                                }
                                Spacer()
                                Text("Page \(entry.page + 1)")
                                    .font(TextStyle.caption)
                                    .foregroundStyle(Surface.secondaryLabel)
                                    .tabularNumbers()
                            }
                        }
                        .accessibilityIdentifier("mark.\(entry.id)")
                        .swipeActions {
                            Button("Delete", systemImage: "trash", role: .destructive) {
                                editor.remove(entry.annotation)
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .accessibilityIdentifier("marks.list")
            }
        }
    }
}
