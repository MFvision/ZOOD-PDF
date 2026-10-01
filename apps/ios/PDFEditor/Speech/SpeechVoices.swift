import AVFoundation
import NaturalLanguage
import Foundation

/// The system's installed voices, as read-aloud chooses among them: the
/// best installed voice for a language — Premium over Enhanced over the
/// compact default — unless the person picked one in Settings. Siri's
/// voices are not offered to apps by the API, so they are not listed; more
/// voices are downloaded in the Settings app (Accessibility › Spoken
/// Content › Voices).
enum SpeechVoices {
    /// The UserDefaults key for the chosen voice of a language ("ar", "en").
    static func settingKey(for language: String) -> String {
        "readAloud.voice.\(language)"
    }

    static let rateKey = "readAloud.rate"

    /// The rate between AVSpeechUtteranceMinimumSpeechRate and Maximum; the
    /// default is the system's.
    static var rate: Float {
        get {
            let stored = UserDefaults.standard.float(forKey: rateKey)
            return stored > 0 ? stored : AVSpeechUtteranceDefaultSpeechRate
        }
        set { UserDefaults.standard.set(newValue, forKey: rateKey) }
    }

    /// Every installed voice whose language starts with `language`
    /// ("ar" matches ar-SA and ar-001), best first.
    static func voices(for language: String, among all: [AVSpeechSynthesisVoice] = AVSpeechSynthesisVoice.speechVoices()) -> [AVSpeechSynthesisVoice] {
        let prefix = language.lowercased()
        return all
            .filter { $0.language.lowercased() == prefix || $0.language.lowercased().hasPrefix(prefix + "-") }
            .sorted { rank($0) > rank($1) || (rank($0) == rank($1) && $0.name < $1.name) }
    }

    /// Premium 3, Enhanced 2, the compact default 1.
    static func rank(_ voice: AVSpeechSynthesisVoice) -> Int {
        switch voice.quality {
        case .premium: 3
        case .enhanced: 2
        default: 1
        }
    }

    /// The quality, as a word beside the voice's name.
    static func qualityTitle(_ voice: AVSpeechSynthesisVoice) -> String? {
        switch voice.quality {
        case .premium: String(localized: "Premium")
        case .enhanced: String(localized: "Enhanced")
        default: nil
        }
    }

    /// The voice for a language: the one chosen in Settings when it is
    /// still installed, else the best installed one, else nil (the
    /// synthesizer then uses the system's voice for that language, or
    /// its default when there is none).
    static func voice(for language: String, chosen: String? = nil, among all: [AVSpeechSynthesisVoice] = AVSpeechSynthesisVoice.speechVoices()) -> AVSpeechSynthesisVoice? {
        let candidates = voices(for: language, among: all)
        let identifier = chosen ?? UserDefaults.standard.string(forKey: settingKey(for: language))
        if let identifier, let picked = candidates.first(where: { $0.identifier == identifier }) {
            return picked
        }
        return candidates.first
    }

    /// The languages the read-aloud settings offer a voice for: Arabic and
    /// English, and the device's own language when it is another one with
    /// an installed voice. Any other language a page is in is read with its
    /// best installed voice.
    static func languages(among all: [AVSpeechSynthesisVoice] = AVSpeechSynthesisVoice.speechVoices(),
                          device: String? = Locale.current.language.languageCode?.identifier) -> [String] {
        var out = ["ar", "en"]
        if let device, !out.contains(device), !voices(for: device, among: all).isEmpty {
            out.append(device)
        }
        return out
    }
}

/// Which language a stretch of text is in, for the voice: Arabic when a
/// third of its letters are Arabic or it opens in Arabic (the recognizer is
/// unsure on short mixed lines), else what the recognizer says, else English.
enum SpeechLanguage {
    static func isArabic(_ scalar: Unicode.Scalar) -> Bool {
        (0x0600...0x06FF).contains(scalar.value) || (0x0750...0x077F).contains(scalar.value) || (0x08A0...0x08FF).contains(scalar.value)
    }

    static func detect(_ text: String, hint: String? = nil) -> String {
        var letters = 0
        var arabic = 0
        for scalar in text.unicodeScalars where scalar.properties.isAlphabetic {
            letters += 1
            if isArabic(scalar) { arabic += 1 }
        }
        if letters == 0 { return hint ?? "en" }
        // Arabic when a third of the letters are, or when the sentence opens
        // in Arabic ("دعم فني (Premium Support)"): an Arabic voice reads the
        // English words in it, an English voice cannot read the Arabic.
        if arabic * 3 >= letters { return "ar" }
        if let first = text.unicodeScalars.first(where: { $0.properties.isAlphabetic }), Self.isArabic(first) { return "ar" }
        // Another language only when a voice for it is installed: a short
        // English line the recognizer takes for Dutch should not fall silent.
        if let guess = NLLanguageRecognizer.dominantLanguage(for: text)?.rawValue, guess != "ar",
           guess == "en" || !SpeechVoices.voices(for: guess).isEmpty {
            return guess
        }
        if let hint, hint != "ar" { return hint }
        return "en"
    }
}
