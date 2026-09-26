import AVFoundation
import SwiftUI
import ZoodCore

/// Floating player over the document: previous · play/pause · next, speed, voices, close.
struct ReadAloudBar: View {
    @Bindable var reader: ReadAloudController
    let close: () -> Void
    @State private var showVoices = false

    var body: some View {
        VStack(spacing: 6) {
            if let unit = reader.currentUnit {
                Text(verbatim: unit.text)
                    .font(.caption)
                    .lineLimit(2)
                    .multilineTextAlignment(unit.language == .arabic ? .trailing : .leading)
                    .environment(\.layoutDirection, unit.language == .arabic ? .rightToLeft : .leftToRight)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            HStack(spacing: 18) {
                Button(action: close) { Label("common.close", systemImage: "xmark") }
                    .labelStyle(.iconOnly)
                Spacer(minLength: 0)
                Button { reader.previous() } label: { Label("read.previous", systemImage: "backward.fill") }
                    .labelStyle(.iconOnly)
                    .disabled(reader.index == 0)
                Button { reader.togglePlayPause() } label: {
                    Label(reader.state == .playing ? "read.pause" : "read.play",
                          systemImage: reader.state == .playing ? "pause.circle.fill" : "play.circle.fill")
                        .labelStyle(.iconOnly)
                        .font(.system(size: 38))
                }
                .disabled(reader.state == .loading || reader.state == .noText)
                Button { reader.next() } label: { Label("read.next", systemImage: "forward.fill") }
                    .labelStyle(.iconOnly)
                    .disabled(reader.index + 1 >= reader.units.count)
                Spacer(minLength: 0)
                Menu {
                    Picker(selection: $reader.speed) {
                        ForEach(SpeechRate.choices, id: \.self) { s in
                            Text("read.speed.value \(Self.speedText(s))").tag(s)
                        }
                    } label: {
                        Text("read.speed")
                    }
                    Button { showVoices = true } label: { Label("read.voices", systemImage: "waveform") }
                } label: {
                    Label("read.options", systemImage: "gauge.with.dots.needle.50percent").labelStyle(.iconOnly)
                }
            }
            .font(.title3)
            if reader.state == .loading {
                ProgressView().controlSize(.small)
            } else if reader.state == .noText {
                Text("read.noText").font(.caption).foregroundStyle(.orange)
            } else if let unit = reader.currentUnit {
                Text("read.position \(unit.page + 1) \(reader.index + 1) \(reader.units.count)")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .glass(22)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .frame(maxWidth: 560)
        .sheet(isPresented: $showVoices) {
            NavigationStack { VoicePickerView() }
        }
    }
}

extension ReadAloudBar {
    /// "1.25" / "١٫٢٥" in the current locale.
    static func speedText(_ s: Double) -> String {
        s.formatted(.number.precision(.fractionLength(0...2)))
    }
}

/// Installed voices per language, best first. Explains that Siri voices are not available to
/// apps and how to download Premium/Enhanced voices.
struct VoicePickerView: View {
    @State private var voices = VoiceCatalog.installed()
    @State private var selected: [ContentLanguage: String] = [:]
    @State private var preview = AVSpeechSynthesizer()

    var body: some View {
        List {
            ForEach([ContentLanguage.arabic, .english], id: \.self) { language in
                Section {
                    let ranked = VoiceRanker.ranked(voices, for: language)
                    if ranked.isEmpty {
                        Text("read.voices.none").foregroundStyle(.secondary)
                    }
                    ForEach(ranked) { v in
                        Button {
                            selected[language] = v.id
                            VoiceCatalog.save(v.id, for: language)
                            speakSample(v, language)
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(verbatim: v.name)
                                    Text(qualityName(v.quality)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if current(language)?.id == v.id {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                        .accessibilityLabel(Text("read.voices.selected"))
                                }
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                    if VoiceRanker.onlyStandard(voices, for: language) {
                        Label("read.voices.getBetter", systemImage: "arrow.down.circle")
                            .font(.caption).foregroundStyle(.orange)
                    }
                } header: {
                    Text(language == .arabic ? "read.voices.arabic" : "read.voices.english")
                }
            }
            Section {
                Text("read.voices.siri")
                Text("read.voices.howTo")
            } header: {
                Text("read.voices.about")
            }
        }
        .navigationTitle(Text("read.voices"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            voices = VoiceCatalog.installed()
            for l in ContentLanguage.allCases { selected[l] = VoiceCatalog.savedID(for: l) }
        }
    }

    private func current(_ language: ContentLanguage) -> VoiceInfo? {
        VoiceRanker.resolve(savedID: selected[language], voices: voices, for: language)
    }

    private func qualityName(_ q: VoiceQuality) -> LocalizedStringKey {
        switch q {
        case .premium: "read.quality.premium"
        case .enhanced: "read.quality.enhanced"
        case .standard: "read.quality.default"
        }
    }

    private func speakSample(_ v: VoiceInfo, _ language: ContentLanguage) {
        _ = preview.stopSpeaking(at: .immediate)
        let u = AVSpeechUtterance(string: language == .arabic ? "مرحبًا، هذا صوت القراءة في زود PDF." : "Hello, this is the reading voice in ZOOD PDF.")
        u.voice = AVSpeechSynthesisVoice(identifier: v.id)
        preview.speak(u)
    }
}
