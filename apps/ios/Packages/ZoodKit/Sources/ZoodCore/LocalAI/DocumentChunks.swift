import Foundation

/// Text of one page in logical order (the engine's `text.plain` pages).
public struct PageContent: Sendable, Equatable {
    /// 0-based page index.
    public let index: Int
    public let text: String

    public init(index: Int, text: String) {
        self.index = index
        self.text = text
    }

    /// 1-based page number shown to people and to the model.
    public var number: Int { index + 1 }
}

/// A piece of one page small enough to put several of them in a small model's context.
/// Chunks never cross pages, so an answer's page citation is exact.
public struct TextChunk: Sendable, Equatable, Identifiable {
    public let id: Int
    /// 0-based page index.
    public let page: Int
    public let text: String

    public init(id: Int, page: Int, text: String) {
        self.id = id
        self.page = page
        self.text = text
    }
}

public enum DocumentChunker {
    /// Sentence ends in Arabic and English text (the Arabic question mark ؟, full stop ۔).
    static let sentenceEnds: Set<Character> = [".", "!", "?", "؟", "۔", "…"]

    /// Split pages into chunks of about `target` characters: paragraphs are packed together,
    /// long paragraphs are cut at sentence ends, then at spaces, never inside a word.
    public static func chunks(pages: [PageContent], target: Int = 700) -> [TextChunk] {
        let target = max(target, 80)
        var out: [TextChunk] = []
        for page in pages {
            var current = ""
            func flush() {
                let t = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { out.append(TextChunk(id: out.count, page: page.index, text: t)) }
                current = ""
            }
            for paragraph in paragraphs(page.text) {
                for piece in split(paragraph, limit: target) {
                    if !current.isEmpty && current.count + piece.count + 1 > target { flush() }
                    current += current.isEmpty ? piece : "\n" + piece
                }
            }
            flush()
        }
        return out
    }

    /// Non-empty paragraphs (lines) with inner whitespace collapsed.
    static func paragraphs(_ text: String) -> [String] {
        text.split(whereSeparator: \.isNewline)
            .map { collapseSpaces(String($0)) }
            .filter { !$0.isEmpty }
    }

    static func collapseSpaces(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// Sentences of a paragraph, each keeping its end mark.
    public static func sentences(_ paragraph: String) -> [String] {
        var out: [String] = []
        var current = ""
        var previousWasEnd = false
        for ch in paragraph {
            if previousWasEnd && ch.isWhitespace {
                let t = current.trimmingCharacters(in: .whitespaces)
                if !t.isEmpty { out.append(t) }
                current = ""
                previousWasEnd = false
                continue
            }
            current.append(ch)
            previousWasEnd = sentenceEnds.contains(ch)
        }
        let t = current.trimmingCharacters(in: .whitespaces)
        if !t.isEmpty { out.append(t) }
        return out
    }

    /// Pieces of at most `limit` characters (a single word longer than that is kept whole).
    static func split(_ paragraph: String, limit: Int) -> [String] {
        guard paragraph.count > limit else { return [paragraph] }
        var out: [String] = []
        var current = ""
        func add(_ piece: String) {
            if current.isEmpty {
                current = piece
            } else if current.count + 1 + piece.count <= limit {
                current += " " + piece
            } else {
                out.append(current)
                current = piece
            }
        }
        for sentence in sentences(paragraph) {
            if sentence.count <= limit {
                add(sentence)
            } else {
                for word in sentence.split(separator: " ") { add(String(word)) }
            }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }
}
