import SwiftUI

/// Reader mode: the document's text reflowed as the core reads it — every
/// page in logical order, Arabic joined and right-to-left, at the person's
/// text size — for scans whose text layer is invisible and for reading
/// without the layout. A page with no text says so.
struct ReaderModeView: View {
    let model: DocumentModel
    @State private var texts: [Int: String] = [:]
    @State private var loading = true

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.x7) {
                    ForEach(0..<max(model.pageCount, 0), id: \.self) { page in
                        VStack(alignment: .leading, spacing: Space.x3) {
                            Text("Page \(page + 1)")
                                .font(TextStyle.caption)
                                .foregroundStyle(Surface.secondaryLabel)
                                .tabularNumbers()
                            if let text = texts[page] {
                                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                    Text("No text on this page")
                                        .font(TextStyle.body)
                                        .foregroundStyle(Surface.tertiaryLabel)
                                        .italic()
                                } else {
                                    Text(text)
                                        .font(TextStyle.body)
                                        .lineSpacing(6)
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            } else {
                                ProgressView()
                            }
                        }
                        .id(page)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("reader.page.\(page)")
                    }
                }
                .padding(Space.x6)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .background(Surface.window)
            .environment(\.layoutDirection, model.isRightToLeft ? .rightToLeft : .leftToRight)
            .accessibilityIdentifier("document.reader")
            .task(id: model.revision) {
                texts.removeAll()
                for page in 0..<model.pageCount {
                    texts[page] = await model.text(ofPage: page) ?? ""
                }
                loading = false
            }
            .onAppear {
                proxy.scrollTo(model.currentPage, anchor: .top)
            }
        }
    }
}
