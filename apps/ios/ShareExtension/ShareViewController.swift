import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WarraqCore

/// "Save to ZOOD PDF" in the share sheet: every PDF shared is copied into
/// the shared container's Inbox, and every picture becomes a page of one
/// new PDF there (the core's `create.images`); the app takes the Inbox
/// into its own Documents folder and its Library the next time it is in
/// front. Nothing else happens, and nothing leaves the device.
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

    /// How many pictures one share turns into pages: an extension has
    /// little memory.
    static let maxPictures = 20

    func save(_ providers: [NSItemProvider]) async {
        let inbox = AppGroup.ensure(AppGroup.inboxURL)
        var saved = 0
        var lastError: String?
        var pictures: [Data] = []
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
                switch await Self.copy(provider, into: inbox) {
                case .success: saved += 1
                case let .failure(error): lastError = error.localizedDescription
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), pictures.count < Self.maxPictures {
                if let data = await Self.load(provider, type: UTType.image.identifier) {
                    pictures.append(data)
                }
            }
        }
        if !pictures.isEmpty {
            do {
                let bytes = try await PicturePDF.make(pictures)
                // A file name is a String, so this one is localized as one.
                let name = String(localized: "Pictures \(Date.now.formatted(date: .abbreviated, time: .shortened))")
                try bytes.write(to: Self.freeName("\(name).pdf", in: inbox), options: .atomic)
                saved += 1
            } catch {
                lastError = error.localizedDescription
            }
        }
        if saved > 0 {
            phase = .saved(count: saved)
        } else {
            phase = .failed(lastError.map { LocalizedStringKey($0) } ?? "Nothing shared was a PDF or a picture.")
        }
    }

    nonisolated static func freeName(_ name: String, in folder: URL) -> URL {
        var destination = folder.appending(path: name)
        var n = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            let base = (name as NSString).deletingPathExtension
            let ext = (name as NSString).pathExtension
            destination = folder.appending(path: "\(base) \(n).\(ext)")
            n += 1
        }
        return destination
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
                let destination = freeName(name, in: inbox)
                do {
                    try FileManager.default.copyItem(at: url, to: destination)
                    continuation.resume(returning: .success(destination))
                } catch {
                    continuation.resume(returning: .failure(error))
                }
            }
        }
    }

    /// A picture's bytes, from a file or from data, whichever the sharer gives.
    private static func load(_ provider: NSItemProvider, type: String) async -> Data? {
        let fromFile: Data? = await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                continuation.resume(returning: url.flatMap { try? Data(contentsOf: $0) })
            }
        }
        if let fromFile { return fromFile }
        return await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }
}

/// Pictures into one PDF through the core, each bounded in size first.
enum PicturePDF {
    static let maxPixels = 2200

    static func make(_ pictures: [Data]) async throws -> Data {
        struct Args: Encodable {
            let paper = "own"
            let orientation = "auto"
            let margin = 0
        }
        let prepared = pictures.compactMap(shrink)
        guard !prepared.isEmpty else { throw CoreError.arguments("no picture could be read") }
        let reply = try await Core.callStatic(op: "create.images", args: Args(), blobs: prepared)
        guard let bytes = reply.blobs.first else { throw CoreError.badReply("create.images answered no bytes") }
        return bytes
    }

    private static func shrink(_ bytes: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceShouldCache: false,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image).jpegData(compressionQuality: 0.85)
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
                    Text("Saved to ZOOD PDF").font(.headline)
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
            .navigationTitle(Text("ZOOD PDF"))
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
