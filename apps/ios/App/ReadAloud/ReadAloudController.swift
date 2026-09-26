import AVFoundation
import MediaPlayer
import Observation
import PDFKit
import SwiftUI
import ZoodCore

/// Reads the document aloud with the best installed voices, entirely on the device
/// (`AVSpeechSynthesizer`). Text comes from the engine in logical order, paragraph by paragraph;
/// Arabic and English parts get their own voice; the paragraph being read is highlighted in
/// PDFKit and scrolled into view. Keeps playing with the screen locked (audio background mode,
/// spoken-audio session) and answers the Lock Screen / Control Center Now Playing controls.
@MainActor @Observable
final class ReadAloudController: NSObject {
    enum State: Equatable { case loading, playing, paused, stopped, finished, noText }

    private(set) var state: State = .loading
    private(set) var units: [ReadingUnit] = []
    private(set) var index = 0
    var speed: Double = UserDefaults.standard.object(forKey: "read.speed") as? Double ?? 1.0 {
        didSet {
            UserDefaults.standard.set(speed, forKey: "read.speed")
            if state == .playing { restartCurrent() }
        }
    }

    private let session: DocumentSession
    private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var current: AVSpeechUtterance?
    @ObservationIgnored private var observers: [any NSObjectProtocol] = []
    private static weak var active: ReadAloudController?

    init(session: DocumentSession) {
        self.session = session
        super.init()
        synthesizer.delegate = self
    }

    var currentUnit: ReadingUnit? { units.indices.contains(index) ? units[index] : nil }

    // MARK: - Lifecycle

    /// Load the text and start at the page on screen.
    func start() async {
        ReadAloudController.active?.stop()
        ReadAloudController.active = self
        state = .loading
        let paragraphs = await session.paragraphs()
        let language = TextScript.dominantLanguage(paragraphs.prefix(40).map(\.text).joined(separator: " ")) ?? .english
        units = ReadingPlanner.units(paragraphs, defaultLanguage: language)
        guard !units.isEmpty else {
            state = .noText
            return
        }
        index = ReadingPlanner.firstUnit(onOrAfter: session.pageIndex, in: units) ?? 0
        activateAudio()
        setUpRemoteCommands()
        speakCurrent()
    }

    func stop() {
        state = .stopped
        current = nil
        _ = synthesizer.stopSpeaking(at: .immediate)
        session.pdfView.highlightedSelections = nil
        tearDownRemoteCommands()
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers.removeAll()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if ReadAloudController.active === self { ReadAloudController.active = nil }
    }

    func togglePlayPause() {
        switch state {
        case .playing: pause()
        case .paused: resume()
        case .finished, .stopped:
            index = 0
            activateAudio()
            speakCurrent()
        default: break
        }
    }

    func pause() {
        guard state == .playing else { return }
        _ = synthesizer.pauseSpeaking(at: .word)
        state = .paused
        updateNowPlaying()
    }

    func resume() {
        guard state == .paused else { return }
        activateAudio()
        if synthesizer.isPaused { _ = synthesizer.continueSpeaking() } else { speakCurrent() }
        state = .playing
        updateNowPlaying()
    }

    func next() {
        guard index + 1 < units.count else { return }
        index += 1
        restartCurrent()
    }

    func previous() {
        index = max(index - 1, 0)
        restartCurrent()
    }

    // MARK: - Speaking

    private func restartCurrent() {
        current = nil
        _ = synthesizer.stopSpeaking(at: .immediate)
        speakCurrent()
    }

    private func speakCurrent() {
        guard let unit = currentUnit else {
            finish()
            return
        }
        let u = AVSpeechUtterance(string: unit.text)
        u.voice = VoiceCatalog.voice(for: unit.language)
        u.rate = SpeechRate.utteranceRate(
            multiplier: speed, minimum: AVSpeechUtteranceMinimumSpeechRate, normal: AVSpeechUtteranceDefaultSpeechRate,
            maximum: AVSpeechUtteranceMaximumSpeechRate)
        u.postUtteranceDelay = 0.15
        u.prefersAssistiveTechnologySettings = false
        current = u
        state = .playing
        highlight(unit)
        updateNowPlaying()
        synthesizer.speak(u)
    }

    private func finished(_ utterance: AVSpeechUtterance) {
        guard utterance === current, state == .playing else { return }
        if index + 1 < units.count {
            index += 1
            speakCurrent()
        } else {
            finish()
        }
    }

    private func finish() {
        state = .finished
        current = nil
        session.pdfView.highlightedSelections = nil
        updateNowPlaying()
    }

    /// Highlight the paragraph (engine box → PDFKit page space) and scroll to it.
    private func highlight(_ unit: ReadingUnit) {
        let view = session.pdfView
        guard let page = session.pdf?.page(at: unit.page) else { return }
        if session.pageIndex != unit.page { session.pageIndex = unit.page }
        guard let box = unit.bbox else {
            view.highlightedSelections = nil
            view.go(to: page)
            return
        }
        let crop = page.bounds(for: .cropBox)
        let r = box.pdfRect(boxX: crop.minX, boxY: crop.minY, boxHeight: crop.height)
        let rect = CGRect(x: r.x, y: r.y, width: r.width, height: r.height).insetBy(dx: -2, dy: -2)
        if let selection = page.selection(for: rect) {
            selection.color = UIColor.systemYellow.withAlphaComponent(0.45)
            view.highlightedSelections = [selection]
        }
        view.go(to: rect, on: page)
    }

    // MARK: - Audio session, Now Playing, remote commands

    private func activateAudio() {
        let audio = AVAudioSession.sharedInstance()
        try? audio.setCategory(.playback, mode: .spokenAudio, options: [])
        try? audio.setActive(true)
        if observers.isEmpty {
            observers.append(NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification, object: audio, queue: .main
            ) { [weak self] note in
                let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
                MainActor.assumeIsolated {
                    if began { self?.pause() }
                }
            })
        }
    }

    private func updateNowPlaying() {
        guard let unit = currentUnit else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: FileNaming.baseName(session.name),
            MPMediaItemPropertyArtist: String(localized: "read.nowPlaying.page \(unit.page + 1)"),
            MPMediaItemPropertyAlbumTitle: "ZOOD PDF",
            MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index,
            MPNowPlayingInfoPropertyPlaybackQueueCount: units.count,
        ]
    }

    private func setUpRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        tearDownRemoteCommands()
        _ = c.playCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.resume() }
            return .success
        }
        _ = c.pauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.pause() }
            return .success
        }
        _ = c.togglePlayPauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.togglePlayPause() }
            return .success
        }
        _ = c.nextTrackCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.next() }
            return .success
        }
        _ = c.previousTrackCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.previous() }
            return .success
        }
        for cmd in [c.playCommand, c.pauseCommand, c.togglePlayPauseCommand, c.nextTrackCommand, c.previousTrackCommand] {
            cmd.isEnabled = true
        }
    }

    private func tearDownRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        for cmd in [c.playCommand, c.pauseCommand, c.togglePlayPauseCommand, c.nextTrackCommand, c.previousTrackCommand] {
            cmd.removeTarget(nil)
        }
    }
}

extension ReadAloudController: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in
            if let current = self.current, ObjectIdentifier(current) == id { self.finished(current) }
        }
    }
}

/// Installed voices, ranked (Premium > Enhanced > default), and the user's choices.
enum VoiceCatalog {
    static func installed() -> [VoiceInfo] {
        AVSpeechSynthesisVoice.speechVoices().map { v in
            VoiceInfo(
                id: v.identifier, name: v.name, language: v.language,
                quality: VoiceQuality(rawValue: v.quality.rawValue) ?? .standard,
                isNovelty: v.voiceTraits.contains(.isNoveltyVoice),
                isPersonal: v.voiceTraits.contains(.isPersonalVoice))
        }
    }

    static func savedID(for language: ContentLanguage) -> String? {
        UserDefaults.standard.string(forKey: "read.voice.\(language.rawValue)")
    }

    static func save(_ id: String?, for language: ContentLanguage) {
        UserDefaults.standard.set(id, forKey: "read.voice.\(language.rawValue)")
    }

    static func voice(for language: ContentLanguage) -> AVSpeechSynthesisVoice? {
        if let v = VoiceRanker.resolve(savedID: savedID(for: language), voices: installed(), for: language),
           let voice = AVSpeechSynthesisVoice(identifier: v.id) {
            return voice
        }
        return AVSpeechSynthesisVoice(language: language == .arabic ? "ar-SA" : "en-US")
    }
}
