import Foundation
import Observation
import ZoodCore

/// Errors of the on-device assistant (localised for the UI).
enum LocalAIError: LocalizedError {
    case noModel
    case runtimeMissing
    case contextOverflow
    case unsupportedLanguage
    case refused
    case loadFailed
    case generationFailed(String)
    case malformedAutofill

    var errorDescription: String? {
        switch self {
        case .noModel: String(localized: "ai.error.noModel")
        case .runtimeMissing: String(localized: "ai.error.runtimeMissing")
        case .contextOverflow: String(localized: "ai.error.tooLong")
        case .unsupportedLanguage: String(localized: "ai.error.language")
        case .refused: String(localized: "ai.error.refused")
        case .loadFailed: String(localized: "ai.error.loadFailed")
        case .generationFailed(let m): String(localized: "ai.error.generation \(m)")
        case .malformedAutofill: String(localized: "autofill.error.malformed")
        }
    }
}

/// Picks the on-device model for a request and runs it. Nothing leaves the device: Apple's
/// Foundation Models run on-device, and the portable Qwen3 model runs through llama.cpp from a
/// file in Application Support.
@MainActor @Observable
final class LocalAI {
    static let shared = LocalAI()

    let models = ModelManager.shared

    /// Apple's on-device model can be used on this device right now (iOS 26+, Apple
    /// Intelligence on, model downloaded by the system).
    var appleAvailable: Bool { AppleModel.isAvailable }

    /// Why Apple's model cannot be used (nil when it can, or on iOS < 26).
    var appleUnavailableReason: String? { AppleModel.unavailableReason }

    /// This build includes llama.cpp (see ADR 0015; device builds only).
    var portableRuntime: Bool { PortableModelRunner.isCompiledIn }

    /// Backend for a request whose text and answer are in `languages`.
    func choice(for languages: Set<ContentLanguage>) -> AIBackendChoice {
        AIBackendChooser.choose(
            appleAvailable: appleAvailable,
            appleSupportsLanguage: languages.allSatisfy { AppleModel.supports($0) },
            portableRuntime: portableRuntime,
            portableInstalled: models.installed != nil)
    }

    func budget(for choice: AIBackendChoice) -> ModelBudget {
        switch choice {
        case .apple: .appleOnDevice
        default: models.installed?.budget ?? .portable
        }
    }

    /// A human name of the backend, shown under the answer ("On this iPhone · Apple Intelligence").
    func backendName(_ choice: AIBackendChoice) -> String {
        switch choice {
        case .apple: String(localized: "ai.backend.apple")
        case .portable: models.installed?.displayName ?? String(localized: "ai.backend.portable")
        case .needsModel, .unavailable: ""
        }
    }

    /// Stream an answer (visible text only; think blocks are removed).
    func stream(_ prompt: LocalPrompt, using choice: AIBackendChoice) -> AsyncThrowingStream<String, any Error> {
        switch choice {
        case .apple:
            return AppleModel.stream(prompt)
        case .portable:
            guard let spec = models.installed, let path = models.installedPath else {
                return AsyncThrowingStream { $0.finish(throwing: LocalAIError.noModel) }
            }
            return PortableModelRunner.shared.stream(prompt, modelPath: path, spec: spec)
        case .needsModel:
            return AsyncThrowingStream { $0.finish(throwing: LocalAIError.noModel) }
        case .unavailable:
            return AsyncThrowingStream { $0.finish(throwing: LocalAIError.runtimeMissing) }
        }
    }

    /// Model proposals for form fields (validated by the caller with `AutofillValidator`).
    func autofill(_ prompt: LocalPrompt, fields: [FormField], pageCount: Int, using choice: AIBackendChoice) async throws
        -> [RawAutofillProposal] {
        switch choice {
        case .apple:
            return try await AppleModel.autofill(prompt)
        case .portable:
            guard let spec = models.installed, let path = models.installedPath else { throw LocalAIError.noModel }
            let grammar = AutofillPromptBuilder.grammar(fieldIDs: fields.filter(\.isFillable).map(\.id), pageCount: pageCount)
            var text = ""
            for try await piece in PortableModelRunner.shared.stream(prompt, modelPath: path, spec: spec, grammar: grammar) {
                text += piece
            }
            guard let raw = AutofillValidator.parse(text) else { throw LocalAIError.malformedAutofill }
            return raw
        case .needsModel:
            throw LocalAIError.noModel
        case .unavailable:
            throw LocalAIError.runtimeMissing
        }
    }
}
