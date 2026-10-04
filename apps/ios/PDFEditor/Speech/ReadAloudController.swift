import AVFoundation
import MediaPlayer
import Observation
import PDFKit
import SwiftUI
import WarraqCore

/// Reads the document aloud with the system's voices: sentence by sentence
/// from the core's logical-order text (so Arabic is read as it is read),
/// the sentence being spoken highlighted on the page, on to the next page
/// when one ends, and on with the screen locked (a playback audio session,
/// and the Lock Screen's play, pause, next and previous).
@MainActor @Observable
final class ReadAloudController: NSObject {
    enum State: Equatable {
        case idle
        case loading
        case playing
        case paused
    }

    private(set) var state: State = .idle
    /// The page being read, zero-based.
    private(set) var page = 0
    private(set) var sentences: [SpokenSentence] = []
    private(set) var index = 0
    private(set) var documentName = ""
    /// The last thing that went wrong, shown once.
    var error: LocalizedStringKey?
    var rate: Float = SpeechVoices.rate {
        didSet {
            SpeechVoices.rate = rate
            // A new rate takes effect from the next sentence: the current
            // utterance is restarted with it.
            if state == .playing { restartCurrent() }
        }
    }

    private let synthesizer = AVSpeechSynthesizer()
    private weak var model: DocumentModel?
    private weak var pdfView: PDFView?
    private var highlights: [(page: PDFPage, annotation: PDFAnnotation)] = []
    private var remoteCommandsSet = false
    /// Set while an utterance is being replaced (a new rate, a skip), so its
    /// cancellation does not read as the end of the sentence.
    private var replacing = false
    private var loadTask: Task<Void, Never>?

    override init() {
        super.init()
        synthesizer.delegate = self
        synthesizer.usesApplicationAudioSession = true
    }

    var isActive: Bool { state != .idle }
    var currentSentence: SpokenSentence? {
        sentences.indices.contains(index) ? sentences[index] : nil
    }

    /// The PDFKit view the highlight is drawn in and the pages turned in.
    func attach(_ view: PDFView) {
        pdfView = view
    }

    // MARK: - Control

    /// Starts reading `model` from `page`, from the beginning of the page.
    func start(_ model: DocumentModel, from page: Int) {
        stop()
        self.model = model
        documentName = model.name
        self.page = max(0, min(page, max(model.pageCount - 1, 0)))
        state = .loading
        setUpAudioSession()
        setUpRemoteCommands()
        loadTask = Task { [weak self] in
            await self?.load(page: self?.page ?? 0, thenSpeak: true)
        }
    }

    func pause() {
        guard state == .playing else { return }
        synthesizer.pauseSpeaking(at: .word)
        state = .paused
        updateNowPlaying()
    }

    func resume() {
        guard state == .paused else { return }
        if synthesizer.isPaused {
            synthesizer.continueSpeaking()
        } else {
            speakCurrent()
        }
        state = .playing
        updateNowPlaying()
    }

    func togglePlayPause() {
        switch state {
        case .playing: pause()
        case .paused: resume()
        default: break
        }
    }

    func stop() {
        loadTask?.cancel()
        loadTask = nil
        replacing = true
        synthesizer.stopSpeaking(at: .immediate)
        replacing = false
        clearHighlight()
        sentences = []
        index = 0
        state = .idle
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The next sentence, or the next page's first.
    func next() {
        guard isActive else { return }
        if index + 1 < sentences.count {
            index += 1
            restartCurrent()
        } else {
            advancePage()
        }
    }

    /// The sentence before, or the previous page's last.
    func previous() {
        guard isActive else { return }
        if index > 0 {
            index -= 1
            restartCurrent()
        } else if page > 0 {
            let wasPlaying = state != .paused
            replacing = true
            synthesizer.stopSpeaking(at: .immediate)
            replacing = false
            page -= 1
            loadTask = Task { [weak self] in
                await self?.load(page: self?.page ?? 0, thenSpeak: wasPlaying, fromEnd: true)
            }
        }
    }

    // MARK: - Reading

    /// Reads the page's lines from the core and cuts them into sentences.
    private func load(page: Int, thenSpeak: Bool, fromEnd: Bool = false) async {
        guard let model, let core = model.engine else {
            stop()
            return
        }
        let lines = (try? await core.textLines(page: page)) ?? []
        if Task.isCancelled { return }
        let hint = model.isRightToLeft ? "ar" : nil
        sentences = SentenceMap.sentences(of: lines, hint: hint)
        self.page = page
        if sentences.isEmpty {
            // A page without text (a scan): on to the next, or the end.
            if page + 1 < model.pageCount {
                await load(page: page + 1, thenSpeak: thenSpeak)
            } else {
                error = "There is no text to read. Scan & OCR can add some."
                stop()
            }
            return
        }
        index = fromEnd ? sentences.count - 1 : 0
        showPage()
        if thenSpeak {
            state = .playing
            speakCurrent()
        } else {
            state = .paused
            highlightCurrent()
            updateNowPlaying()
        }
    }

    private func advancePage() {
        guard let model else { return stop() }
        if page + 1 < model.pageCount {
            replacing = true
            synthesizer.stopSpeaking(at: .immediate)
            replacing = false
            let wasPlaying = state == .playing
            loadTask = Task { [weak self] in
                await self?.load(page: (self?.page ?? 0) + 1, thenSpeak: wasPlaying)
            }
        } else {
            stop()
        }
    }

    private func speakCurrent() {
        guard let sentence = currentSentence else { return advancePage() }
        highlightCurrent()
        let utterance = AVSpeechUtterance(string: sentence.text)
        utterance.voice = SpeechVoices.voice(for: sentence.language) ?? AVSpeechSynthesisVoice(language: sentence.language)
        utterance.rate = rate
        utterance.postUtteranceDelay = 0.12
        synthesizer.speak(utterance)
        updateNowPlaying()
    }

    private func restartCurrent() {
        let wasPlaying = state == .playing
        replacing = true
        synthesizer.stopSpeaking(at: .immediate)
        replacing = false
        if wasPlaying {
            speakCurrent()
        } else {
            highlightCurrent()
            updateNowPlaying()
        }
    }

    // MARK: - The page

    /// The highlight over the sentence's lines: highlight annotations added
    /// to PDFKit's page for as long as the sentence is read, never saved
    /// (the document's bytes come from the core, not from PDFKit).
    private func highlightCurrent() {
        clearHighlight()
        guard let sentence = currentSentence, let pdfPage = model?.pdf?.page(at: page) else { return }
        let frame = PageSpace.Frame(page: pdfPage)
        for rect in sentence.rects {
            let bounds = PageSpace.userRect(fromStored: rect.insetBy(dx: -1, dy: -1), in: frame)
            let annotation = PDFAnnotation(bounds: bounds, forType: .highlight, withProperties: nil)
            annotation.color = UIColor.systemYellow.withAlphaComponent(0.45)
            annotation.quadrilateralPoints = [
                NSValue(cgPoint: CGPoint(x: 0, y: bounds.height)),
                NSValue(cgPoint: CGPoint(x: bounds.width, y: bounds.height)),
                NSValue(cgPoint: CGPoint(x: 0, y: 0)),
                NSValue(cgPoint: CGPoint(x: bounds.width, y: 0)),
            ]
            annotation.shouldPrint = false
            pdfPage.addAnnotation(annotation)
            highlights.append((pdfPage, annotation))
        }
        pdfView?.setNeedsDisplay()
        // Keep the sentence in view.
        if let pdfView, let first = sentence.rects.first {
            let target = PageSpace.userRect(fromStored: first, in: frame)
            let onScreen = pdfView.convert(target, from: pdfPage)
            if !pdfView.bounds.insetBy(dx: 0, dy: 40).contains(onScreen) {
                pdfView.go(to: target.insetBy(dx: -20, dy: -80), on: pdfPage)
            }
        }
    }

    private func clearHighlight() {
        for (page, annotation) in highlights {
            page.removeAnnotation(annotation)
        }
        highlights = []
        pdfView?.setNeedsDisplay()
    }

    private func showPage() {
        guard let pdfView, let pdfPage = model?.pdf?.page(at: page), pdfView.currentPage !== pdfPage else { return }
        pdfView.go(to: pdfPage)
        model?.currentPage = page
    }

    // MARK: - The audio session and the Lock Screen

    private func setUpAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            // Without the session the voice still plays while the app is up.
        }
    }

    private func setUpRemoteCommands() {
        guard !remoteCommandsSet else { return }
        remoteCommandsSet = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.resume() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.pause() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.togglePlayPause() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.next() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.previous() }
            return .success
        }
        center.stopCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
            return .success
        }
    }

    private func updateNowPlaying() {
        guard isActive else { return }
        let pageCount = model?.pageCount ?? 0
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: documentName,
            MPMediaItemPropertyArtist: AppName.plain,
            MPMediaItemPropertyAlbumTitle: String(localized: "Page \(page + 1) of \(pageCount)"),
            MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyIsLiveStream: false,
        ]
        if !sentences.isEmpty {
            info[MPNowPlayingInfoPropertyPlaybackProgress] = Double(index) / Double(sentences.count)
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

// The synthesizer reports on the main thread; each report is taken as
// main-actor work.
extension ReadAloudController: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        MainActor.assumeIsolated {
            guard state == .playing, !replacing else { return }
            if index + 1 < sentences.count {
                index += 1
                speakCurrent()
            } else {
                advancePage()
            }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        // A cancellation is one of ours (a stop, a skip, a new rate).
    }
}
