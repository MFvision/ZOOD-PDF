import CoreGraphics
import UIKit

/// A picture as a one-page PDF, the way a photo opened from Files or
/// "Open in" is shown before the scanner has read it: the picture fitted
/// on A4 (turned to the picture's way) and centred, as the core's
/// `create.images` places it — drawn by UIKit here because a document is
/// read synchronously, before the core is asked anything.
enum PicturePDF {
    static func make(from image: CGImage) -> Data? {
        let pixels = CGSize(width: image.width, height: image.height)
        guard pixels.width > 0, pixels.height > 0 else { return nil }
        let placement = ScanExporter.placement(of: pixels)
        let bounds = CGRect(origin: .zero, size: placement.paper)
        let renderer = UIGraphicsPDFRenderer(bounds: bounds)
        let data = renderer.pdfData { context in
            context.beginPage()
            let rect = CGRect(x: placement.offset.x, y: placement.offset.y,
                              width: pixels.width * placement.scale, height: pixels.height * placement.scale)
            UIImage(cgImage: image).draw(in: rect)
        }
        return data.isEmpty ? nil : data
    }
}
