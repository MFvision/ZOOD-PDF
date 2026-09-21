import SwiftUI
import UniformTypeIdentifiers

/// The document a `DocumentGroup` scene opens: a PDF handed over by Files,
/// Mail, Safari or "Open in". It wraps a `DocumentModel`; what gets written
/// back is the model's bytes — the original with the core's incremental
/// update on top — whenever the scene saves (after an edit registered with
/// its undo manager).
///
/// SwiftUI reads and snapshots documents on the main thread and writes them
/// off it; the model is main-actor state, so the two main-thread steps say so.
@MainActor
final class PDFEditorDocument: ReferenceFileDocument {
    typealias Snapshot = Data

    nonisolated static let readableContentTypes: [UTType] = [.pdf]
    nonisolated static let writableContentTypes: [UTType] = [.pdf]

    let model: DocumentModel

    nonisolated init(configuration: ReadConfiguration) throws {
        guard let bytes = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let name = configuration.file.filename.map { ($0 as NSString).deletingPathExtension } ?? "Document"
        model = MainActor.assumeIsolated {
            DocumentModel(bytes: bytes, name: name)
        }
    }

    nonisolated func snapshot(contentType: UTType) throws -> Data {
        MainActor.assumeIsolated { model.bytes }
    }

    nonisolated func fileWrapper(snapshot: Data, configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: snapshot)
    }
}
