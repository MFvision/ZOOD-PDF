import Foundation
import SwiftUI

// The on-device AI providers, both in the app's own process, no key,
// nothing leaving the device:
//
// - ZOOD's own model (`ZoodModelEngine`, llama.cpp, the desktop's model):
//   Arabic and English, any iPhone with 4 GB of memory, carried in the app
//   or fetched once.
// - Apple's Foundation Models (iOS 26+, Apple Intelligence on): used for a
//   request in a language Apple's model reads — never for Arabic, which it
//   does not — when ZOOD's model is not there.
//
// The AI button is always there; when neither can answer yet, the AI sheet
// says why and offers what fixes it (fetching ZOOD's model).
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
    /// ZOOD's model is not on this phone yet: it can be fetched once.
    case needsModel
    /// The phone has too little memory for ZOOD's model, and no Apple model.
    case deviceTooSmall

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
        case .needsModel: "ZOOD's AI runs on this iPhone, in Arabic and English, with nothing sent anywhere. Fetch it once (about 1.1 GB) and it works offline from then on."
        case .deviceTooSmall: "This iPhone has too little memory for ZOOD's AI. Quick summaries still work."
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
    /// The same, handing the answer so far to `partial` as it is written.
    func reply(instructions: String, prompt: String, partial: @escaping @Sendable (String) -> Void) async throws -> String
    /// Which fields take which details — structured, never free text.
    func assign(fields: [FieldDescription], profileKeys: [ProfileKey], documentText: String) async throws -> [FieldAssignment]
}

extension AIEngine {
    func reply(instructions: String, prompt: String, partial: @escaping @Sendable (String) -> Void) async throws -> String {
        try await reply(instructions: instructions, prompt: prompt)
    }
}

/// Whether a text is mostly Arabic letters.
func readsArabic(_ text: String) -> Bool {
    var arabic = 0
    var latin = 0
    for scalar in text.unicodeScalars.prefix(4000) {
        switch scalar.value {
        case 0x0600...0x06FF, 0x0750...0x077F, 0xFB50...0xFDFF, 0xFE70...0xFEFF: arabic += 1
        case 0x41...0x5A, 0x61...0x7A: latin += 1
        default: break
        }
    }
    return arabic > 0 && arabic * 2 >= latin
}

/// ZOOD's model and Apple's together: each request goes to the one that
/// reads its language best — ZOOD's for Arabic, and whenever it is there;
/// Apple's for a language it reads when ZOOD's model is not.
struct RoutedEngine: AIEngine {
    let zood: ZoodModelEngine?
    let apple: (any AIEngine)?
    let appleReadsArabic: Bool

    var name: String {
        switch (zood, apple) {
        case (.some, .some): "\(ZoodModel.displayName) + Apple Intelligence"
        case (.some, nil): ZoodModel.displayName
        default: apple?.name ?? ""
        }
    }

    func engine(for prompt: String) throws -> any AIEngine {
        if let zood { return zood }
        if let apple, appleReadsArabic || !readsArabic(prompt) { return apple }
        throw AIEngineError.unavailable(.needsModel)
    }

    func reply(instructions: String, prompt: String) async throws -> String {
        try await engine(for: prompt).reply(instructions: instructions, prompt: prompt)
    }

    func reply(instructions: String, prompt: String, partial: @escaping @Sendable (String) -> Void) async throws -> String {
        try await engine(for: prompt).reply(instructions: instructions, prompt: prompt, partial: partial)
    }

    func assign(fields: [FieldDescription], profileKeys: [ProfileKey], documentText: String) async throws -> [FieldAssignment] {
        // Apple's guided generation, when it reads the form, is the stricter of the two.
        if let apple, appleReadsArabic || !readsArabic(documentText + fields.map(\.label).joined()) {
            return try await apple.assign(fields: fields, profileKeys: profileKeys, documentText: documentText)
        }
        guard let zood else { throw AIEngineError.unavailable(.needsModel) }
        return try await zood.assign(fields: fields, profileKeys: profileKeys, documentText: documentText)
    }
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
        case let .unavailable(reason):
            reason == .needsModel
                ? String(localized: "This needs ZOOD's AI on this iPhone. Fetch it once in the AI sheet or Settings › AI.")
                : String(localized: "On-device AI is not available.")
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

    /// Apple's model, when it answers here (iOS 26+, Apple Intelligence on).
    static func appleEngine() -> (engine: (any AIEngine)?, availability: AIAvailability, readsArabic: Bool) {
        if #available(iOS 26, *) {
            let availability = FoundationModelsEngine.availability()
            return (availability.isAvailable ? FoundationModelsEngine() : nil, availability, FoundationModelsEngine.readsArabic)
        }
        return (nil, .systemTooOld, false)
    }

    /// ZOOD's model, when it is on this phone and the phone can run it.
    static func zoodEngine() -> ZoodModelEngine? {
        guard ZoodModel.deviceCanRun, let file = ZoodModel.location else { return nil }
        return ZoodModelEngine(file: file)
    }

    /// The availability now (asked each time: Apple Intelligence can be
    /// turned on, and ZOOD's model fetched, while the app runs).
    static func availability() -> AIAvailability {
        current().availability
    }

    /// The engine, or nil with the reason none answers yet.
    static func current() -> (engine: (any AIEngine)?, availability: AIAvailability) {
        if fakeRequested { return (FakeEngine(), .available) }
        let zood = zoodEngine()
        let apple = appleEngine()
        if zood != nil || apple.engine != nil {
            return (RoutedEngine(zood: zood, apple: apple.engine, appleReadsArabic: apple.readsArabic), .available)
        }
        return (nil, ZoodModel.deviceCanRun ? .needsModel : .deviceTooSmall)
    }

    /// Why Apple's model is not there, for Settings.
    static func appleAvailability() -> AIAvailability {
        if fakeRequested { return .available }
        return appleEngine().availability
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
