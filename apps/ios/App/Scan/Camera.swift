@preconcurrency import AVFoundation
import SwiftUI
import Vision
import VisionKit
import ZoodCore

/// AVFoundation capture for the custom modes (Whiteboard · ID Card · Book): live preview,
/// live page outline via VNDetectRectanglesRequest (~6 per second), still photo capture.
/// All session work runs on one serial queue; results reach the UI on the main actor.
final class CameraController: NSObject, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "sa.zood.pdf.camera")
    private let photoOutput = AVCapturePhotoOutput()
    private let videoOutput = AVCaptureVideoDataOutput()
    // Guarded by `queue`.
    private var configured = false
    private var lastDetection = Date.distantPast
    private var photoContinuation: CheckedContinuation<Data?, Never>?
    /// Live outline, normalised to the (portrait) video frame, origin top-left.
    @MainActor var onQuad: ((Quad?) -> Void)?

    static var isAvailable: Bool {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
    }

    func start() async -> Bool {
        guard Self.isAvailable else { return false }
        let granted: Bool
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: granted = true
        case .notDetermined: granted = await AVCaptureDevice.requestAccess(for: .video)
        default: granted = false
        }
        guard granted else { return false }
        return await withCheckedContinuation { cont in
            queue.async {
                cont.resume(returning: self.configureAndRun())
            }
        }
    }

    func stop() {
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    private func configureAndRun() -> Bool {
        if !configured {
            session.beginConfiguration()
            session.sessionPreset = .photo
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input),
                  session.canAddOutput(photoOutput), session.canAddOutput(videoOutput)
            else {
                session.commitConfiguration()
                return false
            }
            session.addInput(input)
            session.addOutput(photoOutput)
            videoOutput.alwaysDiscardsLateVideoFrames = true
            videoOutput.setSampleBufferDelegate(self, queue: queue)
            session.addOutput(videoOutput)
            if let c = videoOutput.connection(with: .video), c.isVideoRotationAngleSupported(90) {
                c.videoRotationAngle = 90 // portrait buffers, so Vision boxes match the preview
            }
            session.commitConfiguration()
            configured = true
        }
        if !session.isRunning { session.startRunning() }
        return true
    }

    /// JPEG/HEIC bytes of a still photo.
    func capture() async -> Data? {
        await withCheckedContinuation { cont in
            queue.async {
                guard self.photoContinuation == nil else {
                    cont.resume(returning: nil)
                    return
                }
                self.photoContinuation = cont
                let settings = AVCapturePhotoSettings()
                settings.photoQualityPrioritization = .quality
                if let c = self.photoOutput.connection(with: .video), c.isVideoRotationAngleSupported(90) {
                    c.videoRotationAngle = 90
                }
                self.photoOutput.capturePhoto(with: settings, delegate: self)
            }
        }
    }
}

extension CameraController: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: (any Error)?) {
        let data = photo.fileDataRepresentation()
        queue.async {
            self.photoContinuation?.resume(returning: data)
            self.photoContinuation = nil
        }
    }
}

extension CameraController: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        // Called on `queue`.
        let now = Date()
        guard now.timeIntervalSince(lastDetection) > 0.16, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastDetection = now
        let request = VNDetectRectanglesRequest()
        request.minimumConfidence = 0.6
        request.minimumAspectRatio = 0.3
        request.minimumSize = 0.2
        request.maximumObservations = 1
        try? VNImageRequestHandler(cvPixelBuffer: pixels, options: [:]).perform([request])
        var quad: Quad?
        if let r = request.results?.first {
            func p(_ c: CGPoint) -> Point2 { Point2(Double(c.x), Double(c.y)) }
            quad = Quad.fromVision(
                topLeft: p(r.topLeft), topRight: p(r.topRight), bottomRight: p(r.bottomRight), bottomLeft: p(r.bottomLeft),
                imageSize: Size2(1, 1))
        }
        let result = quad
        Task { @MainActor [weak self] in self?.onQuad?(result) }
    }
}

/// Live camera preview layer.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer } // layerClass guarantees it
    }

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.previewLayer.session = session
        v.previewLayer.videoGravity = .resizeAspectFill
        v.backgroundColor = .black
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}

/// VisionKit's document camera (Document mode): edge detection, auto capture, multi-page.
struct DocumentCameraView: UIViewControllerRepresentable {
    let onFinish: ([UIImage]) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish, onCancel: onCancel) }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController()
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: VNDocumentCameraViewController, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onFinish: ([UIImage]) -> Void
        let onCancel: () -> Void

        init(onFinish: @escaping ([UIImage]) -> Void, onCancel: @escaping () -> Void) {
            self.onFinish = onFinish
            self.onCancel = onCancel
        }

        nonisolated func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            MainActor.assumeIsolated {
                let images = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
                onFinish(images)
            }
        }

        nonisolated func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            MainActor.assumeIsolated { onCancel() }
        }

        nonisolated func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: any Error) {
            MainActor.assumeIsolated { onCancel() }
        }
    }
}
