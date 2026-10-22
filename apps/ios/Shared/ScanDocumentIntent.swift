import AppIntents
import Foundation

/// "Scan a document": opens the app on the scanner. Compiled into the app,
/// where Shortcuts and Siri find it, and into the widgets extension, where
/// the Control Center control runs it — both leave the same route for the
/// app to take as it comes to the front.
public struct ScanDocumentIntent: AppIntent {
    public static let title: LocalizedStringResource = "Scan a document"
    public static let description = IntentDescription("Opens the scanner to scan a paper document into a PDF.")
    public static let openAppWhenRun = true

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
        AppRoute.scan.post()
        return .result()
    }
}

/// "Open the last document": opens the document opened last.
public struct OpenLastDocumentIntent: AppIntent {
    public static let title: LocalizedStringResource = "Open the last document"
    public static let description = IntentDescription("Opens the document you opened last.")
    public static let openAppWhenRun = true

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
        AppRoute.lastDocument.post()
        return .result()
    }
}

/// "Ask ZOOD": opens the document on screen, or the one opened last, with
/// the on-device assistant ready for a question. Nothing leaves the phone.
public struct AskZoodIntent: AppIntent {
    public static let title: LocalizedStringResource = "Ask ZOOD"
    public static let description = IntentDescription("Opens your last document with ZOOD's on-device assistant, ready for a question.")
    public static let openAppWhenRun = true

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
        AppRoute.askZood.post()
        return .result()
    }
}
