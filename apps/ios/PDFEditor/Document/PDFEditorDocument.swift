import SwiftUI
import UniformTypeIdentifiers

/// The document a `DocumentGroup` scene opens: a PDF handed over by Files,
/// Mail, Safari or "Open in". It wraps a `DocumentModel`; what gets written
/// back is the model's bytes — the original with the core's incremental
/// update on top — whenever the scene saves (after an edit registered with
/// its undo manager).
///
/// A picture handed over the same way (JPEG, PNG, HEIC, TIFF…) opens as a
/// one-page PDF of itself, the picture fitted on A4, and the document
/// offers the scanner for it; the picture itself is never written over.
///
/// SwiftUI reads and snapshots documents on the main thread and writes them
/// off it; the model is main-actor state, so the two main-thread steps say so.
@MainActor
final class PDFEditorDocument: ReferenceFileDocument {
    typealias Snapshot = Data

    nonisolated static let readableContentTypes: [UTType] = [.pdf, .image]
    nonisolated static let writableContentTypes: [UTType] = [.pdf]

    let model: DocumentModel
    /// Opened from a picture, not a PDF.
    nonisolated let fromPicture: Bool

    nonisolated init(configuration: ReadConfiguration) throws {
        guard let bytes = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let name = configuration.file.filename.map { ($0 as NSString).deletingPathExtension } ?? "Document"
        if configuration.contentType.conforms(to: .image) {
            guard let image = ScanPipeline.loadImage(from: bytes), let pdf = PicturePDF.make(from: image) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            fromPicture = true
            model = MainActor.assumeIsolated {
                let model = DocumentModel(bytes: pdf, name: name)
                model.sourceImage = image
                return model
            }
        } else {
            fromPicture = false
            model = MainActor.assumeIsolated {
                DocumentModel(bytes: bytes, name: name)
            }
        }
    }

    nonisolated func snapshot(contentType: UTType) throws -> Data {
        MainActor.assumeIsolated { model.bytes }
    }

    nonisolated func fileWrapper(snapshot: Data, configuration: WriteConfiguration) throws -> FileWrapper {
        // PDF bytes are never written over a picture.
        guard !fromPicture else { throw CocoaError(.fileWriteUnsupportedScheme) }
        return FileWrapper(regularFileWithContents: snapshot)
    }
}
