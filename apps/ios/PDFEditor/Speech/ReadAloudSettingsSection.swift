import AVFoundation
import SwiftUI

/// The Settings section for read-aloud: the voice for Arabic, for English
/// and for the device's own language (Premium and Enhanced voices first),
/// the speed, and where more voices come from. Siri's voices are
/// not offered to apps, so they are not here — said in so many words.
struct ReadAloudSettingsSection: View {
    @State private var voices = AVSpeechSynthesisVoice.speechVoices()
    @AppStorage(SpeechVoices.rateKey) private var rate: Double = Double(AVSpeechUtteranceDefaultSpeechRate)
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Section {
            ForEach(SpeechVoices.languages(among: voices), id: \.self) { language in
                VoicePicker(language: language, voices: SpeechVoices.voices(for: language, among: voices))
            }
            Picker("Speed", selection: $rate) {
                ForEach(ReadAloudBar.speeds) { speed in
                    Text(speed.title).tag(Double(speed.rate))
                }
            }
            .accessibilityIdentifier("settings.readAloud.speed")
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: url) {
                    Label("Download more voices", systemImage: "arrow.down.circle")
                }
                .accessibilityIdentifier("settings.readAloud.more")
            }
        } header: {
            Text("Read aloud")
        } footer: {
            Text("Voices are the system's, installed in the Settings app under Accessibility › Spoken Content › Voices; Premium and Enhanced voices sound best. Siri's voices are not offered to apps.")
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                voices = AVSpeechSynthesisVoice.speechVoices()
            }
        }
    }
}

/// The voice for one language: the best installed one unless another is
/// chosen; "System voice" when none is installed.
private struct VoicePicker: View {
    let language: String
    let voices: [AVSpeechSynthesisVoice]
    @State private var chosen: String

    init(language: String, voices: [AVSpeechSynthesisVoice]) {
        self.language = language
        self.voices = voices
        let stored = UserDefaults.standard.string(forKey: SpeechVoices.settingKey(for: language))
        _chosen = State(initialValue: voices.contains { $0.identifier == stored } ? stored! : (voices.first?.identifier ?? ""))
    }

    var body: some View {
        Picker(selection: $chosen) {
            if voices.isEmpty {
                Text("No voice installed").tag("")
            }
            ForEach(voices, id: \.identifier) { voice in
                Text(title(of: voice)).tag(voice.identifier)
            }
        } label: {
            Text(Locale.current.localizedString(forLanguageCode: language) ?? language)
        }
        .disabled(voices.isEmpty)
        .accessibilityIdentifier("settings.readAloud.voice.\(language)")
        .onChange(of: chosen) { _, identifier in
            UserDefaults.standard.set(identifier, forKey: SpeechVoices.settingKey(for: language))
        }
    }

    /// "Maged (ar-001) · Enhanced".
    private func title(of voice: AVSpeechSynthesisVoice) -> String {
        var parts = [voice.name]
        if voice.language.lowercased() != language { parts.append("(\(voice.language))") }
        if let quality = SpeechVoices.qualityTitle(voice) { parts.append("· \(quality)") }
        return parts.joined(separator: " ")
    }
}
