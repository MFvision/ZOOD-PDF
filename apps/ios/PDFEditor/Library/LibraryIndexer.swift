import CoreGraphics
import Foundation
import ImageIO
import Observation
import UIKit
import WarraqCore
import WidgetKit

/// Where an indexing run stands, for the Library's status bar.
struct IndexingProgress: Equatable, Sendable {
    enum Stage: Equatable, Sendable {
        case listing
        case reading
        case recognizing(page: Int, of: Int)
        case saving
    }

    var done: Int
    var total: Int
    var current: String
    var stage: Stage

    var fraction: Double { total == 0 ? 0 : Double(done) / Double(total) }
}

/// What a run did, said once it is over.
struct IndexingSummary: Equatable, Sendable {
    var added = 0
    var unchanged = 0
    var skipped = 0
    var recognized = 0
    var forgotten = 0
    var stopped = false
    var finished = Date.now
}

/// Reads the Library's files into the index — the app's Documents and the
/// chosen folder — with progress and a Stop that stops between files. A PDF
/// is read by the core; a page with no text of its own, and a picture, go
/// through the OCR seam (`TextRecognizer.shared`); the index takes each
/// document's text under its key; Core Spotlight and the thumbnails follow.
/// A file that has not changed since it went in (its size and date the
/// same) is not read again.
@MainActor @Observable
final class LibraryIndexer {
    /// The bounds one run keeps to. Past them a document is cut and the
    /// index told so (`truncated`); a run is never stopped by one file.
    enum Limits {
        static let textPages = 400
        static let ocrPages = 24
        static let charsPerDocument = 400_000
        static let imagePixels = 2400
        static let renderScale: Float = 2.0
        static let thumbnailWidth = 320
    }

    private(set) var progress: IndexingProgress?
    private(set) var summary: IndexingSummary?
    private(set) var error: String?
    /// Every document the index holds, by key, after the last run.
    private(set) var catalog: [String: IndexedDocument] = [:]
    private(set) var stats = LibraryStats.empty
    private(set) var rules: [TagRule] = []

    let index: LibraryIndex
    let documentsFolder: URL
    let thumbnailsFolder: URL
    private let knownKeysURL: URL
    private var task: Task<Void, Never>?

    var isRunning: Bool { progress != nil }

    init(index: LibraryIndex, documentsFolder: URL, thumbnailsFolder: URL = AppGroup.thumbnailsURL) {
        self.index = index
        self.documentsFolder = documentsFolder
        self.thumbnailsFolder = thumbnailsFolder
        self.knownKeysURL = index.fileURL.deletingLastPathComponent().appending(path: "library-keys.json")
    }

    /// The OCR languages from Settings, as BCP-47 codes, Arabic and English
    /// unless chosen otherwise.
    static var ocrLanguages: [String] {
        let chosen = UserDefaults.standard.stringArray(forKey: SettingsKey.ocrLanguages) ?? []
        return chosen.isEmpty ? ["ar", "en"] : chosen
    }

    // MARK: - The catalog

    /// Reads what the index holds for the listed files, and the tags and rules.
    func reloadCatalog(files: [LibraryFile]) async {
        var found: [String: IndexedDocument] = [:]
        for file in files {
            if let document = try? await index.document(key: file.key) {
                found[file.key] = document
            }
        }
        catalog = found
        stats = (try? await index.stats()) ?? .empty
        rules = (try? await index.rules())?.rules ?? []
    }

    func thumbnailURL(for key: String) -> URL? {
        let url = thumbnailsFolder.appending(path: LibraryListing.thumbnailFile(for: key))
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: - Running

    /// Reads every file of the sources that is new or changed. One run at a
    /// time; a second call while one runs does nothing.
    func run(chosen: ChosenFolder?) {
        guard task == nil else { return }
        error = nil
        summary = nil
        progress = IndexingProgress(done: 0, total: 0, current: "", stage: .listing)
        let recognizer = TextRecognizer.shared
        let languages = Self.ocrLanguages
        let worker = Worker(index: index, documentsFolder: documentsFolder, chosen: chosen, thumbnailsFolder: thumbnailsFolder,
                            knownKeysURL: knownKeysURL, recognizer: recognizer, languages: languages)
        task = Task.detached(priority: .utility) { [weak self] in
            let outcome = await worker.run { progress in
                await MainActor.run { self?.progress = progress }
            }
            await MainActor.run {
                guard let self else { return }
                self.task = nil
                self.progress = nil
                switch outcome {
                case let .success(summary):
                    self.summary = summary
                case let .failure(failure):
                    self.error = failure.localizedDescription
                }
            }
            let files = await worker.listedFiles
            await self?.reloadCatalog(files: files)
            await MainActor.run { WidgetCenter.shared.reloadAllTimelines() }
        }
    }

    /// Stops after the file being read now.
    func stop() {
        task?.cancel()
    }

    /// Takes documents out of the index and out of Spotlight (the files
    /// are not touched).
    func forget(keys: [String]) async {
        guard !keys.isEmpty else { return }
        try? await index.forget(keys: keys)
        await SpotlightIndex.delete(keys: keys)
        for key in keys {
            catalog[key] = nil
            try? FileManager.default.removeItem(at: thumbnailsFolder.appending(path: LibraryListing.thumbnailFile(for: key)))
        }
        try? await index.save()
        stats = (try? await index.stats()) ?? .empty
    }

    /// Everything the index knows, gone: the index file, Spotlight's items,
    /// the thumbnails.
    func deleteEverything() async {
        stop()
        let keys = Array(catalog.keys)
        try? await index.forget(keys: keys)
        await SpotlightIndex.deleteAll()
        catalog = [:]
        stats = .empty
        try? FileManager.default.removeItem(at: knownKeysURL)
        try? await index.save()
    }

    // MARK: - Tags and rules

    func setTags(_ tags: [String], on key: String) async {
        let before = Set(catalog[key]?.tags ?? [])
        let after = Set(tags)
        _ = try? await index.tag(key: key, add: Array(after.subtracting(before)), remove: Array(before.subtracting(after)))
        if let document = try? await index.document(key: key) {
            catalog[key] = document
        }
        stats = (try? await index.stats()) ?? .empty
        try? await index.save()
    }

    func setRules(_ rules: [TagRule], apply: Bool) async -> Int {
        let answer = try? await index.rules(set: rules, apply: apply)
        self.rules = answer?.rules ?? rules
        if apply {
            for key in catalog.keys {
                if let document = try? await index.document(key: key) {
                    catalog[key] = document
                }
            }
        }
        stats = (try? await index.stats()) ?? .empty
        try? await index.save()
        return answer?.tagged ?? 0
    }

    // MARK: - The worker

    /// The run itself, off the main actor: lists, reads, recognizes, adds.
    actor Worker {
        let index: LibraryIndex
        let documentsFolder: URL
        let chosen: ChosenFolder?
        let thumbnailsFolder: URL
        let knownKeysURL: URL
        let recognizer: any TextRecognizing
        let languages: [String]
        private(set) var listedFiles: [LibraryFile] = []

        init(index: LibraryIndex, documentsFolder: URL, chosen: ChosenFolder?, thumbnailsFolder: URL, knownKeysURL: URL,
             recognizer: any TextRecognizing, languages: [String]) {
            self.index = index
            self.documentsFolder = documentsFolder
            self.chosen = chosen
            self.thumbnailsFolder = thumbnailsFolder
            self.knownKeysURL = knownKeysURL
            self.recognizer = recognizer
            self.languages = languages
        }

        func run(report: @Sendable (IndexingProgress) async -> Void) async -> Result<IndexingSummary, any Error> {
            var summary = IndexingSummary()
            let files = LibraryListing.files(documentsFolder: documentsFolder, chosen: chosen)
            listedFiles = files
            var progress = IndexingProgress(done: 0, total: files.count, current: "", stage: .reading)
            await report(progress)

            // Documents the index holds that no source holds any more.
            let listed = Set(files.map(\.key))
            let known = (try? JSONDecoder().decode([String].self, from: Data(contentsOf: knownKeysURL))) ?? []
            let gone = known.filter { !listed.contains($0) }
            if !gone.isEmpty {
                try? await index.forget(keys: gone)
                await SpotlightIndex.delete(keys: gone)
                for key in gone {
                    try? FileManager.default.removeItem(at: thumbnailsFolder.appending(path: LibraryListing.thumbnailFile(for: key)))
                }
                summary.forgotten = gone.count
            }

            var sinceSave = 0
            // The keys the index holds after this run: what it held, what was
            // read now, less what is gone — skipped files are not in it.
            var held = Set(known).subtracting(gone)
            for file in files {
                if Task.isCancelled {
                    summary.stopped = true
                    break
                }
                progress.current = file.name
                progress.stage = .reading
                await report(progress)
                do {
                    let result = try await read(file, progress: progress, report: report)
                    switch result {
                    case .unchanged:
                        summary.unchanged += 1
                        held.insert(file.key)
                    case let .added(recognized):
                        summary.added += 1
                        summary.recognized += recognized
                        sinceSave += 1
                        held.insert(file.key)
                    case .skipped:
                        summary.skipped += 1
                        held.remove(file.key)
                    }
                } catch is CancellationError {
                    summary.stopped = true
                    break
                } catch {
                    summary.skipped += 1
                }
                progress.done += 1
                await report(progress)
                if sinceSave >= 20 {
                    try? await index.save()
                    sinceSave = 0
                }
            }
            progress.stage = .saving
            await report(progress)
            do {
                try await index.save()
                try JSONEncoder().encode(Array(held).sorted()).write(to: knownKeysURL, options: .atomic)
            } catch {
                return .failure(error)
            }
            summary.finished = .now
            return .success(summary)
        }

        enum Outcome {
            case unchanged
            case added(recognized: Int)
            case skipped
        }

        private func read(_ file: LibraryFile, progress: IndexingProgress, report: @Sendable (IndexingProgress) async -> Void) async throws -> Outcome {
            if let known = try? await index.document(key: file.key), known.modified == file.modified, known.bytes == file.size {
                return .unchanged
            }
            let bytes = try readBytes(of: file)
            try Task.checkCancellation()
            let read: ReadDocument
            switch file.kind {
            case .pdf:
                guard let pdf = try await readPDF(bytes, progress: progress, report: report) else { return .skipped }
                read = pdf
            case .image:
                guard let image = try await readImage(bytes, progress: progress, report: report) else { return .skipped }
                read = image
            }
            try Task.checkCancellation()
            let outcome = try await index.add(key: file.key, name: file.name, kind: read.kind, modified: file.modified, bytes: file.size,
                                              pages: read.pageCount, text: read.pages)
            guard outcome.added else { return .skipped }
            if let thumbnail = read.thumbnail {
                try? FileManager.default.createDirectory(at: thumbnailsFolder, withIntermediateDirectories: true)
                try? thumbnail.write(to: thumbnailsFolder.appending(path: LibraryListing.thumbnailFile(for: file.key)), options: .atomic)
            }
            let date = outcome.date.flatMap { Self.isoDate.date(from: $0) }
            await SpotlightIndex.index(key: file.key, name: file.name, kind: read.kind, pages: read.pageCount,
                                       text: read.pages.map(\.text).joined(separator: "\n"),
                                       thumbnailURL: read.thumbnail == nil ? nil : thumbnailsFolder.appending(path: LibraryListing.thumbnailFile(for: file.key)),
                                       date: date)
            return .added(recognized: read.recognized)
        }

        private static let isoDate: DateFormatter = {
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd"
            return formatter
        }()

        struct ReadDocument {
            var kind: LibraryKind
            var pages: [PageText]
            var pageCount: Int
            var recognized: Int
            var thumbnail: Data?
        }

        /// Reads the file, coordinated, inside the chosen folder's scope
        /// when it is in there.
        private func readBytes(of file: LibraryFile) throws -> Data {
            func read() throws -> Data {
                var coordinationError: NSError?
                var bytes = Data()
                var innerError: (any Error)?
                NSFileCoordinator().coordinate(readingItemAt: file.url, options: [], error: &coordinationError) { url in
                    do {
                        bytes = try Data(contentsOf: url, options: .mappedIfSafe)
                    } catch {
                        innerError = error
                    }
                }
                if let error = coordinationError ?? (innerError as NSError?) { throw error }
                return bytes
            }
            if file.source == .folder, let chosen {
                return try chosen.withAccess { _ in try read() }
            }
            return try read()
        }

        /// A PDF: the core reads its text; pages with none go through OCR.
        /// A protected file is skipped — its password is not asked for here.
        private func readPDF(_ bytes: Data, progress: IndexingProgress, report: @Sendable (IndexingProgress) async -> Void) async throws -> ReadDocument? {
            let core: Core
            do {
                core = try await Core.open(bytes: bytes)
            } catch CoreError.password {
                return nil
            } catch is CoreError {
                return nil
            }
            defer { Task { await core.close() } }
            let count = await core.pageCount
            var pages: [PageText] = []
            var blank: [Int] = []
            var chars = 0
            for page in 0..<min(count, Limits.textPages) {
                try Task.checkCancellation()
                let text = ((try? await core.extractText(page: page)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty {
                    blank.append(page)
                } else if chars < Limits.charsPerDocument {
                    let kept = String(text.prefix(Limits.charsPerDocument - chars))
                    chars += kept.count
                    pages.append(PageText(page: page + 1, text: kept))
                }
            }
            let ownText = pages.count
            var recognized = 0
            for page in blank.prefix(Limits.ocrPages) {
                try Task.checkCancellation()
                var at = progress
                at.stage = .recognizing(page: recognized + 1, of: min(blank.count, Limits.ocrPages))
                await report(at)
                guard let rendered = try? await core.renderPage(page, scale: Limits.renderScale),
                      let image = Self.cgImage(from: rendered) else { continue }
                let words = (try? await recognizer.recognize(image, languages: languages)) ?? []
                recognized += 1
                let lines = TextRecognizer.lines(of: words).joined(separator: "\n")
                if !lines.isEmpty, chars < Limits.charsPerDocument {
                    let kept = String(lines.prefix(Limits.charsPerDocument - chars))
                    chars += kept.count
                    pages.append(PageText(page: page + 1, text: kept))
                }
            }
            pages.sort { $0.page < $1.page }
            var thumbnail: Data?
            if count > 0, let size = try? await core.pageSize(0), size.width > 0 {
                let scale = Float(Limits.thumbnailWidth) / size.width
                if let rendered = try? await core.renderPage(0, scale: scale), let image = Self.cgImage(from: rendered) {
                    thumbnail = UIImage(cgImage: image).pngData()
                }
            }
            return ReadDocument(kind: count > 0 && ownText == 0 ? .scan : .pdf, pages: pages, pageCount: count, recognized: recognized, thumbnail: thumbnail)
        }

        /// A picture: one page, read with OCR; its thumbnail is itself, small.
        private func readImage(_ bytes: Data, progress: IndexingProgress, report: @Sendable (IndexingProgress) async -> Void) async throws -> ReadDocument? {
            guard let image = Self.decodeImage(bytes, maxPixels: Limits.imagePixels) else { return nil }
            var at = progress
            at.stage = .recognizing(page: 1, of: 1)
            await report(at)
            let words = (try? await recognizer.recognize(image, languages: languages)) ?? []
            let text = TextRecognizer.lines(of: words).joined(separator: "\n")
            let pages = text.isEmpty ? [] : [PageText(page: 1, text: String(text.prefix(Limits.charsPerDocument)))]
            let thumbnail = Self.decodeImage(bytes, maxPixels: Limits.thumbnailWidth).flatMap { UIImage(cgImage: $0).pngData() }
            return ReadDocument(kind: .image, pages: pages, pageCount: 1, recognized: 1, thumbnail: thumbnail)
        }

        /// The core's RGBA page as a CGImage.
        static func cgImage(from page: RenderedPage) -> CGImage? {
            guard page.width > 0, page.height > 0, page.rgba.count == page.width * page.height * 4,
                  let provider = CGDataProvider(data: page.rgba as CFData) else { return nil }
            return CGImage(width: page.width, height: page.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: page.width * 4,
                           space: CGColorSpaceCreateDeviceRGB(),
                           bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                           provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        }

        /// A picture decoded no larger than `maxPixels` on its long side,
        /// upright by its EXIF orientation: a hostile file cannot ask for
        /// more memory than that.
        static func decodeImage(_ bytes: Data, maxPixels: Int) -> CGImage? {
            guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixels,
                kCGImageSourceShouldCache: false,
            ]
            return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        }
    }
}
