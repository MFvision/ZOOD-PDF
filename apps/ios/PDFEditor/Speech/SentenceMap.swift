import Foundation
import NaturalLanguage
import WarraqCore

/// One sentence of a page as read aloud: its text, its language, and the
/// boxes of the lines it spans on the page (display space, points from the
/// top-left corner), for the highlight.
struct SpokenSentence: Equatable, Sendable {
    let text: String
    let language: String
    let rects: [CGRect]
}

/// The page's text in logical order from the core, cut into sentences,
/// each mapped back onto the lines it came from. A line that ends without
/// a mark joins the next (a wrapped sentence) unless the next line is set
/// in a different size (a heading, then its paragraph); the tokenizer then
/// cuts each paragraph at "." "؟" "!" and the rest.
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
            if endsSentence(trimmed) || next == nil || sizeChanges(from: line, to: next!) {
                close()
            } else {
                text += " "
            }
        }
        close()

        var out: [SpokenSentence] = []
        let tokenizer = NLTokenizer(unit: .sentence)
        for paragraph in paragraphs {
            tokenizer.string = paragraph.text
            tokenizer.enumerateTokens(in: paragraph.text.startIndex..<paragraph.text.endIndex) { range, _ in
                let sentence = paragraph.text[range].trimmingCharacters(in: .whitespacesAndNewlines)
                guard !sentence.isEmpty else { return true }
                let rects = paragraph.spans
                    .filter { $0.range.overlaps(range) }
                    .map { CGRect(x: CGFloat($0.line.x), y: CGFloat($0.line.y), width: CGFloat($0.line.width), height: CGFloat($0.line.height)) }
                out.append(SpokenSentence(text: sentence, language: SpeechLanguage.detect(sentence, hint: hint), rects: rects))
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

    /// A heading and its paragraph are set in different sizes.
    static func sizeChanges(from a: TextLine, to b: TextLine) -> Bool {
        guard a.height > 0, b.height > 0 else { return false }
        let ratio = a.height / b.height
        return ratio > 1.25 || ratio < 0.8
    }
}
