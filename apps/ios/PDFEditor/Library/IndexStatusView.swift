import SwiftUI

/// The line above the grid that says where the index stands: reading, with
/// the file and a Stop; or how many documents are indexed, with Index now.
struct IndexStatusView: View {
    let library: LibraryModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let indexer = library.indexer {
            Group {
                if let progress = indexer.progress {
                    running(progress)
                } else {
                    idle(indexer)
                }
            }
            .font(TextStyle.caption)
            .padding(.horizontal, Space.x5)
            .padding(.vertical, Space.x3)
            .background(Surface.grouped, in: RoundedRectangle(cornerRadius: Radius.group, style: .continuous))
            .padding(.horizontal, Space.x5)
            .padding(.top, Space.x3)
            .animation(Motion.travel(reduceMotion: reduceMotion), value: indexer.progress == nil)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("library.indexStatus")
        }
    }

    private func running(_ progress: IndexingProgress) -> some View {
        HStack(spacing: Space.x4) {
            ProgressView(value: progress.fraction)
                .progressViewStyle(.linear)
                .frame(maxWidth: 160)
            VStack(alignment: .leading, spacing: 1) {
                Text(stage(progress))
                    .lineLimit(1)
                Text("\(progress.done) of \(progress.total)")
                    .foregroundStyle(Surface.secondaryLabel)
                    .tabularNumbers()
            }
            Spacer(minLength: 0)
            Button("Stop", systemImage: "stop.fill") {
                library.stopIndexing()
            }
            .labelStyle(.titleOnly)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityIdentifier("library.stopIndexing")
        }
    }

    private func stage(_ progress: IndexingProgress) -> String {
        switch progress.stage {
        case .listing: String(localized: "Listing the files…")
        case .reading: String(localized: "Reading \(progress.current)")
        case let .recognizing(page, of): String(localized: "Recognizing \(progress.current) — page \(page) of \(of)")
        case .saving: String(localized: "Saving the index…")
        }
    }

    private func idle(_ indexer: LibraryIndexer) -> some View {
        HStack(spacing: Space.x4) {
            Image(systemName: "text.magnifyingglass")
                .foregroundStyle(Surface.secondaryLabel)
            VStack(alignment: .leading, spacing: 1) {
                Text("\(indexer.stats.documents) documents indexed")
                    .tabularNumbers()
                    .accessibilityValue(Text(verbatim: "\(indexer.stats.documents)"))
                    .accessibilityIdentifier("library.indexedCount")
                if let summary = indexer.summary {
                    Text(describe(summary))
                        .foregroundStyle(Surface.secondaryLabel)
                        .lineLimit(1)
                } else if let error = indexer.error {
                    Text(error)
                        .foregroundStyle(.red)
                        .lineLimit(1)
                } else {
                    Text("Search finds words inside every document here, in Arabic or English.")
                        .foregroundStyle(Surface.secondaryLabel)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Button("Index now", systemImage: "arrow.clockwise") {
                library.indexNow()
            }
            .labelStyle(.titleOnly)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityIdentifier("library.indexNow")
        }
    }

    private func describe(_ summary: IndexingSummary) -> String {
        var parts: [String] = []
        if summary.added > 0 { parts.append(String(localized: "\(summary.added) read")) }
        if summary.unchanged > 0 { parts.append(String(localized: "\(summary.unchanged) unchanged")) }
        if summary.recognized > 0 { parts.append(String(localized: "\(summary.recognized) pages recognized")) }
        if summary.skipped > 0 { parts.append(String(localized: "\(summary.skipped) skipped")) }
        if summary.forgotten > 0 { parts.append(String(localized: "\(summary.forgotten) removed")) }
        if summary.stopped { parts.append(String(localized: "stopped")) }
        if parts.isEmpty { parts.append(String(localized: "Nothing new")) }
        return parts.joined(separator: " · ")
    }
}
