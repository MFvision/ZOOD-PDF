import CoreImage
import CoreImage.CIFilterBuiltins
import CoreText
import UIKit
import Vision
import ZoodCore

/// CGImage wrapper that can cross actor boundaries (CGImage is immutable).
struct ScanImage: @unchecked Sendable {
    let cg: CGImage
    var size: Size2 { Size2(Double(cg.width), Double(cg.height)) }
}

/// One recognised line: text plus its box, normalised to the image with the origin top-left.
struct OCRLine: Sendable {
    let text: String
    let box: Rect2
}

/// One output page.
enum ScanPage: Sendable {
    case image(ScanImage, [OCRLine])
    case idCard(front: ScanImage, back: ScanImage, frontLines: [OCRLine], backLines: [OCRLine])

    var preview: ScanImage {
        switch self {
        case .image(let i, _): i
        case .idCard(let f, _, _, _): f
        }
    }
}

// MARK: - OCR (Vision)

enum OCRService {
    /// Arabic support is checked at RUNTIME: it depends on the iOS version and the recognition
    /// revision, and `supportedRecognitionLanguages()` is the only reliable answer.
    static func supportedLanguages() -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.revision = VNRecognizeTextRequestRevision3
        return (try? request.supportedRecognitionLanguages()) ?? []
    }

    static var arabicAvailable: Bool {
        supportedLanguages().contains { $0.lowercased().hasPrefix("ar") }
    }

    static func recognize(_ image: ScanImage) async -> [OCRLine] {
        await Task.detached(priority: .userInitiated) { () -> [OCRLine] in
            let supported = supportedLanguages()
            var languages: [String] = []
            if let ar = supported.first(where: { $0.lowercased().hasPrefix("ar") }) { languages.append(ar) }
            if let en = supported.first(where: { $0.hasPrefix("en") }) { languages.append(en) }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.revision = VNRecognizeTextRequestRevision3
            request.usesLanguageCorrection = true
            if !languages.isEmpty { request.recognitionLanguages = languages }
            let handler = VNImageRequestHandler(cgImage: image.cg, options: [:])
            do { try handler.perform([request]) } catch { return [] }
            return (request.results ?? []).compactMap { obs in
                guard let best = obs.topCandidates(1).first else { return nil }
                let b = obs.boundingBox // normalised, origin bottom-left
                return OCRLine(text: best.string, box: Rect2(x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height))
            }
        }.value
    }
}

// MARK: - Image processing

enum ScanProcessor {
    /// Find the page outline in a still image (pixels, y-down). nil when nothing convincing.
    static func detectQuad(_ image: ScanImage) async -> Quad? {
        await Task.detached(priority: .userInitiated) { () -> Quad? in
            let request = VNDetectRectanglesRequest()
            request.minimumConfidence = 0.6
            request.minimumAspectRatio = 0.3
            request.maximumObservations = 1
            request.minimumSize = 0.2
            let handler = VNImageRequestHandler(cgImage: image.cg, options: [:])
            guard (try? handler.perform([request])) != nil, let r = request.results?.first else { return nil }
            func p(_ c: CGPoint) -> Point2 { Point2(Double(c.x), Double(c.y)) }
            return Quad.fromVision(
                topLeft: p(r.topLeft), topRight: p(r.topRight), bottomRight: p(r.bottomRight), bottomLeft: p(r.bottomLeft),
                imageSize: image.size)
        }.value
    }

    /// Perspective-correct the quad (pixels, y-down) and apply the mode's clean-up.
    static func correct(_ image: ScanImage, quad: Quad, mode: DeepLink.ScanMode) async -> ScanImage? {
        await Task.detached(priority: .userInitiated) { () -> ScanImage? in
            let h = Double(image.cg.height)
            func v(_ p: Point2) -> CGPoint { CGPoint(x: p.x, y: h - p.y) } // Core Image is y-up
            let filter = CIFilter.perspectiveCorrection()
            filter.inputImage = CIImage(cgImage: image.cg)
            filter.topLeft = v(quad.topLeft)
            filter.topRight = v(quad.topRight)
            filter.bottomRight = v(quad.bottomRight)
            filter.bottomLeft = v(quad.bottomLeft)
            guard var out = filter.outputImage else { return nil }
            if mode == .whiteboard { out = whiteboard(out) }
            let context = CIContext()
            guard let cg = context.createCGImage(out, from: out.extent.integral) else { return nil }
            return ScanImage(cg: cg)
        }.value
    }

    /// Whiteboard: lift the grey background towards white and boost marker contrast/saturation.
    static func whiteboard(_ input: CIImage) -> CIImage {
        let exposure = CIFilter.exposureAdjust()
        exposure.inputImage = input
        exposure.ev = 0.6
        let controls = CIFilter.colorControls()
        controls.inputImage = exposure.outputImage ?? input
        controls.contrast = 1.6
        controls.saturation = 1.4
        controls.brightness = 0.05
        let sharpen = CIFilter.unsharpMask()
        sharpen.inputImage = controls.outputImage ?? input
        sharpen.radius = 2
        sharpen.intensity = 0.6
        return sharpen.outputImage ?? input
    }

    /// Book: split a corrected spread into two pages, in reading order.
    static func splitBook(_ spread: ScanImage, rightToLeft: Bool) -> [ScanImage] {
        ScanLayout.bookPages(spread: spread.size, rightToLeft: rightToLeft).compactMap { r in
            spread.cg.cropping(to: CGRect(x: r.x, y: r.y, width: r.width, height: r.height)).map(ScanImage.init)
        }
    }

    /// Upright pixels for a camera/photo UIImage (applies its orientation), capped in size.
    static func upright(_ image: UIImage, maxDimension: CGFloat = 4000) -> ScanImage? {
        let s = image.size
        guard s.width > 0, s.height > 0 else { return nil }
        let scale = min(1, maxDimension / max(s.width, s.height))
        let size = CGSize(width: (s.width * scale).rounded(), height: (s.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let img = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return img.cgImage.map(ScanImage.init)
    }
}

// MARK: - PDF

enum ScanPDFBuilder {
    /// Build the PDF: each picture on its own page (shaped like the picture, 595 pt wide), ID
    /// cards front + back at real size on one A4 page, and an invisible OCR text layer so the
    /// scan is searchable and copyable.
    static func build(_ pages: [ScanPage], title: String) -> Data {
        let format = UIGraphicsPDFRendererFormat()
        format.documentInfo = [
            kCGPDFContextTitle as String: title,
            kCGPDFContextCreator as String: "ZOOD PDF",
        ]
        let a4 = CGRect(x: 0, y: 0, width: ScanLayout.a4.width, height: ScanLayout.a4.height)
        let renderer = UIGraphicsPDFRenderer(bounds: a4, format: format)
        return renderer.pdfData { ctx in
            for page in pages {
                switch page {
                case .image(let img, let lines):
                    let w = 595.276
                    let h = w * Double(img.cg.height) / Double(max(img.cg.width, 1))
                    let bounds = CGRect(x: 0, y: 0, width: w, height: min(h, 14_400))
                    ctx.beginPage(withBounds: bounds, pageInfo: [:])
                    draw(img, in: bounds, lines: lines, context: ctx.cgContext)
                case .idCard(let front, let back, let fl, let bl):
                    ctx.beginPage(withBounds: a4, pageInfo: [:])
                    let (f, b) = ScanLayout.idCardFrames()
                    draw(front, in: cgRect(ScanLayout.aspectFit(front.size, in: f)), lines: fl, context: ctx.cgContext)
                    draw(back, in: cgRect(ScanLayout.aspectFit(back.size, in: b)), lines: bl, context: ctx.cgContext)
                }
            }
        }
    }

    static func cgRect(_ r: Rect2) -> CGRect { CGRect(x: r.x, y: r.y, width: r.width, height: r.height) }

    /// Draw the picture, then each OCR line as invisible text stretched over its box.
    static func draw(_ img: ScanImage, in rect: CGRect, lines: [OCRLine], context cg: CGContext) {
        UIImage(cgImage: img.cg).draw(in: rect)
        for line in lines where !line.text.isEmpty {
            let box = CGRect(
                x: rect.minX + line.box.x * rect.width, y: rect.minY + line.box.y * rect.height,
                width: line.box.width * rect.width, height: line.box.height * rect.height)
            guard box.width > 1, box.height > 1 else { continue }
            let font = CTFontCreateUIFontForLanguage(.system, box.height * 0.8, nil)
                ?? CTFontCreateWithName("Helvetica" as CFString, box.height * 0.8, nil)
            let attributed = NSAttributedString(string: line.text, attributes: [.font: font])
            let ctLine = CTLineCreateWithAttributedString(attributed)
            var ascent: CGFloat = 0
            var descent: CGFloat = 0
            let width = CGFloat(CTLineGetTypographicBounds(ctLine, &ascent, &descent, nil))
            guard width > 0 else { continue }
            let vScale = box.height / max(ascent + descent, 1)
            cg.saveGState()
            cg.setTextDrawingMode(.invisible)
            cg.textMatrix = .identity
            // The UIKit PDF context is y-down; Core Text draws y-up: flip around the baseline.
            cg.translateBy(x: box.minX, y: box.maxY - descent * vScale)
            cg.scaleBy(x: box.width / width, y: -vScale)
            cg.textPosition = .zero
            CTLineDraw(ctLine, cg)
            cg.restoreGState()
        }
    }
}

enum SamplePDFBuilder {
    /// A three-page Arabic sample (UI tests / screenshots only; see DemoContent).
    static func arabicSample() -> Data {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 595.276, height: 841.89))
        return renderer.pdfData { ctx in
            for pageNumber in 1...3 {
                ctx.beginPage()
                let para = NSMutableParagraphStyle()
                para.alignment = .right
                para.baseWritingDirection = .rightToLeft
                para.lineSpacing = 6
                let title = NSAttributedString(
                    string: "عقد إيجار سكني — صفحة \(pageNumber)",
                    attributes: [.font: UIFont.boldSystemFont(ofSize: 22), .paragraphStyle: para])
                title.draw(in: CGRect(x: 60, y: 70, width: 475, height: 40))
                let body = NSAttributedString(
                    string: "إنه في يوم الأحد الموافق ١٤٤٨/٠٣/١٤هـ تم الاتفاق بين المؤجر والمستأجر على استئجار الوحدة السكنية الموضحة أدناه وفق الشروط التالية. يلتزم المستأجر بسداد الإيجار في موعده، والمحافظة على العين المؤجرة، وعدم إجراء أي تعديل عليها إلا بموافقة خطية من المؤجر.",
                    attributes: [.font: UIFont.systemFont(ofSize: 15), .paragraphStyle: para])
                body.draw(in: CGRect(x: 60, y: 130, width: 475, height: 600))
            }
        }
    }
}
