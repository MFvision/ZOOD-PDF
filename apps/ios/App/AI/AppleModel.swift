import Foundation
import ZoodCore
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Apple's on-device Foundation Models (iOS 26+ with Apple Intelligence). No download, no key,
/// runs on the device. Availability and language support are checked at run time on every
/// request, because the user can switch Apple Intelligence off and the system model can be
/// still downloading.
enum AppleModel {
    static var isAvailable: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability { return true }
            return false
        }
        #endif
        return false
    }

    static var unavailableReason: String? {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return nil
            case .unavailable(.deviceNotEligible):
                return String(localized: "ai.apple.notEligible")
            case .unavailable(.appleIntelligenceNotEnabled):
                return String(localized: "ai.apple.notEnabled")
            case .unavailable(.modelNotReady):
                return String(localized: "ai.apple.notReady")
            case .unavailable:
                return String(localized: "ai.apple.notEligible")
            }
        }
        #endif
        return String(localized: "ai.apple.needsNewerOS")
    }

    /// Whether the system model supports `language` (Arabic support depends on the OS release).
    static func supports(_ language: ContentLanguage) -> Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            return SystemLanguageModel.default.supportsLocale(Locale(identifier: language.rawValue))
        }
        #endif
        return false
    }

    static func stream(_ prompt: LocalPrompt) -> AsyncThrowingStream<String, any Error> {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            return AsyncThrowingStream { continuation in
                let task = Task {
                    do {
                        let session = LanguageModelSession(model: .default, instructions: prompt.instructions)
                        let options = GenerationOptions(
                            temperature: 0.3, maximumResponseTokens: ModelBudget.appleOnDevice.maxOutputTokens)
                        var shown = ""
                        // Snapshots carry the whole answer so far; yield only the new part.
                        for try await snapshot in session.streamResponse(to: prompt.prompt, options: options) {
                            let full = snapshot.content
                            if full.hasPrefix(shown) {
                                continuation.yield(String(full.dropFirst(shown.count)))
                            } else {
                                continuation.yield(full)
                            }
                            shown = full
                        }
                        continuation.finish()
                    } catch {
                        continuation.finish(throwing: map(error))
                    }
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        }
        #endif
        return AsyncThrowingStream { $0.finish(throwing: LocalAIError.runtimeMissing) }
    }

    static func autofill(_ prompt: LocalPrompt) async throws -> [RawAutofillProposal] {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            do {
                let session = LanguageModelSession(model: .default, instructions: prompt.instructions)
                // Guided generation: the model can only produce this structure.
                let response = try await session.respond(
                    to: prompt.prompt, generating: GeneratedAutofill.self,
                    options: GenerationOptions(temperature: 0))
                return response.content.proposals.map {
                    RawAutofillProposal(field: $0.field, value: $0.value, source: $0.source)
                }
            } catch {
                throw map(error)
            }
        }
        #endif
        throw LocalAIError.runtimeMissing
    }

    private static func map(_ error: any Error) -> any Error {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), let e = error as? LanguageModelSession.GenerationError {
            switch e {
            case .exceededContextWindowSize: return LocalAIError.contextOverflow
            case .unsupportedLanguageOrLocale: return LocalAIError.unsupportedLanguage
            case .guardrailViolation: return LocalAIError.refused
            default: return LocalAIError.generationFailed(e.localizedDescription)
            }
        }
        #endif
        return error
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
struct GeneratedAutofill {
    @Guide(description: "One entry for each field that can be filled from the profile or the excerpts")
    var proposals: [GeneratedProposal]
}

@available(iOS 26.0, *)
@Generable
struct GeneratedProposal {
    @Guide(description: "The field id exactly as listed under FIELDS")
    var field: String
    @Guide(description: "The value, copied exactly from the profile or the document")
    var value: String
    @Guide(description: "profile.<key> for a profile value, or page N for text found on page N")
    var source: String
}
#endif
