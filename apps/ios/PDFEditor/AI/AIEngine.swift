import Foundation
import SwiftUI

// The on-device AI provider. On iOS 26 and later with Apple Intelligence
// turned on, Apple's Foundation Models framework answers in the app's own
// process: no download, no key, nothing leaves the device. Where it is not
// available the app says exactly why (in Settings) and shows none of the AI
// controls — there is no other model on a phone, and no façade.
//
// `AIEngine` is what the assistant and form autofill talk to;
// `FoundationModelsEngine` is the real one, `FakeEngine` (Debug builds only,
// `-warraqFakeAI 1`) stands in for it in tests on a simulator without the
// model, so the plumbing around it — prompts, the never-invent check, the
// review sheet, the writing of values — is proven all the same.

/// Whether the on-device model can be used here, and if not, why not.
enum AIAvailability: Equatable, Sendable {
    case available
    /// The system is older than iOS 26: the framework is not there.
    case systemTooOld
    /// The device cannot run Apple Intelligence.
    case deviceNotEligible
    /// Apple Intelligence is off in the Settings app.
    case appleIntelligenceOff
    /// The model is still downloading or otherwise not ready.
    case modelNotReady
    /// A reason the framework did not name.
    case unavailable

    var isAvailable: Bool { self == .available }

    /// The reason, as a sentence for the person.
    var message: LocalizedStringKey {
        switch self {
        case .available: "The system's on-device model answers here. Nothing leaves this device."
        case .systemTooOld: "On-device AI needs iOS 26 or later."
        case .deviceNotEligible: "This device cannot run Apple Intelligence, so on-device AI is not available."
        case .appleIntelligenceOff: "Turn on Apple Intelligence in the Settings app to use on-device AI."
        case .modelNotReady: "The on-device model is not ready yet — it may still be downloading. Try again later."
        case .unavailable: "On-device AI is not available on this device."
        }
    }

    /// A short name, for a status row.
    var title: LocalizedStringKey {
        isAvailable ? "Available" : "Not available"
    }
}

/// What one field of a form should take: a detail of the profile by its
/// key, or words quoted from the document. The engine answers with these;
/// `FormAutofill` then checks every one against the profile and the text,
/// so nothing invented can reach a field.
struct FieldAssignment: Equatable, Sendable {
    let field: String
    let profileKey: ProfileKey?
    let documentQuote: String?
}

/// A field as described to the engine: its name, the words printed beside
/// it, what it holds now.
struct FieldDescription: Equatable, Sendable {
    let name: String
    let label: String
    let current: String
    let page: Int
}

/// The on-device model, as the app uses it.
protocol AIEngine: Sendable {
    /// A short name for the status row ("Apple Intelligence", "Fake").
    var name: String { get }
    /// A whole answer to a prompt under instructions.
    func reply(instructions: String, prompt: String) async throws -> String
    /// Which fields take which details — structured, never free text.
    func assign(fields: [FieldDescription], profileKeys: [ProfileKey], documentText: String) async throws -> [FieldAssignment]
}

enum AIEngineError: Error, LocalizedError, Equatable {
    case unavailable(AIAvailability)
    /// The model declined the request (its guardrails).
    case refused
    /// Too much text for the model's window.
    case tooLong
    /// The model's safety check could not run (as on the Simulator, where
    /// the framework reports the model available but every request fails).
    case safetyCheckUnavailable
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .unavailable: String(localized: "On-device AI is not available.")
        case .refused: String(localized: "The on-device model declined this request.")
        case .tooLong: String(localized: "This is too much text for the on-device model. Ask about a part of the document.")
        case .safetyCheckUnavailable: String(localized: "The on-device model did not answer: its safety check cannot run on this device.")
        case let .failed(message): message
        }
    }
}

/// Finds the engine to use: the fake one when a Debug run asks for it,
/// otherwise Apple's when it is available here.
enum AIEngines {
    /// True in a Debug run started with `-warraqFakeAI 1`.
    static var fakeRequested: Bool {
        #if DEBUG
        UserDefaults.standard.bool(forKey: "warraqFakeAI")
        #else
        false
        #endif
    }

    /// The availability now (the framework is asked each time: Apple
    /// Intelligence can be turned on while the app runs).
    static func availability() -> AIAvailability {
        if fakeRequested { return .available }
        if #available(iOS 26, *) {
            return FoundationModelsEngine.availability()
        }
        return .systemTooOld
    }

    /// The engine, or nil with the reason it is not there.
    static func current() -> (engine: (any AIEngine)?, availability: AIAvailability) {
        if fakeRequested { return (FakeEngine(), .available) }
        if #available(iOS 26, *) {
            let availability = FoundationModelsEngine.availability()
            return (availability.isAvailable ? FoundationModelsEngine() : nil, availability)
        }
        return (nil, .systemTooOld)
    }
}

// MARK: - The fake

/// Stands in for the model in Debug runs and tests: answers are marked as
/// fake, and fields are matched to the profile by the words in their
/// labels — enough to drive every screen around the model.
struct FakeEngine: AIEngine {
    var name: String { "Fake (test)" }

    func reply(instructions: String, prompt: String) async throws -> String {
        // The first lines of what was asked, so a test can see the document's
        // text went in and the answer came out.
        let body = prompt.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        let sample = body.prefix(3).joined(separator: " ")
        return "[fake] " + String(sample.prefix(240))
    }

    func assign(fields: [FieldDescription], profileKeys: [ProfileKey], documentText: String) async throws -> [FieldAssignment] {
        fields.compactMap { field in
            guard let key = Self.guess(field: field, among: profileKeys) else { return nil }
            return FieldAssignment(field: field.name, profileKey: key, documentQuote: nil)
        }
    }

    /// The profile key whose words appear in the field's name or label.
    static func guess(field: FieldDescription, among keys: [ProfileKey]) -> ProfileKey? {
        let text = (field.name + " " + field.label).lowercased()
        let arabic = text.unicodeScalars.contains { (0x0600...0x06FF).contains($0.value) }
        let table: [(ProfileKey, [String])] = [
            (.email, ["email", "e-mail", "بريد"]),
            (.phone, ["phone", "mobile", "tel", "هاتف", "جوال", "الاتصال"]),
            (.iban, ["iban", "آيبان", "ايبان"]),
            (.nationalID, ["national id", "id number", "iqama", "identity", "الهوية", "الهويه", "إقامة", "الاقامة"]),
            (.dateOfBirth, ["birth", "الميلاد"]),
            (.employer, ["employer", "company", "جهة العمل", "الشركة", "صاحب العمل"]),
            (.address, ["address", "العنوان"]),
            (arabic ? .nameArabic : .nameEnglish, ["name", "الاسم", "الإسم"]),
        ]
        for (key, words) in table where words.contains(where: text.contains) {
            if keys.contains(key) { return key }
            // The other script's name when only that one is filled in.
            if key == .nameArabic, keys.contains(.nameEnglish) { return .nameEnglish }
            if key == .nameEnglish, keys.contains(.nameArabic) { return .nameArabic }
            return nil
        }
        return nil
    }
}
