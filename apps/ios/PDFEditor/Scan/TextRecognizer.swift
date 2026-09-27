import CoreGraphics
import Foundation
import Vision

/// A word Vision read, and where: its box in pixels from the picture's
/// top-left corner.
struct RecognizedWord: Sendable, Equatable, Codable {
    let text: String
    let box: CGRect
    let confidence: Float
}

/// A line as Vision read it: its words, its box, and which way it reads.
struct RecognizedLine: Sendable, Equatable {
    let text: String
    let box: CGRect
    let words: [RecognizedWord]
    let confidence: Float
    let isRightToLeft: Bool
}

/// What Vision read off one page, lines in reading order.
struct Recognition: Sendable, Equatable {
    var lines: [RecognizedLine]
    /// The languages Vision was asked to read.
    var languages: [String]
    var imageSize: CGSize

    static let empty = Recognition(lines: [], languages: [], imageSize: .zero)

    var words: [RecognizedWord] { lines.flatMap(\.words) }
    var text: String { lines.map(\.text).joined(separator: "\n") }
    var isEmpty: Bool { lines.isEmpty }
}

/// Vision's text recognition (`VNRecognizeTextRequest`), the words placed
/// for the core's text layer. Which languages it reads is the device's
/// answer, asked at runtime and shown in the interface: nothing is
/// promised that Vision here does not do.
enum TextRecognizer {
    /// The languages Vision recognises on this device, as it names them
    /// ("en-US", "ar-SA", …), for the accurate level.
    static func supportedLanguages() -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        return (try? request.supportedRecognitionLanguages()) ?? []
    }

    /// Whether a language ("ar", "en") is among the supported ones.
    static func supports(_ language: String, in supported: [String]) -> Bool {
        let wanted = language.lowercased()
        return supported.contains { $0.lowercased() == wanted || $0.lowercased().hasPrefix(wanted + "-") || $0.lowercased().hasPrefix(wanted + "_") }
    }

    /// The languages to read with: those chosen that the device supports,
    /// else Arabic and English where supported, else the device's first.
    static func languages(chosen: [String], supported: [String]) -> [String] {
        let wanted = chosen.isEmpty ? ["ar", "en"] : chosen
        var out: [String] = []
        for language in wanted {
            if let match = supported.first(where: { $0.lowercased() == language.lowercased() || $0.lowercased().hasPrefix(language.lowercased() + "-") }) {
                out.append(match)
            }
        }
        if out.isEmpty, let first = supported.first {
            out.append(first)
        }
        return out
    }

    /// The human name of a Vision language code, in the interface's language.
    static func name(of code: String) -> String {
        Locale.current.localizedString(forIdentifier: code) ?? code
    }

    /// Reads the page. `languages` are Vision's own codes; an empty list
    /// lets Vision decide.
    static func recognize(_ image: CGImage, languages: [String], accurate: Bool = true) throws -> Recognition {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = accurate ? .accurate : .fast
        request.usesLanguageCorrection = true
        if languages.isEmpty {
            request.automaticallyDetectsLanguage = true
        } else {
            request.recognitionLanguages = languages
        }
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])
        let size = CGSize(width: image.width, height: image.height)
        var lines: [RecognizedLine] = []
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first, !candidate.string.isEmpty else { continue }
            let text = candidate.string
            var words: [RecognizedWord] = []
            var wordStart: String.Index?
            var index = text.startIndex
            func closeWord(at end: String.Index) {
                guard let start = wordStart else { return }
                let range = start..<end
                let word = String(text[range])
                if let box = try? candidate.boundingBox(for: range) {
                    words.append(RecognizedWord(text: word, box: pixels(box.boundingBox, in: size), confidence: candidate.confidence))
                }
                wordStart = nil
            }
            while index < text.endIndex {
                if text[index].isWhitespace {
                    closeWord(at: index)
                } else if wordStart == nil {
                    wordStart = index
                }
                index = text.index(after: index)
            }
            closeWord(at: text.endIndex)
            guard !words.isEmpty else { continue }
            lines.append(RecognizedLine(text: text, box: pixels(observation.boundingBox, in: size), words: words,
                                        confidence: candidate.confidence, isRightToLeft: readsRightToLeft(text)))
        }
        return Recognition(lines: readingOrder(lines), languages: languages, imageSize: size)
    }

    /// Vision's normalized box (from the bottom-left) as pixels from the top-left.
    private static func pixels(_ box: CGRect, in size: CGSize) -> CGRect {
        CGRect(x: box.minX * size.width, y: (1 - box.maxY) * size.height,
               width: box.width * size.width, height: box.height * size.height)
    }

    /// Whether the first letter with a direction is Arabic (or Hebrew).
    static func readsRightToLeft(_ text: String) -> Bool {
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x0590...0x08FF, 0xFB1D...0xFDFF, 0xFE70...0xFEFF:
                return true
            case 0x0041...0x005A, 0x0061...0x007A, 0x00C0...0x024F, 0x0370...0x058F:
                return false
            default:
                continue
            }
        }
        return false
    }

    /// Lines top to bottom; lines on one row (their centres within half a
    /// line of each other) right to left when the row reads that way.
    static func readingOrder(_ lines: [RecognizedLine]) -> [RecognizedLine] {
        let byTop = lines.sorted { $0.box.midY < $1.box.midY }
        var rows: [[RecognizedLine]] = []
        for line in byTop {
            if var row = rows.last, let reference = row.first,
               abs(line.box.midY - reference.box.midY) < max(reference.box.height, line.box.height) * 0.5 {
                row.append(line)
                rows[rows.count - 1] = row
            } else {
                rows.append([line])
            }
        }
        return rows.flatMap { row -> [RecognizedLine] in
            let rtl = row.count { $0.isRightToLeft } * 2 > row.count
            return row.sorted { rtl ? $0.box.midX > $1.box.midX : $0.box.midX < $1.box.midX }
        }
    }

    /// The share of the truth's words of three letters or more — tashkeel
    /// ignored, the Arabic-aware way — that were read: the corpus measure.
    static func wordAccuracy(read: String, truth: String) -> (found: Int, total: Int) {
        let readWords = Set(read.split(whereSeparator: \.isWhitespace).map { normalized(String($0)) })
        var total = 0, found = 0
        for word in truth.split(whereSeparator: \.isWhitespace) {
            let normal = normalized(String(word))
            guard normal.unicodeScalars.count >= 3 else { continue }
            total += 1
            if readWords.contains(normal) { found += 1 }
        }
        return (found, total)
    }

    /// A word without tashkeel or tatweel, punctuation trimmed, alef forms,
    /// taa marbuta and yaa unified, Arabic-Indic digits western, lower case.
    static func normalized(_ word: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in word.unicodeScalars {
            switch scalar.value {
            case 0x064B...0x065F, 0x0670, 0x06D6...0x06ED, 0x0640:
                continue
            case 0x0622, 0x0623, 0x0625, 0x0671:
                scalars.append(UnicodeScalar(0x0627)!)
            case 0x0629:
                scalars.append(UnicodeScalar(0x0647)!)
            case 0x0649:
                scalars.append(UnicodeScalar(0x064A)!)
            case 0x0660...0x0669:
                scalars.append(UnicodeScalar(0x0030 + scalar.value - 0x0660)!)
            case 0x06F0...0x06F9:
                scalars.append(UnicodeScalar(0x0030 + scalar.value - 0x06F0)!)
            default:
                scalars.append(scalar)
            }
        }
        let trimmed = String(scalars).trimmingCharacters(in: .punctuationCharacters.union(.symbols))
        return trimmed.lowercased()
    }
}
