import Foundation
import ImageIO
import UIKit
import WarraqCore

/// PDFs made by the core from what the person hands over: pictures become
/// pages (`create.images`), files are joined (`pages.combine`). Used by the
/// scan entry, the share extension's pictures and the "Make a PDF" intent.
enum PDFMaker {
    /// The largest side a picture is kept at before it becomes a page: a
    /// photo straight from the camera is far more than a page needs.
    static let maxPixels = 2600

    /// One page per picture, at the picture's own size, upright by EXIF.
    static func pdf(fromPictures pictures: [Data]) async throws -> Data {
        struct Args: Encodable {
            let paper = "own"
            let orientation = "auto"
            let margin = 0
        }
        let prepared = pictures.compactMap(prepare)
        guard !prepared.isEmpty else { throw CoreError.arguments("no picture could be read") }
        let reply = try await Core.callStatic(op: "create.images", args: Args(), blobs: prepared)
        guard let bytes = reply.blobs.first else { throw CoreError.badReply("create.images answered no bytes") }
        return bytes
    }

    /// The files' pages one after another. Pictures are turned into pages
    /// first, so a mix of PDFs and photos becomes one PDF.
    static func pdf(fromFiles files: [(name: String, bytes: Data)]) async throws -> Data {
        var parts: [Data] = []
        for file in files {
            if file.bytes.starts(with: Data("%PDF".utf8)) {
                parts.append(file.bytes)
            } else if LibraryFileKind.imageExtensions.contains((file.name as NSString).pathExtension.lowercased()) || isPicture(file.bytes) {
                parts.append(try await pdf(fromPictures: [file.bytes]))
            }
        }
        guard !parts.isEmpty else { throw CoreError.arguments("nothing given was a PDF or a picture") }
        if parts.count == 1 { return parts[0] }
        let reply = try await Core.callStatic(op: "pages.combine", args: "{}", blobs: parts)
        guard let bytes = reply.blobs.first else { throw CoreError.badReply("pages.combine answered no bytes") }
        return bytes
    }

    private static func isPicture(_ bytes: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return false }
        return CGImageSourceGetCount(source) > 0
    }

    /// The picture bounded in size and upright, as JPEG.
    static func prepare(_ bytes: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceShouldCache: false,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image).jpegData(compressionQuality: 0.85)
    }

}
