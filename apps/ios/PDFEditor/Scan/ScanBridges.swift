import AVFoundation
import SwiftUI
import UIKit
import VisionKit

/// Whether the document camera can be opened, and when it cannot, why —
/// so the scanner can say the true reason instead of showing a black stage.
/// On the main actor, as VisionKit's own answer is.
@MainActor
enum CameraAccess: Equatable, Sendable {
    /// There is a camera and the app may use it.
    case ready
    /// There is a camera; the person has not been asked yet.
    case notAsked
    /// The person said no. Only the Settings app can change that.
    case denied
    /// A configuration profile or Screen Time forbids the camera.
    case restricted
    /// There is no camera at all — the simulator. Photos instead.
    case missing

    /// What the scanner goes by: the state on this device, or what a UI test's
    /// `-warraqCamera` says (Debug builds only).
    static var now: CameraAccess {
        #if DEBUG
        if let overridden { return overridden }
        #endif
        return current
    }

    /// What the state is on this device right now. The permission is looked at
    /// before the hardware: iOS hands out no capture device once access is
    /// denied, and answering "this device has no camera" to someone who turned
    /// the camera off would be a lie.
    static var current: CameraAccess {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied: return .denied
        case .restricted: return .restricted
        case .authorized: return hasCamera ? .ready : .missing
        case .notDetermined: return hasCamera ? .notAsked : .missing
        @unknown default: return hasCamera ? .notAsked : .missing
        }
    }

    /// VisionKit says the simulator supports the document camera; it has
    /// no camera to show, so the device must have one too.
    static var hasCamera: Bool {
        VNDocumentCameraViewController.isSupported && AVCaptureDevice.default(for: .video) != nil
    }

    /// Asks, if asking is what is left to do, and answers the state afterwards.
    /// The system panel appears once in the app's life; every later launch
    /// reads the answer back from `now`.
    static func asked() async -> CameraAccess {
        #if DEBUG
        // A UI test's answer is whatever it said; there is nothing to ask.
        if let overridden { return overridden == .notAsked ? .ready : overridden }
        #endif
        guard current == .notAsked else { return current }
        _ = await AVCaptureDevice.requestAccess(for: .video)
        return current
    }

    /// Whether the document camera would show a picture if it were opened.
    var opensCamera: Bool { self == .ready }

    #if DEBUG
    /// A UI test's `-warraqCamera ready|notAsked|denied|restricted|missing`.
    /// The simulator has no camera and no way to deny one, so this is the only
    /// way to walk the scanner through each answer on this machine.
    static var overridden: CameraAccess? {
        switch UserDefaults.standard.string(forKey: "warraqCamera") {
        case "ready": .ready
        case "notAsked": .notAsked
        case "denied": .denied
        case "restricted": .restricted
        case "missing": .missing
        default: nil
        }
    }
    #endif
}

/// VisionKit's document camera: automatic edges, auto-shutter, a session of
/// many pages, the pages handed back already cut out. Offered only where
/// `CameraAccess.current.opensCamera` — never on the simulator, which has no
/// camera; the pipeline then works on photos instead.
struct DocumentCameraView: UIViewControllerRepresentable {
    let onScan: ([CGImage]) -> Void
    let onCancel: () -> Void
    let onError: (String) -> Void

    /// Kept as it was for the code that only asks whether a camera exists;
    /// `CameraAccess.current` is what the scanner asks.
    static var isSupported: Bool { CameraAccess.hasCamera }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    /// The delegate's protocol is not actor-annotated; VisionKit calls it
    /// on the main thread, which `assumeIsolated` states.
    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: DocumentCameraView

        init(parent: DocumentCameraView) {
            self.parent = parent
        }

        nonisolated func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            var images: [CGImage] = []
            for index in 0..<min(scan.pageCount, ScanSession.maxPages) {
                if let image = scan.imageOfPage(at: index).cgImage {
                    images.append(image)
                }
            }
            let parent = parent
            MainActor.assumeIsolated { parent.onScan(images) }
        }

        nonisolated func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            let parent = parent
            MainActor.assumeIsolated { parent.onCancel() }
        }

        nonisolated func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: any Error) {
            let message = error.localizedDescription
            let parent = parent
            MainActor.assumeIsolated { parent.onError(message) }
        }
    }
}

/// Live Text over a page: VisionKit's image analysis, so the words on the
/// picture can be selected, copied and looked up as in Photos. Offered
/// only where `ImageAnalyzer.isSupported`.
struct LiveTextView: UIViewRepresentable {
    let image: CGImage

    static var isSupported: Bool { ImageAnalyzer.isSupported }

    func makeUIView(context: Context) -> UIImageView {
        let view = UIImageView()
        view.contentMode = .scaleAspectFit
        view.isUserInteractionEnabled = true
        view.addInteraction(context.coordinator.interaction)
        return view
    }

    func updateUIView(_ view: UIImageView, context: Context) {
        let uiImage = UIImage(cgImage: image)
        guard view.image !== uiImage, view.image?.cgImage !== image else { return }
        view.image = uiImage
        context.coordinator.analyze(uiImage)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    @MainActor
    final class Coordinator {
        let interaction = ImageAnalysisInteraction()
        private let analyzer = ImageAnalyzer()
        private var task: Task<Void, Never>?

        init() {
            interaction.preferredInteractionTypes = [.textSelection, .dataDetectors]
        }

        func analyze(_ image: UIImage) {
            task?.cancel()
            interaction.analysis = nil
            task = Task {
                let configuration = ImageAnalyzer.Configuration([.text])
                guard let analysis = try? await analyzer.analyze(image, configuration: configuration), !Task.isCancelled else { return }
                interaction.analysis = analysis
            }
        }
    }
}
