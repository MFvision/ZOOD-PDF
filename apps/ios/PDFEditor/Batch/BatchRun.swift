import Foundation
import Observation
import SwiftUI

/// A file of the batch: where it is and what it is called.
struct BatchInput: Identifiable, Hashable, Sendable {
    let id: UUID
    let url: URL
    /// Without its extension.
    let name: String

    init(url: URL, id: UUID = UUID()) {
        self.id = id
        self.url = url
        self.name = url.deletingPathExtension().lastPathComponent
    }
}

/// Where a file is in the batch.
enum BatchFileState: Equatable, Sendable {
    case waiting
    /// On step `step` (zero-based), or reading it (-1).
    case working(step: Int)
    case done(output: URL)
    /// At step `step` (nil: before any step, reading or opening it, or writing).
    case failed(step: Int?, BatchFailure)
    /// Stop was pressed before this file was finished.
    case cancelled
    /// iOS took the background time back before this file was finished.
    case stoppedBySystem

    var isFinished: Bool {
        switch self {
        case .waiting, .working: false
        default: true
        }
    }
}

/// Runs a sequence of steps over many files, one file at a time, and keeps
/// what became of each. A file is read only when its turn comes; its steps
/// run in order; its result is written as a new file in the output folder
/// under a name not taken there — never over a file, never over the
/// original, which is only ever read. A file that fails says why and the
/// batch goes on. Stop ends the batch after the step under way; if iOS takes
/// the background time back, the batch stops the same way and says so.
@MainActor @Observable
final class BatchRun {
    struct Summary: Equatable, Sendable {
        var done = 0
        var failed = 0
        var cancelled = 0
        var stoppedBySystem = 0
    }

    private(set) var inputs: [BatchInput] = []
    private(set) var states: [UUID: BatchFileState] = [:]
    private(set) var isRunning = false
    /// The steps of the run under way (or the last one), for the report.
    private(set) var steps: [BatchStep] = []
    /// The last run's counts, once it is over.
    private(set) var summary: Summary?
    /// The system ended the background time: said plainly on the screen.
    private(set) var systemStopped = false
    /// How the run is being kept alive in the background.
    var backgroundKind: BatchBackground.Kind { background.kind }

    private var work: Task<Void, Never>?
    private var stopReason: BatchFileState = .cancelled
    private let background = BatchBackground()

    // MARK: - The files

    func add(_ urls: [URL]) {
        guard !isRunning else { return }
        for url in urls where !inputs.contains(where: { $0.url.standardizedFileURL == url.standardizedFileURL }) {
            let input = BatchInput(url: url)
            inputs.append(input)
            states[input.id] = .waiting
        }
        summary = nil
    }

    func remove(_ input: BatchInput) {
        guard !isRunning else { return }
        inputs.removeAll { $0.id == input.id }
        states[input.id] = nil
    }

    func removeAll() {
        guard !isRunning else { return }
        inputs = []
        states = [:]
        summary = nil
        systemStopped = false
    }

    func state(of input: BatchInput) -> BatchFileState {
        states[input.id] ?? .waiting
    }

    /// The files finished so far in this run.
    var finishedCount: Int { inputs.filter { state(of: $0).isFinished }.count }

    /// The results written by the last run, in the order of the files.
    var outputs: [URL] {
        inputs.compactMap { if case let .done(url) = state(of: $0) { url } else { nil } }
    }

    // MARK: - Running

    struct Options: Sendable {
        var steps: [BatchStep]
        /// Tried on a file that asks for one.
        var password: String?
        var openPassword: String?
        var ownerPassword: String?
        /// Where the results go: the app's Documents folder, so they are in
        /// My documents and in Files under the app's name.
        var outputFolder: URL
        /// Put between the original's name and the extension.
        var suffix: String
        var languages: [String]
        var locale: Locale
    }

    func start(_ options: Options) {
        guard !isRunning, !inputs.isEmpty, BatchSequence.problem(options.steps) == nil else { return }
        isRunning = true
        systemStopped = false
        summary = nil
        steps = options.steps
        stopReason = .cancelled
        for input in inputs { states[input.id] = .waiting }
        let inputs = self.inputs
        background.begin(title: String(localized: "Batch", locale: options.locale),
                         subtitle: String(localized: "\(0) of \(inputs.count) files", locale: options.locale),
                         total: inputs.count) { [weak self] in
            self?.stopBySystem()
        }
        work = Task {
            var summary = Summary()
            var taken = Set<String>()
            for input in inputs {
                if Task.isCancelled {
                    states[input.id] = stopReason
                    count(stopReason, into: &summary)
                    continue
                }
                let state = await process(input, options: options, taken: &taken)
                states[input.id] = state
                count(state, into: &summary)
                background.progress(done: summary.done + summary.failed,
                                    subtitle: String(localized: "\(summary.done + summary.failed) of \(inputs.count) files", locale: options.locale))
            }
            self.summary = summary
            isRunning = false
            background.end(success: summary.failed == 0 && summary.cancelled == 0 && summary.stoppedBySystem == 0)
        }
    }

    /// Stop: the step under way finishes; nothing more is written.
    func stop() {
        stopReason = .cancelled
        work?.cancel()
    }

    /// iOS took the background time back.
    func stopBySystem() {
        guard isRunning else { return }
        systemStopped = true
        stopReason = .stoppedBySystem
        work?.cancel()
    }

    /// Waits for the run under way to end (for tests).
    func finish() async {
        await work?.value
    }

    private func count(_ state: BatchFileState, into summary: inout Summary) {
        switch state {
        case .done: summary.done += 1
        case .failed: summary.failed += 1
        case .stoppedBySystem: summary.stoppedBySystem += 1
        default: summary.cancelled += 1
        }
    }

    private func process(_ input: BatchInput, options: Options, taken: inout Set<String>) async -> BatchFileState {
        states[input.id] = .working(step: -1)
        let url = input.url
        let bytes: Data? = await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            return try? Data(contentsOf: url)
        }.value
        guard let bytes else { return .failed(step: nil, .unreadable) }
        var doc: BatchDoc
        switch await BatchEngine.opening(bytes, password: options.password) {
        case let .success(password): doc = BatchDoc(bytes: bytes, password: password)
        case let .failure(failure): return .failed(step: nil, failure)
        }
        let context = BatchContext(name: input.name, openPassword: options.openPassword, ownerPassword: options.ownerPassword,
                                   languages: options.languages, now: .now, locale: options.locale)
        for (index, step) in options.steps.enumerated() {
            if Task.isCancelled { return stopReason }
            states[input.id] = .working(step: index)
            do {
                doc = try await BatchEngine.run(step, on: doc, context: context)
            } catch let failure as BatchFailure {
                return .failed(step: index, failure)
            } catch is CancellationError {
                return stopReason
            } catch {
                return .failed(step: index, .core(error.localizedDescription))
            }
        }
        if Task.isCancelled { return stopReason }
        do {
            let output = try Self.write(doc, for: input, in: options.outputFolder, suffix: options.suffix, taken: &taken)
            return .done(output: output)
        } catch {
            return .failed(step: nil, .write(error.localizedDescription))
        }
    }

    // MARK: - Names

    /// A suffix as typed, made safe for a file name.
    static func cleanSuffix(_ suffix: String) -> String {
        let banned = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters).union(.newlines)
        let kept = String(String.UnicodeScalarView(suffix.unicodeScalars.filter { !banned.contains($0) }))
        return String(kept.trimmingCharacters(in: .whitespaces).prefix(40))
    }

    /// "report – processed.pdf"; "report – processed 2.pdf" when that is
    /// taken in the folder or by an earlier result of this run. Never the
    /// original's own name, even with an empty suffix.
    static func outputURL(for input: BatchInput, fileExtension: String, in folder: URL, suffix: String, taken: inout Set<String>) -> URL {
        let clean = cleanSuffix(suffix)
        let stem = ScanSession.safeFileName(input.name)
        let base = clean.isEmpty ? stem : "\(stem) – \(clean)"
        var n = 1
        while true {
            let name = n == 1 ? "\(base).\(fileExtension)" : "\(base) \(n).\(fileExtension)"
            let candidate = folder.appending(path: name)
            let key = name.precomposedStringWithCanonicalMapping.lowercased()
            let isOriginal = candidate.standardizedFileURL.path == input.url.standardizedFileURL.path
            if !isOriginal, !taken.contains(key), !FileManager.default.fileExists(atPath: candidate.path) {
                taken.insert(key)
                return candidate
            }
            n += 1
        }
    }

    static func write(_ doc: BatchDoc, for input: BatchInput, in folder: URL, suffix: String, taken: inout Set<String>) throws -> URL {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = outputURL(for: input, fileExtension: doc.fileExtension, in: folder, suffix: suffix, taken: &taken)
        // `.withoutOverwriting`: if a file appeared there meanwhile, this fails
        // rather than replace it.
        try doc.bytes.write(to: url, options: .withoutOverwriting)
        return url
    }
}
