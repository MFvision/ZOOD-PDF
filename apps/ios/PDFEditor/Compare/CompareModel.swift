import Foundation
import Observation
import SwiftUI
import UIKit
import WarraqCore

/// Compare, from the open document: the other version is chosen (Files, My
/// documents, Recents), unlocked if it must be, then the core compares the
/// two — the text first, word by word, then every page both have by how it
/// looks, a few pages at a time so the progress moves and Stop is heard.
/// The result is kept here, with where the person is in it.
@MainActor @Observable
final class CompareModel {
    enum Phase: Equatable {
        case choosing
        case comparing(done: Int, of: Int)
        case compared
        case failed(String)
    }

    enum Mode: String, CaseIterable, Identifiable {
        case text
        case pages

        var id: String { rawValue }
    }

    /// Which version a page picture shows (iPhone: one at a time).
    enum Version: String, CaseIterable, Identifiable {
        case older
        case newer

        var id: String { rawValue }
    }

    /// The open document.
    let this: CompareSide
    /// The version it is compared with, once chosen and opened.
    private(set) var other: CompareSide?
    /// The chosen file needs a password before it can be compared.
    private(set) var otherNeedsPassword = false
    private(set) var otherPasswordWrong = false
    /// The chosen file is not a PDF the core can read.
    private(set) var otherUnreadable = false
    private var pendingOther: (name: String, bytes: Data)?

    /// The open document is the older version (the default, as the desktop
    /// compares the open file with another): Swap makes it the newer.
    var thisIsOlder = true
    var ignoreMarks = false
    var unifyLetters = false

    private(set) var phase: Phase = .choosing
    private(set) var text: TextComparison?
    /// Every page both versions have, in order, with its boxes.
    private(set) var looks: [PageLook] = []
    /// Whether every page both have was compared by look (not when stopped).
    private(set) var looksComplete = false

    var mode: Mode = .text
    /// The change on screen, an index of `text.changes`.
    var currentChange = 0
    /// The page on screen in Pages, one-based.
    var currentPage = 1
    var shownVersion: Version = .newer

    private var work: Task<Void, Never>?
    private var cores: [Version: Core] = [:]

    init(this: CompareSide) {
        self.this = this
    }

    var older: CompareSide? { other.map { thisIsOlder ? this : $0 } }
    var newer: CompareSide? { other.map { thisIsOlder ? $0 : this } }

    // MARK: - Choosing the other version

    /// A file chosen in Files, or one of the Library's: read once, while
    /// its security scope is held, and checked with the core.
    func choose(url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let bytes = try? Data(contentsOf: url) else {
            otherUnreadable = true
            other = nil
            return
        }
        await choose(name: url.deletingPathExtension().lastPathComponent, bytes: bytes)
    }

    func choose(name: String, bytes: Data) async {
        other = nil
        otherNeedsPassword = false
        otherPasswordWrong = false
        otherUnreadable = false
        pendingOther = (name, bytes)
        switch await Comparer.opening(bytes, password: nil) {
        case nil:
            other = CompareSide(name: name, bytes: bytes, password: nil)
            pendingOther = nil
        case .password?:
            otherNeedsPassword = true
        case _?:
            otherUnreadable = true
            pendingOther = nil
        }
    }

    func unlockOther(password: String) async {
        guard let pending = pendingOther else { return }
        if await Comparer.opening(pending.bytes, password: password) == nil {
            other = CompareSide(name: pending.name, bytes: pending.bytes, password: password)
            otherNeedsPassword = false
            otherPasswordWrong = false
            pendingOther = nil
        } else {
            otherPasswordWrong = true
        }
    }

    /// The name of the file chosen, whether or not it is open yet.
    var chosenName: String? { other?.name ?? pendingOther?.name }

    // MARK: - Comparing

    func compare() {
        guard let older, let newer else { return }
        work?.cancel()
        text = nil
        looks = []
        looksComplete = false
        currentChange = 0
        currentPage = 1
        closeCores()
        phase = .comparing(done: 0, of: 1)
        let ignoreMarks = ignoreMarks
        let unifyLetters = unifyLetters
        work = Task {
            do {
                let text = try await Comparer.text(older: older, newer: newer, ignoreMarks: ignoreMarks, unifyLetters: unifyLetters)
                self.text = text
                let common = min(text.olderPages, text.newerPages)
                phase = .comparing(done: 0, of: common)
                var looks: [PageLook] = []
                var start = 0
                while start < common {
                    if Task.isCancelled { break }
                    let pages = Array(start..<min(common, start + Comparer.pagesPerCall))
                    looks += try await Comparer.looks(older: older, newer: newer, pages: pages)
                    start += pages.count
                    phase = .comparing(done: start, of: common)
                }
                self.looks = looks
                looksComplete = start >= common
                // Where to begin: the first change of the text, or the first
                // page that looks different when the text has none.
                if text.changes.isEmpty, let first = looks.first(where: { !$0.boxes.isEmpty }) {
                    mode = .pages
                    currentPage = first.page
                } else if let first = text.changes.first {
                    currentPage = first.page
                }
                phase = .compared
            } catch is CancellationError {
                phase = .choosing
            } catch let error as CoreError {
                phase = .failed(error.message)
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    /// Stop: the text, when it is read, stays; the pages compared so far stay.
    func stop() {
        work?.cancel()
    }

    /// Back to choosing, keeping the choice.
    func again() {
        work?.cancel()
        phase = .choosing
        closeCores()
    }

    func close() {
        work?.cancel()
        closeCores()
    }

    // MARK: - Moving through the result

    var changeCount: Int { text?.changes.count ?? 0 }

    /// The pages that look different, in order.
    var changedLooks: [PageLook] { looks.filter { !$0.boxes.isEmpty } }

    /// Pages only one version has: their every word is a change, and they
    /// cannot be compared by look.
    var pagesOnlyInOne: Int {
        guard let text else { return 0 }
        return abs(text.olderPages - text.newerPages)
    }

    func nextChange() {
        guard changeCount > 0 else { return }
        currentChange = min(changeCount - 1, currentChange + 1)
        currentPage = text?.changes[currentChange].page ?? currentPage
    }

    func previousChange() {
        guard changeCount > 0 else { return }
        currentChange = max(0, currentChange - 1)
        currentPage = text?.changes[currentChange].page ?? currentPage
    }

    /// The page that looks different after (or before) the one on screen.
    func nextLook() {
        if let next = changedLooks.first(where: { $0.page > currentPage }) {
            currentPage = next.page
        }
    }

    func previousLook() {
        if let previous = changedLooks.last(where: { $0.page < currentPage }) {
            currentPage = previous.page
        }
    }

    var hasNextLook: Bool { changedLooks.contains { $0.page > currentPage } }
    var hasPreviousLook: Bool { changedLooks.contains { $0.page < currentPage } }

    /// Where the page on screen is among those that look different: 1-based, or nil.
    var lookPosition: Int? {
        changedLooks.firstIndex { $0.page == currentPage }.map { $0 + 1 }
    }

    func boxes(onPage page: Int) -> [LookBox] {
        looks.first { $0.page == page }?.boxes ?? []
    }

    /// Shows the page of a change, in Pages.
    func showPage(of change: Int) {
        guard let text, change < text.changes.count else { return }
        currentChange = change
        currentPage = text.changes[change].page
        mode = .pages
    }

    // MARK: - Pictures of the pages

    /// The page as `version` has it, drawn by the core; nil past its last page.
    func picture(of version: Version, page: Int, width: CGFloat) async -> UIImage? {
        guard let side = version == .older ? older : newer else { return nil }
        do {
            let core: Core
            if let open = cores[version] {
                core = open
            } else {
                core = try await Core.open(bytes: side.bytes, password: side.password)
                cores[version] = core
            }
            let index = page - 1
            guard index >= 0, index < (await core.pageCount) else { return nil }
            let size = try await core.pageSize(index)
            let scale = Float(max(1, width)) / max(1, size.width)
            let rendered = try await core.renderPage(index, scale: min(4, scale))
            return UIImage.from(rgba: rendered.rgba, width: rendered.width, height: rendered.height)
        } catch {
            return nil
        }
    }

    private func closeCores() {
        let open = Array(cores.values)
        cores = [:]
        Task {
            for core in open { await core.close() }
        }
    }
}
