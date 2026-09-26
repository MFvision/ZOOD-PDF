import Foundation
import Testing
@testable import ZoodCore

@Suite("AI assistant (request text and SSE parsing)")
struct AIAssistantTests {
    @Test func promptIsShownVerbatimAndTruncated() {
        let p = AIPrompt(documentName: "a\"<b>.pdf", documentText: "نص", question: "لخّص")
        #expect(p.fullText == "<document name=\"a&quot;&lt;b>.pdf\">\nنص\n</document>\n\nلخّص")
        #expect(!p.truncated)
        let long = AIPrompt(
            documentName: "x", documentText: String(repeating: "a", count: AIPrompt.maxDocumentCharacters + 1), question: "q")
        #expect(long.truncated && long.documentText.count == AIPrompt.maxDocumentCharacters)
    }

    @Test func requestBody() throws {
        let body = AIRequestBody(prompt: AIPrompt(documentName: "x", documentText: "t", question: "q"))
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
        #expect(json?["model"] as? String == "claude-opus-5")
        #expect(json?["stream"] as? Bool == true)
        #expect(json?["fallbacks"] as? String == "default")
        #expect((json?["messages"] as? [[String: Any]])?.first?["role"] as? String == "user")
        #expect(AISuggestion.summarize.instruction(answerLanguage: "Arabic").hasSuffix("Answer in Arabic."))
    }

    @Test func parsesTextDeltasStopAndErrors() {
        var p = AISSEParser()
        var events: [AIStreamEvent] = []
        let stream = """
            event: message_start
            data: {"type":"message_start","message":{}}

            event: content_block_delta
            data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}

            event: content_block_delta
            data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"مرحبا"}}

            event: ping
            data: {"type": "ping"}

            event: message_delta
            data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

            event: error
            data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}

            """
        for line in stream.split(separator: "\n", omittingEmptySubsequences: false) {
            if let e = p.feed(line: String(line)) { events.append(e) }
        }
        #expect(events == [.text("مرحبا"), .stop(reason: "end_turn"), .error("Overloaded")])
        let body = Data(#"{"type":"error","error":{"message":"invalid x-api-key"}}"#.utf8)
        #expect(AISSEParser.errorMessage(fromBody: body) == "invalid x-api-key")
    }
}
