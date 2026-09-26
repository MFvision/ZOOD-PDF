import AppIntents
import Foundation
import UniformTypeIdentifiers
import ZoodCore
import ZoodEngine

// Siri / Shortcuts / Spotlight actions. Combine and Compress run without opening the app and
// return the new PDF; Open recent and Scan open the app.

struct RecentDocumentEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "entity.recent.type"
    static let defaultQuery = RecentDocumentQuery()

    let id: String
    let name: String
    let openedAt: Date

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(openedAt.formatted(date: .abbreviated, time: .omitted))")
    }

    init(_ r: RecentDocument) {
        id = r.id
        name = r.name
        openedAt = r.openedAt
    }
}

struct RecentDocumentQuery: EntityStringQuery {
    private func all() -> [RecentDocument] {
        let dir = ZoodShared.groupRecentsDirectory()
            ?? URL.applicationSupportDirectory.appendingPathComponent("Recents", isDirectory: true)
        return RecentsStore.snapshot(directory: dir).sorted { $0.openedAt > $1.openedAt }
    }

    func entities(for identifiers: [String]) async throws -> [RecentDocumentEntity] {
        all().filter { identifiers.contains($0.id) }.map(RecentDocumentEntity.init)
    }

    func entities(matching string: String) async throws -> [RecentDocumentEntity] {
        all().filter { SearchNormalizer.matches(query: string, fields: [$0.name] + $0.tags) }.map(RecentDocumentEntity.init)
    }

    func suggestedEntities() async throws -> [RecentDocumentEntity] {
        Array(all().prefix(10)).map(RecentDocumentEntity.init)
    }
}

struct OpenRecentIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.openRecent.title"
    static let description = IntentDescription("intent.openRecent.description")
    static let openAppWhenRun = true

    @Parameter(title: "entity.recent.type")
    var document: RecentDocumentEntity

    init() {}

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(DeepLink.openRecent(id: document.id).url))
    }
}

enum ZoodIntentError: Error, CustomLocalizedStringResourceConvertible {
    case needTwo
    case protected(String)
    case engine(String)
    case noGain

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .needTwo: "intent.error.needTwo"
        case .protected(let name): "intent.error.protected \(name)"
        case .engine(let message): "intent.error.engine \(message)"
        case .noGain: "compress.noGain"
        }
    }
}

struct CombinePDFsIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.combine.title"
    static let description = IntentDescription("intent.combine.description")

    @Parameter(title: "intent.combine.files", supportedContentTypes: [.pdf])
    var files: [IntentFile]

    init() {}

    func perform() async throws -> some IntentResult & ReturnsValue<IntentFile> {
        guard files.count >= 2 else { throw ZoodIntentError.needTwo }
        var datas: [Data] = []
        for f in files {
            let d = f.data
            if (try? WarraqEngine.isEncrypted(d))?.needsPassword == true {
                throw ZoodIntentError.protected(f.filename)
            }
            datas.append(d)
        }
        do {
            let (_, bytes) = try WarraqEngine.merge(datas)
            let name = FileNaming.pdfName(String(localized: "combine.fileName \(Date.now.formatted(date: .numeric, time: .omitted))"))
            return .result(value: IntentFile(data: bytes, filename: name, type: .pdf))
        } catch {
            throw ZoodIntentError.engine(error.message)
        }
    }
}

struct CompressPDFIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.compress.title"
    static let description = IntentDescription("intent.compress.description")

    @Parameter(title: "intent.compress.file", supportedContentTypes: [.pdf])
    var file: IntentFile

    init() {}

    func perform() async throws -> some IntentResult & ReturnsValue<IntentFile> {
        let data = file.data
        if (try? WarraqEngine.isEncrypted(data))?.needsPassword == true {
            throw ZoodIntentError.protected(file.filename)
        }
        guard let out = try await CompressService.compress(data, password: nil, level: .smaller) else {
            throw ZoodIntentError.noGain
        }
        let name = FileNaming.derived(from: file.filename, suffix: String(localized: "compress.suffix"))
        return .result(value: IntentFile(data: out.bytes, filename: name, type: .pdf))
    }
}

struct ZoodShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ScanDocumentIntent(),
            phrases: [
                "Scan a document with \(.applicationName)",
                "Scan to PDF with \(.applicationName)",
                "Scan \(\.$mode) with \(.applicationName)",
            ],
            shortTitle: "intent.scan.short",
            systemImageName: "doc.viewfinder")
        AppShortcut(
            intent: OpenRecentIntent(),
            phrases: [
                "Open \(\.$document) in \(.applicationName)",
                "Open a recent PDF in \(.applicationName)",
            ],
            shortTitle: "intent.openRecent.short",
            systemImageName: "clock")
        AppShortcut(
            intent: CombinePDFsIntent(),
            phrases: ["Combine PDFs with \(.applicationName)"],
            shortTitle: "intent.combine.short",
            systemImageName: "square.stack.3d.down.right")
        AppShortcut(
            intent: CompressPDFIntent(),
            phrases: ["Compress a PDF with \(.applicationName)"],
            shortTitle: "intent.compress.short",
            systemImageName: "arrow.down.right.and.arrow.up.left")
    }
}
