import CoreGraphics
import Foundation
import Vision

/// A word read off a picture: its text and its box in the picture's own
/// pixels, `[x0, top, x1, bottom]` with y down — the shape the core's
/// `ocr.add_text_layer` takes. `line` says which line of the page it is
/// on, so a caller can put the lines back together.
public struct RecognizedWord: Codable, Sendable, Equatable {
    public var text: String
    public var bbox: [Double]
    public var line: Int

    public init(text: String, bbox: [Double], line: Int) {
        self.text = text
        self.bbox = bbox
        self.line = line
    }
}

/// The one seam between the Library and OCR: a picture in, words out. The
/// Library reads scans and photographs through it, whichever recognizer
/// stands behind it — Vision here, the scanner's own pipeline once that
/// registers itself as `TextRecognizer.shared`.
public protocol TextRecognizing: Sendable {
    /// Reads the words on `image`. `languages` are BCP-47 codes in order
    /// of preference ("ar", "en"); a recognizer that cannot read one of
    /// them reads with the ones it can.
    func recognize(_ image: CGImage, languages: [String]) async throws -> [RecognizedWord]
}

/// Where the recognizer is kept. Set once, at launch, by whoever has a
/// better one than Vision's.
public enum TextRecognizer {
    @MainActor public static var shared: any TextRecognizing = VisionTextRecognizer()

    /// The lines of a page, from its words, in reading order.
    public static func lines(of words: [RecognizedWord]) -> [String] {
        var lines: [Int: [RecognizedWord]] = [:]
        for word in words {
            lines[word.line, default: []].append(word)
        }
        return lines.keys.sorted().compactMap { line in
            let text = lines[line, default: []].map(\.text).joined(separator: " ")
            return text.isEmpty ? nil : text
        }
    }
}

/// Vision's text recognition. Each observation is a line; its words are
/// cut at spaces and given a share of the line's box in proportion to
/// their length — enough for the index and for a text layer that can be
/// selected, not the scanner's own measured boxes.
public struct VisionTextRecognizer: TextRecognizing {
    public init() {}

    /// The languages Vision can read on this device, as BCP-47 codes.
    public static func supportedLanguages() -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        return (try? request.supportedRecognitionLanguages()) ?? []
    }

    public func recognize(_ image: CGImage, languages: [String]) async throws -> [RecognizedWord] {
        let width = Double(image.width)
        let height = Double(image.height)
        let supported = Self.supportedLanguages()
        let wanted = languages.filter { language in
            supported.contains { $0 == language || $0.hasPrefix(language + "-") || $0.hasPrefix(language + "_") }
        }
        // Vision blocks its thread for the whole page: a queue of its own,
        // so the cooperative pool (and everything else awaiting) is not held.
        let sendableImage = SendableImage(image)
        return try await withCheckedThrowingContinuation { continuation in
            Self.queue.async {
                continuation.resume(with: Result { try Self.read(sendableImage.image, width: width, height: height, languages: wanted) })
            }
        }
    }

    private static let queue = DispatchQueue(label: "app.warraq.ios.vision", qos: .utility)

    /// A CGImage is immutable; this only says so to the compiler.
    private struct SendableImage: @unchecked Sendable {
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    private static func read(_ image: CGImage, width: Double, height: Double, languages wanted: [String]) throws -> [RecognizedWord] {
        do {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            if !wanted.isEmpty {
                request.recognitionLanguages = wanted
            }
            request.automaticallyDetectsLanguage = wanted.isEmpty
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            try handler.perform([request])
            var words: [RecognizedWord] = []
            let observations = (request.results ?? []).sorted { a, b in
                // Top to bottom; Vision's boxes have y up.
                a.boundingBox.maxY > b.boundingBox.maxY
            }
            for (line, observation) in observations.enumerated() {
                guard let candidate = observation.topCandidates(1).first else { continue }
                let box = observation.boundingBox
                let x0 = box.minX * width
                let x1 = box.maxX * width
                let top = (1 - box.maxY) * height
                let bottom = (1 - box.minY) * height
                let pieces = candidate.string.split(separator: " ").map(String.init)
                let total = max(pieces.reduce(0) { $0 + $1.count }, 1)
                var cursor = 0
                let rtl = candidate.string.unicodeScalars.contains { (0x0600...0x06FF).contains($0.value) }
                for piece in pieces {
                    let from = Double(cursor) / Double(total)
                    cursor += piece.count
                    let to = Double(cursor) / Double(total)
                    // Arabic runs right to left: the first word is at the right end.
                    let (a, b) = rtl ? (1 - to, 1 - from) : (from, to)
                    words.append(RecognizedWord(text: piece, bbox: [x0 + (x1 - x0) * a, top, x0 + (x1 - x0) * b, bottom], line: line))
                }
            }
            return words
        }
    }
}
