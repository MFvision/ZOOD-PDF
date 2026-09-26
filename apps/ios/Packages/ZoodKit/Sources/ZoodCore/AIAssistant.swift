import Foundation

/// Bring-your-own-key AI (Anthropic Messages API over HTTPS + SSE). Nothing is sent until the
/// user presses Send; the exact text (`AIPrompt.fullText`) is shown to them first.
/// This file holds the platform-independent parts (prompt text, request body, SSE parsing), so
/// they are tested on Linux; the URLSession call lives in the app (`AIClient.swift`).
public enum AISuggestion: String, CaseIterable, Sendable, Codable {
    case summarize, explain, translate, keyPoints, quiz, email

    /// The instruction sent for a chip (always English + "answer in <language>", so the model
    /// replies in the user's language).
    public func instruction(answerLanguage: String) -> String {
        let base: String
        switch self {
        case .summarize: base = "Summarize this document in a short paragraph followed by 3-5 bullet points."
        case .explain: base = "Explain this document simply, as if to someone new to the topic."
        case .translate: base = "Translate this document. If it is in Arabic, translate it to English; otherwise translate it to Arabic."
        case .keyPoints: base = "List the key points of this document as bullet points."
        case .quiz: base = "Write a short quiz (5 questions with answers) to test understanding of this document."
        case .email: base = "Draft a short, polite email that shares the main points of this document."
        }
        return "\(base) Answer in \(answerLanguage)."
    }
}

public struct AIPrompt: Sendable, Equatable {
    public static let maxDocumentCharacters = 150_000

    public let documentName: String
    public let documentText: String
    public let question: String
    /// True when the document text was cut to `maxDocumentCharacters` (shown to the user).
    public let truncated: Bool

    public init(documentName: String, documentText: String, question: String) {
        self.documentName = documentName
        self.truncated = documentText.count > Self.maxDocumentCharacters
        self.documentText = truncated ? String(documentText.prefix(Self.maxDocumentCharacters)) : documentText
        self.question = question
    }

    /// Exactly what is sent as the user message — displayed verbatim before Send.
    public var fullText: String {
        "<document name=\"\(Self.escape(documentName))\">\n\(documentText)\n</document>\n\n\(question)"
    }

    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
    }
}

/// Messages API request body.
public struct AIRequestBody: Encodable, Sendable {
    public struct Message: Encodable, Sendable {
        public let role: String
        public let content: String
    }

    public static let defaultModel = "claude-opus-5"
    public static let apiVersion = "2023-06-01"
    /// Server-side refusal fallback (routes a declined request to a suitable model).
    public static let fallbackBeta = "server-side-fallback-2026-07-01"

    public let model: String
    public let max_tokens: Int
    public let stream: Bool
    public let system: String
    public let messages: [Message]
    public let fallbacks: String

    public init(prompt: AIPrompt, model: String = defaultModel) {
        self.model = model
        self.max_tokens = 16_000
        self.stream = true
        self.system = "You help people understand PDF documents in the ZOOD PDF app. Be accurate; say so when the document does not contain the answer."
        self.messages = [Message(role: "user", content: prompt.fullText)]
        self.fallbacks = "default"
    }
}

/// Events the UI cares about.
public enum AIStreamEvent: Equatable, Sendable {
    case text(String)
    case stop(reason: String)
    case error(String)
}

/// Incremental Server-Sent Events parser: feed lines, get events. Unknown events (thinking,
/// fallback blocks, pings) are ignored.
public struct AISSEParser: Sendable {
    private var dataLines: [String] = []

    public init() {}

    /// Feed one line (without its newline). Returns an event when a blank line ends a message.
    public mutating func feed(line: String) -> AIStreamEvent? {
        if line.isEmpty {
            defer { dataLines.removeAll() }
            guard !dataLines.isEmpty else { return nil }
            return Self.decode(dataLines.joined(separator: "\n"))
        }
        if line.hasPrefix("data:") {
            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
        }
        return nil
    }

    static func decode(_ payload: String) -> AIStreamEvent? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
              let type = obj["type"] as? String else { return nil }
        switch type {
        case "content_block_delta":
            if let delta = obj["delta"] as? [String: Any], delta["type"] as? String == "text_delta",
               let text = delta["text"] as? String {
                return .text(text)
            }
            return nil
        case "message_delta":
            if let delta = obj["delta"] as? [String: Any], let reason = delta["stop_reason"] as? String {
                return .stop(reason: reason)
            }
            return nil
        case "error":
            let message = (obj["error"] as? [String: Any])?["message"] as? String ?? "error"
            return .error(message)
        default:
            return nil
        }
    }

    /// Message for a non-200 HTTP reply body (`{"type":"error","error":{"message":…}}`).
    public static func errorMessage(fromBody body: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        return (obj["error"] as? [String: Any])?["message"] as? String
    }
}
