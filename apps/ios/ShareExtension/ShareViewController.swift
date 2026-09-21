import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// "Save to محرر PDF" in the share sheet: every PDF shared is copied into
/// the shared container's Inbox, and the app takes it into its own
/// Documents folder the next time it is in front. Nothing else happens.
final class ShareViewController: UIViewController {
    private let state = ShareState()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(state: state) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []
        Task { await state.save(providers) }
    }
}

@MainActor @Observable
final class ShareState {
    enum Phase: Equatable {
        case saving
        case saved(count: Int)
        /// The system's description of what went wrong, or one of the
        /// extension's own messages (a key of its String Catalog).
        case failed(LocalizedStringKey)
    }

    var phase: Phase = .saving

    func save(_ providers: [NSItemProvider]) async {
        let inbox = AppGroup.ensure(AppGroup.inboxURL)
        var saved = 0
        var lastError: String?
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
            switch await Self.copy(provider, into: inbox) {
            case .success: saved += 1
            case let .failure(error): lastError = error.localizedDescription
            }
        }
        if saved > 0 {
            phase = .saved(count: saved)
        } else {
            phase = .failed(lastError.map { LocalizedStringKey($0) } ?? "Nothing shared was a PDF.")
        }
    }

    /// Copies the provider's file into the Inbox. The file the provider
    /// hands over lives only inside its handler, so the copy happens there.
    private static func copy(_ provider: NSItemProvider, into inbox: URL) async -> Result<URL, any Error> {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.pdf.identifier) { url, error in
                guard let url else {
                    continuation.resume(returning: .failure(error ?? CocoaError(.fileNoSuchFile)))
                    return
                }
                let name = url.lastPathComponent.isEmpty ? "Document.pdf" : url.lastPathComponent
                var destination = inbox.appending(path: name)
                var n = 2
                while FileManager.default.fileExists(atPath: destination.path) {
                    let base = (name as NSString).deletingPathExtension
                    destination = inbox.appending(path: "\(base) \(n).pdf")
                    n += 1
                }
                do {
                    try FileManager.default.copyItem(at: url, to: destination)
                    continuation.resume(returning: .success(destination))
                } catch {
                    continuation.resume(returning: .failure(error))
                }
            }
        }
    }
}

struct ShareView: View {
    let state: ShareState
    let done: () -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                switch state.phase {
                case .saving:
                    ProgressView()
                    Text("Saving…").font(.headline)
                case let .saved(count):
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(.green)
                    Text("Saved to محرر PDF").font(.headline)
                    Text("\(count) files saved. Find them under My documents.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                case let .failed(message):
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(.red)
                    Text("Could not save").font(.headline)
                    Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(Text(verbatim: "\u{2067}محرر PDF\u{2069}"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: done)
                        .disabled(state.phase == .saving)
                }
            }
        }
    }
}
