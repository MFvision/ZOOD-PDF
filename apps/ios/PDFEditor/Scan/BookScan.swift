import CoreGraphics
import Foundation
import Vision

// Book mode: a photo of an open book is one spread — two pages and the
// gutter between them. The gutter is the dark band down the middle where
// the paper falls away from the light; the spread is split there. Each
// half's lines of text bow towards the gutter because the paper curves: the
// bow is measured from the characters Vision finds along each line and the
// columns are slid back up by it. That is as far as Vision and Core Image
// honestly go: the lines come out level; the letters' compression near the
// gutter (the paper seen at a slant) is not undone.

enum BookSplitter {
    /// Where the gutter is, in pixels from the left: the darkest column band
    /// in the middle two fifths of the picture, when it is clearly darker
    /// than the paper. Nil when nothing there stands out.
    static func gutter(of image: CGImage) -> Int? {
        guard let grey = GreyBitmap(image, maxSide: 600), grey.width >= 40 else { return nil }
        let means = grey.columnMeans()
        // Smoothed over 2 % of the width, so one dark stroke is not a gutter.
        let window = max(1, grey.width / 50)
        var smoothed = [Double](repeating: 0, count: grey.width)
        for x in 0..<grey.width {
            let lo = max(0, x - window), hi = min(grey.width - 1, x + window)
            var sum = 0.0
            for i in lo...hi { sum += means[i] }
            smoothed[x] = sum / Double(hi - lo + 1)
        }
        let from = Int(Double(grey.width) * 0.3), to = Int(Double(grey.width) * 0.7)
        var darkest = from
        for x in from...to where smoothed[x] < smoothed[darkest] { darkest = x }
        let paper = smoothed.sorted()[grey.width / 2]
        guard paper > 0, (paper - smoothed[darkest]) / paper > 0.12 else { return nil }
        return Int((Double(darkest) * Double(grey.scale)).rounded())
    }

    /// The spread as two pages, split at the gutter — or down the middle
    /// when no gutter shows — each cut a hair inside the split so the dark
    /// band stays out of both.
    static func split(_ image: CGImage) -> (left: CGImage, right: CGImage, gutter: Int, found: Bool) {
        let found = gutter(of: image)
        let at = found ?? image.width / 2
        let inset = max(2, image.width / 200)
        let leftRect = CGRect(x: 0, y: 0, width: max(8, at - inset), height: image.height)
        let rightRect = CGRect(x: min(image.width - 8, at + inset), y: 0,
                               width: max(8, image.width - (at + inset)), height: image.height)
        let left = image.cropping(to: leftRect) ?? image
        let right = image.cropping(to: rightRect) ?? image
        return (left, right, at, found != nil)
    }
}

enum BookFlattener {
    /// How many columns the bow is measured in across the page.
    static let buckets = 24

    /// The page with its lines' bow taken out, and the bow in pixels (the
    /// most any column had to move); nil bow when too few lines were found
    /// to measure one, the page then left as it is.
    static func flattened(_ image: CGImage) -> (image: CGImage, bow: Double?) {
        let samples = lineSamples(in: image)
        guard let shifts = bowShifts(of: samples, width: CGFloat(image.width)) else {
            return (image, nil)
        }
        let bow = (shifts.max() ?? 0) - (shifts.min() ?? 0)
        guard bow >= 1.5 else { return (image, bow) }
        return (shifted(image, bucketShifts: shifts), bow)
    }

    /// The centres of the characters along each line of text Vision finds,
    /// in pixels from the top-left, one array per line, lines of six
    /// characters or more that span a quarter of the width.
    static func lineSamples(in image: CGImage) -> [[CGPoint]] {
        let request = VNDetectTextRectanglesRequest()
        request.reportCharacterBoxes = true
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        guard (try? handler.perform([request])) != nil, let lines = request.results else { return [] }
        let width = CGFloat(image.width), height = CGFloat(image.height)
        var out: [[CGPoint]] = []
        for line in lines {
            guard let boxes = line.characterBoxes, boxes.count >= 6,
                  line.boundingBox.width * width >= width / 4 else { continue }
            let centres = boxes.map { box in
                CGPoint(x: box.boundingBox.midX * width, y: (1 - box.boundingBox.midY) * height)
            }.sorted { $0.x < $1.x }
            out.append(centres)
        }
        return out
    }

    /// How far below a straight line the ink sits in each column bucket,
    /// the median over the lines: the bow the page's curve gives every line
    /// alike. Nil with fewer than three lines, or when fewer than half the
    /// buckets are seen.
    static func bowShifts(of lines: [[CGPoint]], width: CGFloat) -> [Double]? {
        guard lines.count >= 3, width > 0 else { return nil }
        var residuals = [[Double]](repeating: [], count: buckets)
        for line in lines {
            // Least squares: y = a + b·x.
            let n = Double(line.count)
            var sx = 0.0, sy = 0.0, sxx = 0.0, sxy = 0.0
            for p in line {
                sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y
            }
            let denominator = n * sxx - sx * sx
            guard abs(denominator) > 1e-6 else { continue }
            let b = (n * sxy - sx * sy) / denominator
            let a = (sy - b * sx) / n
            for p in line {
                let bucket = min(buckets - 1, max(0, Int(p.x / width * CGFloat(buckets))))
                residuals[bucket].append(p.y - (a + b * p.x))
            }
        }
        var shifts = [Double?](repeating: nil, count: buckets)
        var seen = 0
        for k in 0..<buckets where residuals[k].count >= 4 {
            let sorted = residuals[k].sorted()
            shifts[k] = sorted[sorted.count / 2]
            seen += 1
        }
        guard seen * 2 >= buckets else { return nil }
        // Buckets no line crossed take the nearest seen neighbour's value.
        var filled = [Double](repeating: 0, count: buckets)
        for k in 0..<buckets {
            if let s = shifts[k] { filled[k] = s; continue }
            var left = k - 1
            while left >= 0, shifts[left] == nil { left -= 1 }
            var right = k + 1
            while right < buckets, shifts[right] == nil { right += 1 }
            switch (left >= 0 ? shifts[left] : nil, right < buckets ? shifts[right] : nil) {
            case let (l?, r?): filled[k] = (l + r) / 2
            case let (l?, nil): filled[k] = l
            case let (nil, r?): filled[k] = r
            default: filled[k] = 0
            }
        }
        // Smoothed over three buckets: the paper's curve is gentle.
        var smooth = filled
        for k in 1..<(buckets - 1) {
            smooth[k] = (filled[k - 1] + filled[k] + filled[k + 1]) / 3
        }
        return smooth
    }

    /// Each column slid up by its bucket's shift (interpolated between
    /// bucket centres, pixels between rows blended), white where the page
    /// runs out.
    static func shifted(_ image: CGImage, bucketShifts: [Double]) -> CGImage {
        let width = image.width, height = image.height
        guard width > 0, height > 0, bucketShifts.count >= 2 else { return image }
        var shifts = [Double](repeating: 0, count: width)
        let bucketWidth = Double(width) / Double(bucketShifts.count)
        for x in 0..<width {
            let position = (Double(x) + 0.5) / bucketWidth - 0.5
            let k = max(0, min(bucketShifts.count - 2, Int(floor(position))))
            let t = max(0, min(1, position - Double(k)))
            shifts[x] = bucketShifts[k] * (1 - t) + bucketShifts[k + 1] * t
        }
        guard let source = RGBABitmap(image) else { return image }
        var out = [UInt8](repeating: 255, count: width * height * 4)
        source.data.withUnsafeBufferPointer { input in
            out.withUnsafeMutableBufferPointer { output in
                for x in 0..<width {
                    let shift = shifts[x]
                    for y in 0..<height {
                        let sy = Double(y) + shift
                        let y0 = Int(floor(sy))
                        let frac = sy - Double(y0)
                        let o = (y * width + x) * 4
                        guard y0 >= -1, y0 < height else { continue }
                        for c in 0..<4 {
                            let a = y0 >= 0 ? Double(input[(y0 * width + x) * 4 + c]) : 255
                            let b = y0 + 1 < height ? Double(input[((y0 + 1) * width + x) * 4 + c]) : 255
                            output[o + c] = UInt8(max(0, min(255, (a * (1 - frac) + b * frac).rounded())))
                        }
                    }
                }
            }
        }
        return RGBABitmap(width: width, height: height, data: out).cgImage ?? image
    }
}

/// A picture as RGBA bytes, row 0 at the top, for the CPU-side warp.
struct RGBABitmap {
    let width: Int
    let height: Int
    var data: [UInt8]

    init?(_ image: CGImage) {
        let width = image.width, height = image.height
        guard width > 0, height > 0, width * height <= 40_000_000 else { return nil }
        var data = [UInt8](repeating: 255, count: width * height * 4)
        let ok = data.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            // Rows top first, as the picture is shown.
            context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard ok else { return nil }
        self.width = width
        self.height = height
        self.data = data
    }

    init(width: Int, height: Int, data: [UInt8]) {
        self.width = width
        self.height = height
        self.data = data
    }

    var cgImage: CGImage? {
        var copy = data
        return copy.withUnsafeMutableBytes { buffer -> CGImage? in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
            // The rows are top first, as a bitmap context's are.
            return context.makeImage()
        }
    }
}
