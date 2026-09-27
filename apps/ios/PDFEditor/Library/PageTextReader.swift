import CoreGraphics
import Foundation

/// A word read off a page picture, as the Library's index takes it: the
/// text and which line of the page it was on.
struct IndexedWord: Sendable, Equatable {
    var text: String
    var line: Int
}

/// The one seam between the Library and text recognition: a picture in,
/// words out. The scanner's own recognizer (`PDFEditor/Scan/TextRecognizer`,
/// Vision) stands behind it; a test puts its own reader in its place.
protocol PageTextReading: Sendable {
    /// Reads the words on `image`. `languages` are short codes ("ar", "en").
    func read(_ image: CGImage, languages: [String]) async throws -> [IndexedWord]
}

enum PageOCR {
    @MainActor static var reader: any PageTextReading = ScannerPageTextReader()

    /// The languages the index reads scans with: the ones chosen in the
    /// scanner's settings, Arabic and English unless chosen otherwise.
    static var languages: [String] {
        let stored = UserDefaults.standard.string(forKey: SettingsKey.ocrLanguages) ?? "ar,en"
        let chosen = stored.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return chosen.isEmpty ? ["ar", "en"] : chosen
    }

    /// The page's lines, in reading order, from its words.
    static func lines(of words: [IndexedWord]) -> [String] {
        var byLine: [Int: [String]] = [:]
        for word in words {
            byLine[word.line, default: []].append(word.text)
        }
        return byLine.keys.sorted().compactMap { line in
            let text = byLine[line, default: []].joined(separator: " ")
            return text.isEmpty ? nil : text
        }
    }
}

/// The scanner's recognizer, read as words with their lines.
struct ScannerPageTextReader: PageTextReading {
    func read(_ image: CGImage, languages: [String]) async throws -> [IndexedWord] {
        let supported = TextRecognizer.supportedLanguages()
        let wanted = TextRecognizer.languages(chosen: languages, supported: supported)
        let sendable = SendableImage(image)
        return try await withCheckedThrowingContinuation { continuation in
            // Vision holds its thread for the whole page: a queue of its own.
            Self.queue.async {
                do {
                    let recognition = try TextRecognizer.recognize(sendable.image, languages: wanted)
                    let ordered = TextRecognizer.readingOrder(recognition.lines)
                    var words: [IndexedWord] = []
                    for (index, line) in ordered.enumerated() {
                        for word in line.words where !word.text.isEmpty {
                            words.append(IndexedWord(text: word.text, line: index))
                        }
                    }
                    continuation.resume(returning: words)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static let queue = DispatchQueue(label: "app.warraq.ios.library.ocr", qos: .utility)

    /// A CGImage is immutable; this only says so to the compiler.
    private struct SendableImage: @unchecked Sendable {
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }
}
