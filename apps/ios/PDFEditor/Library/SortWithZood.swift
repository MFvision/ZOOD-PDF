import SwiftUI
import WarraqCore

/// Sort with ZOOD on the iPhone, after the desktop's (packages/ui/src/sort/plan.ts):
/// choose files in My files and ZOOD suggests what to do with them — merge a
/// series ("scan 1", "scan 2") into one PDF, split a PDF that holds several
/// documents, give names that say something to "IMG_2034" and "scan0001",
/// and put each file in a folder by what it is. Nothing happens until you
/// apply, and Undo puts everything back.
enum SortPlan {
    enum Topic: String, CaseIterable, Sendable {
        case invoices, bank, contracts, ids, travel, medical, cvs, certificates

        var folder: String {
            switch self {
            case .invoices: String(localized: "Invoices")
            case .bank: String(localized: "Bank")
            case .contracts: String(localized: "Contracts")
            case .ids: String(localized: "IDs")
            case .travel: String(localized: "Travel")
            case .medical: String(localized: "Medical")
            case .cvs: String(localized: "CVs")
            case .certificates: String(localized: "Certificates")
            }
        }

        var word: String {
            switch self {
            case .invoices: String(localized: "Invoice")
            case .bank: String(localized: "Bank statement")
            case .contracts: String(localized: "Contract")
            case .ids: String(localized: "ID")
            case .travel: String(localized: "Travel")
            case .medical: String(localized: "Medical")
            case .cvs: String(localized: "CV")
            case .certificates: String(localized: "Certificate")
            }
        }

        private var english: String {
            switch self {
            case .invoices: #"\b(tax invoice|invoice|receipt|bill|inv[-_]\d)"#
            case .bank: #"\b(bank statement|account statement|statement of account|iban|bank transfer)\b"#
            case .contracts: #"\b(contract|agreement|nda|lease|terms and conditions)\b"#
            case .ids: #"\b(passport|national id|iqama|id card|identity card|driving licen[cs]e|residence permit)\b"#
            case .travel: #"\b(boarding pass|e-?ticket|itinerary|booking confirmation|reservation|flight|hotel)\b"#
            case .medical: #"\b(medical|prescription|lab results?|clinic|hospital|diagnosis)\b"#
            case .cvs: #"\b(resume|résumé|curriculum vitae|cv)\b"#
            case .certificates: #"\b(certificate|diploma|certification)\b"#
            }
        }

        private var arabic: [String] {
            switch self {
            case .invoices: ["فاتورة", "فواتير", "إيصال", "ايصال", "سند قبض"]
            case .bank: ["كشف حساب", "كشف الحساب", "حوالة", "آيبان", "ايبان"]
            case .contracts: ["عقد", "اتفاقية", "مذكرة تفاهم"]
            case .ids: ["هوية", "جواز", "إقامة", "اقامة", "رخصة قيادة", "بطاقة الأحوال"]
            case .travel: ["تذكرة", "حجز", "بطاقة صعود", "رحلة", "فندق"]
            case .medical: ["تقرير طبي", "وصفة", "مستشفى", "عيادة", "تحاليل", "تحليل"]
            case .cvs: ["سيرة ذاتية", "السيرة الذاتية"]
            case .certificates: ["شهادة"]
            }
        }

        func matches(_ text: String) -> Bool {
            text.range(of: english, options: [.regularExpression, .caseInsensitive]) != nil || arabic.contains(where: text.contains)
        }
    }

    static func topic(of text: String) -> Topic? {
        Topic.allCases.first { $0.matches(text) }
    }

    /// A name that says nothing of what the file is: "IMG_2034", "scan0001", "Document (3)".
    static func saysNothing(_ name: String) -> Bool {
        var rest = name.replacingOccurrences(of: #"[\d٠-٩_\-.()\[\]]+"#, with: " ", options: .regularExpression)
        rest = rest.replacingOccurrences(of: #"\b(img|dsc|dscn|pxl|scan|scanned|document|doc|file|download|untitled|new|image|photo|screenshot|camscanner|whatsapp|copy|page|at|am|pm)\b"#,
                                         with: " ", options: [.regularExpression, .caseInsensitive])
        for word in ["صورة", "مستند", "ملف", "مسح", "ممسوح", "جديد", "بدون عنوان", "لقطة شاشة", "نسخة", "صفحة"] {
            rest = rest.replacingOccurrences(of: word, with: " ")
        }
        return rest.filter(\.isLetter).count < 2
    }

    /// The name a file shares with its series, and its number in it.
    static func series(_ name: String) -> (base: String, number: Int, numbered: Bool) {
        var base = name.trimmingCharacters(in: .whitespaces)
        var numbered = false
        var number = 0
        if let range = base.range(of: #"[\s_\-.]*(\(\d+\)|copy|نسخة)$"#, options: [.regularExpression, .caseInsensitive]) {
            base.removeSubrange(range)
            numbered = true
            number = 1
        }
        if let range = base.range(of: #"[\s_\-.]*(page|pg|part|صفحة|جزء)?[\s_\-.]*([0-9٠-٩]{1,4})$"#, options: [.regularExpression, .caseInsensitive]),
           range.lowerBound != base.startIndex {
            let digits = MarkSpec.westernDigits(String(base[range]).filter(\.isNumber))
            let isYear = digits.count == 4 && (digits.hasPrefix("19") || digits.hasPrefix("20")) && !base[range].contains(where: \.isLetter)
            if !isYear {
                number = Int(digits) ?? 0
                base.removeSubrange(range)
                numbered = true
            }
        }
        return (base.trimmingCharacters(in: CharacterSet(charactersIn: " _-.")), number, numbered)
    }

    /// The pages (from 0) where a new document starts in a PDF's page texts.
    static func documentStarts(_ texts: [String]) -> [Int] {
        var starts = [0]
        let pageOne = [#"\bpage\s*1\s*(of|/)\s*\d+"#, #"صفحة\s*(1|١)\s*(من|/)"#]
        for (page, text) in texts.enumerated() where page > 0 {
            if pageOne.contains(where: { text.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }) {
                starts.append(page)
            }
        }
        return starts
    }

    /// The first short line of words on the first page: what names it.
    static func namingLine(_ text: String) -> String {
        for raw in text.split(whereSeparator: \.isNewline).prefix(12) {
            let line = raw.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            let letters = line.filter(\.isLetter).count
            guard line.count >= 3, line.count <= 70, letters >= 3, letters * 2 >= line.count else { continue }
            var cleaned = line
            for ch in "/\\:*?\"<>|" { cleaned = cleaned.replacingOccurrences(of: String(ch), with: " ") }
            return cleaned.split(separator: " ").prefix(6).joined(separator: " ")
        }
        return ""
    }

    struct File: Identifiable, Sendable {
        let url: URL
        var id: URL { url }
        var name: String { url.deletingPathExtension().lastPathComponent }
        var pages: [String] = []
    }

    enum Suggestion: Identifiable, Equatable {
        case merge(files: [URL], name: String)
        case split(file: URL, parts: [[Int]])
        case rename(file: URL, to: String)
        case folder(file: URL, folder: String)

        var id: String {
            switch self {
            case let .merge(files, _): "merge:" + files.map(\.path).joined(separator: "|")
            case let .split(file, _): "split:" + file.path
            case let .rename(file, _): "rename:" + file.path
            case let .folder(file, _): "folder:" + file.path
            }
        }
    }

    static func suggestions(for files: [File]) -> [Suggestion] {
        var out: [Suggestion] = []
        // Series of numbered PDFs: one PDF.
        var groups: [String: [(File, Int, Bool, String)]] = [:]
        for file in files {
            let s = series(file.name)
            guard !s.base.isEmpty else { continue }
            groups[s.base.lowercased(), default: []].append((file, s.number, s.numbered, s.base))
        }
        var merged = Set<URL>()
        for (_, group) in groups where group.count >= 2 && group.contains(where: { $0.2 }) {
            let ordered = group.sorted { $0.1 < $1.1 }
            out.append(.merge(files: ordered.map { $0.0.url }, name: ordered[0].3))
            merged.formUnion(ordered.map { $0.0.url })
        }
        for file in files where !merged.contains(file.url) {
            let starts = documentStarts(file.pages)
            if file.pages.count >= 2, starts.count >= 2 {
                let parts = starts.enumerated().map { k, start in
                    Array(start..<(k + 1 < starts.count ? starts[k + 1] : file.pages.count))
                }
                out.append(.split(file: file.url, parts: parts))
            }
            let topic = topic(of: file.name.replacingOccurrences(of: "_", with: " ")) ?? topic(of: file.pages.prefix(2).joined(separator: "\n"))
            if saysNothing(file.name) {
                let line = namingLine(file.pages.first ?? "")
                var parts = [topic?.word, line.isEmpty ? nil : line].compactMap { $0 }
                if let topic, line.lowercased().hasPrefix(topic.word.lowercased()) { parts.removeFirst() }
                let name = parts.joined(separator: " - ")
                if !name.isEmpty, name != file.name { out.append(.rename(file: file.url, to: name)) }
            }
            if let topic { out.append(.folder(file: file.url, folder: topic.folder)) }
        }
        return out
    }
}

/// The Sort screen.
struct SortView: View {
    let library: LibraryModel
    @Environment(\.dismiss) private var dismiss
    @State private var selected = Set<URL>()
    @State private var suggestions: [SortPlan.Suggestion] = []
    @State private var chosen = Set<String>()
    @State private var reading = false
    @State private var applying = false
    /// How to put back what the last apply did: (from, to) moves, made files.
    @State private var undo: (moves: [(URL, URL)], made: [URL])?
    @State private var done: String?

    var body: some View {
        NavigationStack {
            List {
                if let done {
                    Section {
                        Label(done, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        if undo != nil {
                            Button("Undo", systemImage: "arrow.uturn.backward") { undoLast() }
                                .accessibilityIdentifier("sort.undo")
                        }
                    }
                }
                if suggestions.isEmpty {
                    Section {
                        ForEach(library.documents) { document in
                            Button {
                                if selected.contains(document.url) { selected.remove(document.url) } else { selected.insert(document.url) }
                            } label: {
                                HStack {
                                    Image(systemName: selected.contains(document.url) ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(selected.contains(document.url) ? Color.accentColor : Surface.tertiaryLabel)
                                    Text(verbatim: document.name).lineLimit(1)
                                }
                            }
                            .foregroundStyle(Surface.label)
                        }
                    } header: {
                        Text("Choose files in My files")
                    } footer: {
                        Text("ZOOD reads their names and first pages on this iPhone and suggests how to sort them. Nothing changes until you apply.")
                    }
                } else {
                    Section {
                        ForEach(suggestions) { suggestion in
                            Toggle(isOn: Binding(get: { chosen.contains(suggestion.id) },
                                                 set: { if $0 { chosen.insert(suggestion.id) } else { chosen.remove(suggestion.id) } })) {
                                describe(suggestion)
                            }
                        }
                    } header: {
                        Text("ZOOD suggests")
                    }
                    Section {
                        Button {
                            Task { await apply() }
                        } label: {
                            HStack {
                                Label("Apply \(chosen.count)", systemImage: "wand.and.stars")
                                Spacer()
                                if applying { ProgressView() }
                            }
                        }
                        .disabled(chosen.isEmpty || applying)
                        .accessibilityIdentifier("sort.apply")
                        Button("Choose other files") { suggestions = [] }
                    }
                }
            }
            .themedScrollBackground()
            .navigationTitle("Sort with ZOOD")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                if suggestions.isEmpty {
                    ToolbarItem(placement: .confirmationAction) {
                        Button {
                            Task { await read() }
                        } label: {
                            if reading { ProgressView() } else { Text("Suggest") }
                        }
                        .disabled(selected.isEmpty || reading)
                        .accessibilityIdentifier("sort.suggest")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func describe(_ suggestion: SortPlan.Suggestion) -> some View {
        switch suggestion {
        case let .merge(files, name):
            Label { Text("Merge \(files.count) files into “\(name)”") } icon: { Image(systemName: "doc.on.doc") }
        case let .split(file, parts):
            Label { Text("Split “\(file.deletingPathExtension().lastPathComponent)” into \(parts.count) documents") } icon: { Image(systemName: "scissors") }
        case let .rename(file, to):
            Label { Text("Rename “\(file.deletingPathExtension().lastPathComponent)” to “\(to)”") } icon: { Image(systemName: "character.cursor.ibeam") }
        case let .folder(file, folder):
            Label { Text("Put “\(file.deletingPathExtension().lastPathComponent)” in the \(folder) folder") } icon: { Image(systemName: "folder") }
        }
    }

    private func read() async {
        reading = true
        defer { reading = false }
        var files: [SortPlan.File] = []
        for url in selected.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            var file = SortPlan.File(url: url)
            if let bytes = try? Data(contentsOf: url), let core = try? await Core.open(bytes: bytes) {
                let count = await core.pageCount
                for page in 0..<min(count, 40) {
                    file.pages.append((try? await core.extractText(page: page)) ?? "")
                }
                await core.close()
            }
            files.append(file)
        }
        suggestions = SortPlan.suggestions(for: files)
        chosen = Set(suggestions.map(\.id))
        if suggestions.isEmpty { done = String(localized: "These files are sorted already: ZOOD has nothing to suggest.") }
    }

    private struct PagesArgs: Encodable { let pages: [Int] }

    private func apply() async {
        applying = true
        defer { applying = false }
        let folder = library.documentsFolder
        var moves: [(URL, URL)] = []
        var made: [URL] = []
        var renamed: [URL: URL] = [:]
        let fm = FileManager.default
        let trash = folder.appending(path: ".zood-sort-undo", directoryHint: .isDirectory)
        try? fm.createDirectory(at: trash, withIntermediateDirectories: true)
        func current(_ url: URL) -> URL { renamed[url] ?? url }
        func move(_ from: URL, to: URL) {
            guard from != to, (try? fm.moveItem(at: from, to: to)) != nil else { return }
            moves.append((from, to))
        }
        for suggestion in suggestions where chosen.contains(suggestion.id) {
            switch suggestion {
            case let .merge(files, name):
                let parts = files.compactMap { try? Data(contentsOf: current($0)) }
                if let reply = try? await Core.callStatic(op: "pages.combine", args: "{}", blobs: parts),
                   let bytes = reply.blobs.first {
                    let target = library.freeName(for: "\(name).pdf", in: folder)
                    if (try? bytes.write(to: target)) != nil {
                        made.append(target)
                        // The originals are kept aside, so Undo has them.
                        for file in files { move(current(file), to: trash.appending(path: UUID().uuidString + ".pdf")) }
                    }
                }
            case let .split(file, parts):
                guard let bytes = try? Data(contentsOf: current(file)), let core = try? await Core.open(bytes: bytes) else { continue }
                let base = file.deletingPathExtension().lastPathComponent
                for (k, pages) in parts.enumerated() {
                    if let reply = try? await core.call(op: "pages.extract", args: PagesArgs(pages: pages)), let part = reply.blobs.first {
                        let target = library.freeName(for: "\(base) - \(k + 1).pdf", in: folder)
                        if (try? part.write(to: target)) != nil { made.append(target) }
                    }
                }
                await core.close()
                move(current(file), to: trash.appending(path: UUID().uuidString + ".pdf"))
            case let .rename(file, to):
                let target = library.freeName(for: "\(to).pdf", in: current(file).deletingLastPathComponent())
                let from = current(file)
                move(from, to: target)
                renamed[file] = target
            case let .folder(file, name):
                let dir = folder.appending(path: name, directoryHint: .isDirectory)
                try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
                let from = current(file)
                let target = library.freeName(for: from.lastPathComponent, in: dir)
                move(from, to: target)
                renamed[file] = target
            }
        }
        undo = (moves, made)
        done = String(localized: "Sorted. Undo puts everything back as it was.")
        suggestions = []
        selected = []
        library.refresh()
        library.indexNow()
    }

    private func undoLast() {
        guard let undo else { return }
        let fm = FileManager.default
        for url in undo.made { try? fm.removeItem(at: url) }
        for (from, to) in undo.moves.reversed() { try? fm.moveItem(at: to, to: from) }
        self.undo = nil
        done = String(localized: "Put back as it was.")
        library.refresh()
        library.indexNow()
    }
}
