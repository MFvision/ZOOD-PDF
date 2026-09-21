import SwiftUI
import UIKit
import VisionKit

/// VisionKit's document camera: automatic edges, auto-shutter, a session of
/// many pages, the pages handed back already cut out. Offered only where
/// `VNDocumentCameraViewController.isSupported` — never on the simulator,
/// which has no camera; the pipeline then works on photos instead.
struct DocumentCameraView: UIViewControllerRepresentable {
    let onScan: ([CGImage]) -> Void
    let onCancel: () -> Void
    let onError: (String) -> Void

    static var isSupported: Bool { VNDocumentCameraViewController.isSupported }

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
