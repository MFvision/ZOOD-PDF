import Foundation
import NaturalLanguage
import WarraqCore

/// One sentence of a page as read aloud: its text, its language, and the
/// boxes of the lines it spans on the page (the core's stored space: points
/// from the crop box's top-left, y down), for the highlight.
struct SpokenSentence: Equatable, Sendable {
    let text: String
    let language: String
    let rects: [CGRect]
}

/// The page's text in logical order from the core, cut into sentences,
/// each mapped back onto the lines it came from. A line joins the next only
/// when it wraps — it runs most of the text's width, ends without a mark,
/// and the next line follows close below in the same size — so a heading,
/// a table's row or a form's line is read on its own; the tokenizer then
/// cuts each paragraph at "." "؟" "!" and the rest, and a scrap it cuts
/// off an abbreviation ("ر.س") stays with its sentence.
enum SentenceMap {
    static func sentences(of lines: [TextLine], hint: String? = nil) -> [SpokenSentence] {
        // The lines as paragraphs: each a run of lines with the joined text
        // and where each line lands in it.
        struct Span { let range: Range<String.Index>; let line: TextLine }
        var paragraphs: [(text: String, spans: [Span])] = []
        var text = ""
        var spans: [Span] = []
        func close() {
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                paragraphs.append((text, spans))
            }
            text = ""
            spans = []
        }
        let widest = lines.map { CGFloat($0.width) }.max() ?? 0
        for (index, line) in lines.enumerated() {
            let trimmed = line.text.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                close()
                continue
            }
            let start = text.endIndex
            text += trimmed
            spans.append(Span(range: start..<text.endIndex, line: line))
            let next = lines.indices.contains(index + 1) ? lines[index + 1] : nil
            if endsSentence(trimmed) || next == nil || !wraps(line, into: next!, widest: widest) {
                close()
            } else {
                text += " "
            }
        }
        close()

        var out: [SpokenSentence] = []
        var previousParagraph = -1
        var lastStart: String.Index?
        let tokenizer = NLTokenizer(unit: .sentence)
        for (number, paragraph) in paragraphs.enumerated() {
            tokenizer.string = paragraph.text
            tokenizer.enumerateTokens(in: paragraph.text.startIndex..<paragraph.text.endIndex) { range, _ in
                let sentence = paragraph.text[range].trimmingCharacters(in: .whitespacesAndNewlines)
                guard !sentence.isEmpty else { return true }
                let rects = paragraph.spans
                    .filter { $0.range.overlaps(range) }
                    .map { CGRect(x: CGFloat($0.line.x), y: CGFloat($0.line.y), width: CGFloat($0.line.width), height: CGFloat($0.line.height)) }
                if previousParagraph == number, let last = out.last, let start = lastStart,
                   sentence.unicodeScalars.filter({ $0.properties.isAlphabetic || $0.properties.numericType != nil }).count < 3 {
                    // A scrap cut off an abbreviation: back onto its sentence,
                    // as the page has it ("ر.س", not "ر. س").
                    let joined = paragraph.text[start..<range.upperBound].trimmingCharacters(in: .whitespacesAndNewlines)
                    out[out.count - 1] = SpokenSentence(text: joined, language: last.language,
                                                        rects: last.rects + rects.filter { !last.rects.contains($0) })
                    return true
                }
                out.append(SpokenSentence(text: sentence, language: SpeechLanguage.detect(sentence, hint: hint), rects: rects))
                previousParagraph = number
                lastStart = range.lowerBound
                return true
            }
        }
        return out
    }

    /// True when the text ends with a mark that ends a sentence, in
    /// either script.
    static func endsSentence(_ text: String) -> Bool {
        guard let last = text.unicodeScalars.last else { return false }
        return ".!?؟؛:…".unicodeScalars.contains(last)
    }

    /// Whether `line` wraps into `next`: it runs most of the widest line's
    /// width, and the next is set close below it in the same size.
    static func wraps(_ line: TextLine, into next: TextLine, widest: CGFloat) -> Bool {
        guard widest > 0, CGFloat(line.width) >= widest * 0.8, !sizeChanges(from: line, to: next) else { return false }
        let gap = CGFloat(next.y) - CGFloat(line.y + line.height)
        return gap >= -CGFloat(line.height) * 0.5 && gap <= CGFloat(line.height)
    }

    /// A heading and its paragraph are set in different sizes.
    static func sizeChanges(from a: TextLine, to b: TextLine) -> Bool {
        guard a.height > 0, b.height > 0 else { return false }
        let ratio = a.height / b.height
        return ratio > 1.25 || ratio < 0.8
    }
}
