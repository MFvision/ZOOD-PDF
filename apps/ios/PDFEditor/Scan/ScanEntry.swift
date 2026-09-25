import PhotosUI
import SwiftUI
import VisionKit

/// Where every "Scan" lands — the Scan widget, the Control Center control,
/// the Shortcut, the quick action, the Library's button: the system's
/// document camera when the device has one (edge detection, auto-shutter,
/// several pages), and otherwise pictures from the photo library. Either
/// way the pages become a PDF through the core, in the default scan mode
/// from Settings, saved among My documents, indexed and opened.
///
/// The scanner's own pipeline (enhancement, ID and book modes, the text
/// layer) is the scan feature's; this is the entry it takes over.
struct ScanEntry: View {
    let library: LibraryModel
    /// Pictures from the photo library even where there is a camera: the
    /// home screen's Create card.
    var picturesOnly = false
    @Environment(\.dismiss) private var dismiss
    @AppStorage(SettingsKey.scanMode) private var mode: ScanMode = .color
    @State private var pictures: [PhotosPickerItem] = []
    @State private var making = false
    @State private var failure: String?

    static var cameraAvailable: Bool {
        VNDocumentCameraViewController.isSupported
    }

    var body: some View {
        if Self.cameraAvailable, !picturesOnly {
            DocumentCamera { pages in
                make(pages.compactMap { $0.jpegData(compressionQuality: 0.9) })
            } cancel: {
                dismiss()
            }
            .ignoresSafeArea()
        } else {
            fromPhotos
        }
    }

    /// The simulator, and a device without a camera: pages from photos.
    private var fromPhotos: some View {
        AppSheet(title: picturesOnly ? "Create a PDF" : "Scan") {
            VStack(spacing: Space.x6) {
                Image(systemName: picturesOnly ? "photo.on.rectangle.angled" : "doc.viewfinder")
                    .font(.system(size: 48, weight: .light))
                    .foregroundStyle(Surface.secondaryLabel)
                Text(picturesOnly ? "A PDF from pictures" : "No camera on this device")
                    .font(TextStyle.title)
                Text(picturesOnly ? "Choose pictures: each becomes a page of a new PDF, in the mode below." : "Choose pictures of the pages instead: each becomes a page of a new PDF.")
                    .font(TextStyle.body)
                    .foregroundStyle(Surface.secondaryLabel)
                    .multilineTextAlignment(.center)
                Picker("Mode", selection: $mode) {
                    ForEach(ScanMode.allCases) { item in
                        Text(item.title).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 360)
                PhotosPicker(selection: $pictures, maxSelectionCount: 40, matching: .images) {
                    Label("Choose pictures", systemImage: "photo.on.rectangle")
                }
                .buttonStyle(.borderedProminent)
                .disabled(making)
                .accessibilityIdentifier("scan.choose")
                if making {
                    ProgressView("Making the PDF…")
                }
                if let failure {
                    Text(failure)
                        .font(TextStyle.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(Space.x8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("scan.sheet")
            .onChange(of: pictures) { _, chosen in
                guard !chosen.isEmpty else { return }
                Task {
                    var pages: [Data] = []
                    for item in chosen {
                        if let data = try? await item.loadTransferable(type: Data.self) {
                            pages.append(data)
                        }
                    }
                    pictures = []
                    make(pages)
                }
            }
        }
    }

    private func make(_ pages: [Data]) {
        guard !pages.isEmpty else {
            dismiss()
            return
        }
        making = true
        failure = nil
        Task {
            do {
                let bytes = try await PDFMaker.pdf(fromPictures: pages, mode: mode)
                // A file name is a String, so this one is localized as one.
                let stamp = Date.now.formatted(date: .abbreviated, time: .shortened)
                let name = picturesOnly ? String(localized: "Pictures \(stamp)") : String(localized: "Scan \(stamp)")
                _ = try library.adopt(bytes: bytes, name: name)
                making = false
                dismiss()
            } catch {
                making = false
                failure = error.localizedDescription
            }
        }
    }
}

/// VisionKit's document camera, as a SwiftUI view.
struct DocumentCamera: UIViewControllerRepresentable {
    let scanned: ([UIImage]) -> Void
    let cancel: () -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    /// VisionKit calls its delegate on the main thread; the protocol does
    /// not say so, hence the assumption at each entry.
    @MainActor
    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: DocumentCamera

        init(parent: DocumentCamera) {
            self.parent = parent
        }

        nonisolated func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            let pages = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
            MainActor.assumeIsolated { parent.scanned(pages) }
        }

        nonisolated func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            MainActor.assumeIsolated { parent.cancel() }
        }

        nonisolated func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: any Error) {
            MainActor.assumeIsolated { parent.cancel() }
        }
    }
}
