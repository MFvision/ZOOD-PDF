import AppIntents
import Foundation
import ZoodCore

// Compiled into BOTH the app and the widget extension: the Control Center control and the
// widgets run this intent, which opens the app on its scanner through a zoodpdf:// link.

enum ScanModeEntity: String, AppEnum {
    case document, whiteboard, idCard, book

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "intent.scanMode.type"
    static let caseDisplayRepresentations: [ScanModeEntity: DisplayRepresentation] = [
        .document: "scan.mode.document",
        .whiteboard: "scan.mode.whiteboard",
        .idCard: "scan.mode.idCard",
        .book: "scan.mode.book",
    ]

    var mode: DeepLink.ScanMode {
        switch self {
        case .document: .document
        case .whiteboard: .whiteboard
        case .idCard: .idCard
        case .book: .book
        }
    }
}

struct ScanDocumentIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.scan.title"
    static let description = IntentDescription("intent.scan.description")
    static let openAppWhenRun = true

    @Parameter(title: "intent.scanMode.type", default: .document)
    var mode: ScanModeEntity

    init() {}

    init(mode: ScanModeEntity) {
        self.mode = mode
    }

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(DeepLink.scan(mode.mode).url))
    }
}
