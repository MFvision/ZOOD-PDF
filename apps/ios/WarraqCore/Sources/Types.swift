import Foundation

/// What a tool operation answers: JSON for the caller to decode, and bytes
/// beside it (a saved file, a picture, an export).
public struct Reply: Sendable, Equatable {
    public let json: String
    public let blobs: [Data]

    public init(json: String, blobs: [Data] = []) {
        self.json = json
        self.blobs = blobs
    }

    /// The JSON decoded as `T`.
    public func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: Data(json.utf8))
        } catch {
            throw CoreError.badReply("\(error): \(json.prefix(200))")
        }
    }

    /// The JSON as a dictionary, for answers read a field at a time.
    public var object: [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
    }
}

/// A line of a page's text, positioned in points from the page's top-left
/// corner, as the core reads it: shaped Arabic in logical order.
public struct TextLine: Codable, Sendable, Equatable {
    public let text: String
    public let x: Float
    public let y: Float
    public let width: Float
    public let height: Float
    /// "rtl" or "ltr".
    public let direction: String

    public var isRightToLeft: Bool { direction == "rtl" }
}

/// A paragraph in device space, for hit-testing a tap against what was drawn.
public struct Paragraph: Codable, Sendable, Equatable {
    public let index: Int
    public let text: String
    public let x: Float
    public let y: Float
    public let width: Float
    public let height: Float
    public let direction: String
    /// "start", "end", "center" or "justify".
    public let alignment: String
    public let fontSize: Float
    public let lineCount: Int
    /// The face the file names for the paragraph — the font most of its
    /// runs use: its family, cut by the core to letters, digits, spaces and
    /// hyphens (empty when the file names none), its weight (100–900), its
    /// slant, and "serif", "sans" or "unknown".
    public let fontFamily: String?
    public let fontWeight: Int?
    public let fontItalic: Bool?
    public let fontClass: String?
    /// Its own font can draw the text it has now: an edit that keeps to
    /// its letters is drawn in that very font (never for Arabic).
    public let ownFont: Bool?
}

/// What replacing a paragraph did, so the interface can warn instead of
/// silently spoiling the page.
public struct ParagraphReplacement: Codable, Sendable, Equatable {
    public let linesDrawn: Int
    public let fontSubstituted: Bool
    public let shrunk: Bool
    public let overflowed: Bool
    public let fontSize: Float
}

/// The document's own information.
public struct Metadata: Codable, Sendable, Equatable {
    public let title: String?
    public let author: String?
    public let producer: String?
    public let creator: String?
    public let pages: Int
    public let encrypted: Bool
    /// Which engine draws the pages ("hayro" on a phone).
    public let engine: String
}

/// A page drawn by the core: RGBA8 pixels, premultiplied over white.
public struct RenderedPage: Sendable, Equatable {
    public let width: Int
    public let height: Int
    public let rgba: Data
}

/// A page's size in points, after its own rotation.
public struct PageSize: Codable, Sendable, Equatable {
    public let width: Float
    public let height: Float
}
