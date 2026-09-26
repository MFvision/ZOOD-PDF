import CryptoKit
import Foundation
import Observation
import ZoodCore

/// The portable model file: downloaded once when the user taps Download (size shown first),
/// resumable in the background, verified against the pinned SHA-256, stored in Application
/// Support/Models and excluded from iCloud/iTunes backup. A .gguf can be imported from Files
/// instead. After that everything works offline.
@MainActor @Observable
final class ModelManager {
    static let shared = ModelManager()

    enum State: Equatable {
        case idle
        case downloading(received: Int64, total: Int64)
        case paused
        case verifying
        case failed(String)
    }

    private(set) var installed: LocalModelSpec?
    private(set) var state: State = .idle
    /// The model being downloaded (the recommended one unless the user picked the other).
    private(set) var downloading: LocalModelSpec?

    static let sessionID = "sa.zood.pdf.models"
    nonisolated static var directory: URL {
        URL.applicationSupportDirectory.appendingPathComponent("Models", isDirectory: true)
    }
    nonisolated private static var manifestURL: URL { directory.appendingPathComponent("installed.json") }
    nonisolated static var resumeDataURL: URL { directory.appendingPathComponent("download.resume") }
    nonisolated private static var pendingURL: URL { directory.appendingPathComponent("pending.json") }

    @ObservationIgnored private var sessionStorage: URLSession?
    /// One background session for the app's lifetime (same identifier after a relaunch, so
    /// transfers that continued in the background report back here).
    private var session: URLSession {
        if let s = sessionStorage { return s }
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionID)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.allowsCellularAccess = true
        let s = URLSession(configuration: config, delegate: DownloadDelegate(manager: self), delegateQueue: nil)
        sessionStorage = s
        return s
    }
    /// Set by the app delegate when iOS relaunches the app for finished background transfers.
    @ObservationIgnored var backgroundCompletion: (() -> Void)?

    var recommended: LocalModelSpec {
        LocalModelCatalog.recommended(physicalMemory: ProcessInfo.processInfo.physicalMemory)
    }

    var installedPath: String? {
        installed.map { Self.directory.appendingPathComponent($0.fileName).path }
    }

    init() {
        if let data = try? Data(contentsOf: Self.manifestURL),
           let spec = try? JSONDecoder().decode(LocalModelSpec.self, from: data),
           FileManager.default.fileExists(atPath: Self.directory.appendingPathComponent(spec.fileName).path) {
            installed = spec
        }
        if let data = try? Data(contentsOf: Self.pendingURL),
           let spec = try? JSONDecoder().decode(LocalModelSpec.self, from: data) {
            downloading = spec
            state = FileManager.default.fileExists(atPath: Self.resumeDataURL.path) ? .paused : .idle
        }
    }

    /// Reconnect to a transfer that continued while the app was not running.
    func reconnect() {
        guard downloading != nil else { return }
        session.getAllTasks { tasks in
            let running = tasks.contains { $0.state == .running }
            Task { @MainActor in
                if running, case .idle = self.state { self.state = .downloading(received: 0, total: self.downloading?.byteCount ?? 0) }
            }
        }
    }

    /// Free space needed: the file plus a margin for the move.
    func hasSpace(for spec: LocalModelSpec) -> Bool {
        let values = try? URL.applicationSupportDirectory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        guard let free = values?.volumeAvailableCapacityForImportantUsage else { return true }
        return free > spec.byteCount + 200_000_000
    }

    // MARK: - Download

    func download(_ spec: LocalModelSpec) {
        guard hasSpace(for: spec) else {
            state = .failed(String(localized: "ai.model.noSpace"))
            return
        }
        prepareDirectory()
        downloading = spec
        try? JSONEncoder().encode(spec).write(to: Self.pendingURL, options: .atomic)
        let task: URLSessionDownloadTask
        if let resume = try? Data(contentsOf: Self.resumeDataURL) {
            task = session.downloadTask(withResumeData: resume)
            try? FileManager.default.removeItem(at: Self.resumeDataURL)
        } else {
            var request = URLRequest(url: spec.url)
            request.setValue("ZOOD-PDF-iOS", forHTTPHeaderField: "User-Agent")
            task = session.downloadTask(with: request)
        }
        task.countOfBytesClientExpectsToReceive = spec.byteCount
        state = .downloading(received: 0, total: spec.byteCount)
        task.resume()
    }

    func pause() {
        session.getAllTasks { tasks in
            for t in tasks {
                (t as? URLSessionDownloadTask)?.cancel(byProducingResumeData: { data in
                    if let data { try? data.write(to: ModelManager.resumeDataURL, options: .atomic) }
                })
            }
        }
        state = .paused
    }

    func cancel() {
        session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
        try? FileManager.default.removeItem(at: Self.resumeDataURL)
        try? FileManager.default.removeItem(at: Self.pendingURL)
        downloading = nil
        state = .idle
    }

    /// Remove the installed model (frees about 1 GB).
    func deleteInstalled() async {
        await PortableModelRunner.shared.unload()
        if let spec = installed {
            try? FileManager.default.removeItem(at: Self.directory.appendingPathComponent(spec.fileName))
        }
        try? FileManager.default.removeItem(at: Self.manifestURL)
        installed = nil
    }

    // Called by the delegate.

    func progress(received: Int64, total: Int64) {
        if case .paused = state { return }
        state = .downloading(received: received, total: total > 0 ? total : (downloading?.byteCount ?? 0))
    }

    func failed(_ error: any Error, resumeData: Data?) {
        if let resumeData {
            try? resumeData.write(to: Self.resumeDataURL, options: .atomic)
            state = .paused
        } else if (error as NSError).code == NSURLErrorCancelled {
            // pause() or cancel() already set the state.
        } else {
            state = .failed(error.localizedDescription)
        }
    }

    /// The downloaded file (already moved out of the system's temporary location).
    func finished(staged: URL) async {
        guard let spec = downloading else {
            try? FileManager.default.removeItem(at: staged)
            return
        }
        state = .verifying
        let hash = await Self.sha256(of: staged)
        guard hash == spec.sha256 else {
            try? FileManager.default.removeItem(at: staged)
            state = .failed(String(localized: "ai.model.checksumFailed"))
            return
        }
        do {
            try install(staged, as: spec)
            try? FileManager.default.removeItem(at: Self.pendingURL)
            downloading = nil
            state = .idle
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func backgroundEventsFinished() {
        backgroundCompletion?()
        backgroundCompletion = nil
    }

    // MARK: - Import

    /// Import a .gguf picked in Files. The header is checked; a file identical to a catalog
    /// model is recognised by its SHA-256.
    func importModel(from url: URL) async {
        state = .verifying
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        prepareDirectory()
        let staged = Self.directory.appendingPathComponent("import.partial")
        do {
            try? FileManager.default.removeItem(at: staged)
            let handle = try FileHandle(forReadingFrom: url)
            let header = try handle.read(upToCount: 8) ?? Data()
            try handle.close()
            guard GGUFFile.looksValid(header: header) else {
                state = .failed(String(localized: "ai.model.notGGUF"))
                return
            }
            try FileManager.default.copyItem(at: url, to: staged)
            let attributes = try FileManager.default.attributesOfItem(atPath: staged.path)
            let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
            let hash = await Self.sha256(of: staged)
            let spec = LocalModelCatalog.imported(fileName: url.lastPathComponent, byteCount: size, sha256: hash)
            try install(staged, as: spec)
            state = .idle
        } catch {
            try? FileManager.default.removeItem(at: staged)
            state = .failed(error.localizedDescription)
        }
    }

    // MARK: - Files

    private func prepareDirectory() {
        try? FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var dir = Self.directory
        try? dir.setResourceValues(values)
    }

    private func install(_ staged: URL, as spec: LocalModelSpec) throws {
        let dest = Self.directory.appendingPathComponent(spec.fileName)
        if let old = installed, old.fileName != spec.fileName {
            try? FileManager.default.removeItem(at: Self.directory.appendingPathComponent(old.fileName))
        }
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: staged, to: dest)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var d = dest
        try? d.setResourceValues(values)
        try JSONEncoder().encode(spec).write(to: Self.manifestURL, options: .atomic)
        installed = spec
    }

    /// Streaming SHA-256 (4 MB reads, off the main actor).
    nonisolated static func sha256(of url: URL) async -> String {
        await Task.detached(priority: .utility) { () -> String in
            guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
            defer { try? handle.close() }
            var hasher = SHA256()
            while let chunk = try? handle.read(upToCount: 4 << 20), !chunk.isEmpty {
                hasher.update(data: chunk)
            }
            return GGUFFile.hex(hasher.finalize())
        }.value
    }

    nonisolated static var stagedDownloadURL: URL { directory.appendingPathComponent("download.partial") }
}

/// URLSession callbacks arrive on a background queue; they are forwarded to the manager.
final class DownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    // Only read on callbacks; the manager lives for the whole process.
    private weak var manager: ModelManager?

    init(manager: ModelManager) {
        self.manager = manager
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let m = manager
        Task { @MainActor in m?.progress(received: totalBytesWritten, total: totalBytesExpectedToWrite) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The system deletes `location` when this returns: move it now.
        let staged = ModelManager.stagedDownloadURL
        try? FileManager.default.removeItem(at: staged)
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 200
        guard status == 200, (try? FileManager.default.moveItem(at: location, to: staged)) != nil else {
            let m = manager
            Task { @MainActor in
                m?.failed(URLError(.badServerResponse), resumeData: nil)
            }
            return
        }
        let m = manager
        Task { @MainActor in await m?.finished(staged: staged) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let error else { return }
        let resume = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        let m = manager
        Task { @MainActor in m?.failed(error, resumeData: resume) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let m = manager
        Task { @MainActor in m?.backgroundEventsFinished() }
    }
}
