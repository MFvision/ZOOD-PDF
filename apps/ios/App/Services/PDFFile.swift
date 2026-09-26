import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// A PDF that can be dragged between windows (and to/from other apps). Imports are copied into
/// a private temporary folder, because the system deletes the received file after the drop.
struct PDFFile: Transferable, Sendable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .pdf) { file in
            SentTransferredFile(file.url)
        } importing: { received in
            let dir = FileManager.default.temporaryDirectory
                .appendingPathComponent("Dropped", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = dir.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: dest)
            return PDFFile(url: dest)
        }
    }
}
