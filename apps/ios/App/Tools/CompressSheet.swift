import PDFKit
import SwiftUI
import ZoodCore
import ZoodEngine

/// Compress into a new file next to the original (the original is never rewritten):
/// * Lossless — the engine rewrites the file without earlier revisions and unused objects
///   (`doc.saveFull`), keeping any protection;
/// * Smaller — PDFKit re-encodes images as JPEG and downsamples them for screens
///   (not offered for protected files: PDFKit would drop the password).
/// The smallest result wins; if nothing is smaller, the user is told so and nothing is written.
enum CompressService {
    enum Level: String, CaseIterable, Identifiable {
        case lossless, smaller
        var id: String { rawValue }
    }

    struct Outcome: Sendable {
        let bytes: Data
        let before: Int
        var after: Int { bytes.count }
        var saved: Double { before == 0 ? 0 : 1 - Double(after) / Double(before) }
    }

    static func compress(_ data: Data, password: String?, level: Level) async throws -> Outcome? {
        var candidates: [Data] = []
        let engine = try WarraqEngine(data: data, password: password)
        if let full = try? await engine.call("doc.saveFull").blob0() { candidates.append(full) }
        let encrypted = (try? await engine.info())?.encrypted ?? false
        if level == .smaller, !encrypted, let pdfkit = await pdfKitRewrite(data) { candidates.append(pdfkit) }
        guard let best = candidates.min(by: { $0.count < $1.count }), best.count < data.count else { return nil }
        // Whatever we write must open again in the engine.
        _ = try WarraqEngine(data: best, password: password)
        return Outcome(bytes: best, before: data.count)
    }

    static func pdfKitRewrite(_ data: Data) async -> Data? {
        await Task.detached(priority: .userInitiated) { () -> Data? in
            guard let doc = PDFDocument(data: data), !doc.isEncrypted else { return nil }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).pdf")
            defer { try? FileManager.default.removeItem(at: url) }
            let options: [PDFDocumentWriteOption: Any] = [
                .saveImagesAsJPEGOption: true,
                .optimizeImagesForScreenOption: true,
            ]
            guard doc.write(to: url, withOptions: options) else { return nil }
            return try? Data(contentsOf: url)
        }.value
    }
}

struct CompressSheet: View {
    let session: DocumentSession
    @Environment(\.dismiss) private var dismiss
    @Environment(Library.self) private var library
    @State private var level: CompressService.Level = .smaller
    @State private var working = false
    @State private var result: CompressService.Outcome?
    @State private var noGain = false
    @State private var savedURL: URL?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("compress.level", selection: $level) {
                        Text("compress.level.lossless").tag(CompressService.Level.lossless)
                        Text("compress.level.smaller").tag(CompressService.Level.smaller)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } footer: {
                    Text(level == .lossless ? LocalizedStringKey("compress.level.lossless.footer") : LocalizedStringKey("compress.level.smaller.footer"))
                }
                if let result {
                    Section {
                        LabeledContent("compress.before") { Text(result.before.formatted(.byteCount(style: .file))) }
                        LabeledContent("compress.after") { Text(result.after.formatted(.byteCount(style: .file))) }
                        LabeledContent("compress.saved") { Text(result.saved.formatted(.percent.precision(.fractionLength(0)))) }
                        if let savedURL {
                            ShareLink(item: savedURL) { Label("common.share", systemImage: "square.and.arrow.up") }
                        }
                    }
                }
                if noGain {
                    Text("compress.noGain").foregroundStyle(.secondary)
                }
                if let error {
                    Text(verbatim: error).foregroundStyle(.red)
                }
            }
            .navigationTitle(Text(ToolKind.compress.title))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("common.done") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button("compress.run", action: run).accessibilityIdentifier("compress.run")
                    }
                }
            }
        }
    }

    private func run() {
        working = true
        noGain = false
        error = nil
        Task {
            defer { working = false }
            guard let data = await session.currentBytes() else { return }
            do {
                guard let out = try await CompressService.compress(data, password: session.password, level: level) else {
                    noGain = true
                    return
                }
                let name = FileNaming.derived(from: session.name, suffix: String(localized: "compress.suffix"))
                let url = try DocumentLibrary.saveNew(out.bytes, name: name)
                await library.record(url: url, data: out.bytes)
                result = out
                savedURL = url
            } catch let e as WarraqError {
                self.error = EngineMessages.text(for: e)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
