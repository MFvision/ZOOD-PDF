import CoreSpotlight
import SwiftUI
import ZoodCore

@main
struct ZoodPDFApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var library = Library()

    var body: some Scene {
        // Main window: Home / Recents / tools. iPad users can open several.
        WindowGroup(id: "main") {
            RootView()
                .environment(library)
                .task {
                    if let demo = DemoContent.prepareIfRequested() { await library.record(url: demo) }
                    await library.refresh()
                    ModelManager.shared.reconnect()
                }
        }

        // One document per window (iPad: "Open in New Window", drag a recent to the edge).
        // The value is a file URL or a zoodpdf://open?id=… link, which is resolved through the
        // recents bookmark so Files-app documents keep their security scope in the new window.
        WindowGroup(id: "document", for: URL.self) { $url in
            if let url {
                DocumentWindow(url: url)
                    .environment(library)
            }
        }
    }
}

/// Root of the "document" window group.
struct DocumentWindow: View {
    let url: URL
    @Environment(Library.self) private var library
    @State private var opened: OpenedDocument?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Group {
                if let opened {
                    DocumentScreen(document: opened)
                } else if failed {
                    ContentUnavailableView("error.notFound", systemImage: "doc.questionmark")
                } else {
                    ProgressView()
                }
            }
        }
        .task(id: url) {
            if case .openRecent(let id) = DeepLink(url: url) {
                await library.refresh()
                if let r = library.recents.first(where: { $0.id == id }), let u = library.url(for: r) {
                    opened = OpenedDocument(url: u, recentID: id)
                } else {
                    failed = true
                }
            } else if url.isFileURL {
                let recent = await library.record(url: url)
                opened = OpenedDocument(url: url, recentID: recent?.id)
            } else {
                failed = true
            }
        }
    }
}

/// UI tests and screenshots: `-ZoodDemo` writes one generated sample PDF into Documents so the
/// Recents grid and the document view have something real to show. Never runs otherwise.
enum DemoContent {
    @MainActor static func prepareIfRequested() -> URL? {
        guard ProcessInfo.processInfo.arguments.contains("-ZoodDemo") else { return nil }
        let url = DocumentLibrary.documentsDirectory.appendingPathComponent("عقد إيجار - نموذج.pdf")
        if !FileManager.default.fileExists(atPath: url.path) {
            try? SamplePDFBuilder.arabicSample().write(to: url, options: .atomic)
        }
        return url
    }
}

/// Background model downloads: iOS relaunches the app when the transfer finishes; the handler
/// is called once the session has delivered its events (`ModelManager`).
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == ModelManager.sessionID else {
            completionHandler()
            return
        }
        ModelManager.shared.backgroundCompletion = completionHandler
        ModelManager.shared.reconnect()
    }

    func applicationDidReceiveMemoryWarning(_ application: UIApplication) {
        Task { await PortableModelRunner.shared.unload() }
    }
}
