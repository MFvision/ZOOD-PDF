import PhotosUI
import SwiftUI
import VisionKit
import ZoodCore

/// "Scan to PDF": dark camera screen with live corner handles and the mode strip
/// Document · Whiteboard · ID Card · Book.
/// * Document → VisionKit's document camera (edge detection, auto capture, several pages).
/// * Whiteboard / ID Card / Book → own AVFoundation capture + VNDetectRectanglesRequest, then
///   draggable corners, perspective correction and the mode's processing.
/// Photos can be imported into the same pipeline (also what works on the Simulator).
/// Vision OCR adds an invisible text layer; Arabic is used only if this device supports it.
struct ScanScreen: View {
    let initialMode: DeepLink.ScanMode
    let onFinish: (URL) -> Void

    struct Editing: Identifiable {
        let id = UUID()
        let image: ScanImage
        let quad: Quad?
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(Library.self) private var library
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var mode: DeepLink.ScanMode = .document
    @State private var camera = CameraController()
    @State private var cameraRunning = false
    @State private var liveQuad: Quad?
    @State private var pages: [ScanPage] = []
    @State private var editing: Editing?
    @State private var idFront: (image: ScanImage, lines: [OCRLine])?
    @State private var showDocumentCamera = false
    @State private var ocrEnabled = true
    @State private var arabicOCR = true
    @State private var rightToLeftBook = true
    @State private var busy = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var error: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar
                viewfinder
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLarge, style: .continuous))
                    .padding(.horizontal, 12)
                notices
                modeStrip
                bottomBar
            }
            if busy {
                ProgressView().tint(.white).padding(24).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
            }
        }
        .preferredColorScheme(.dark)
        .environment(\.colorScheme, .dark)
        .task {
            mode = initialMode
            rightToLeftBook = layoutDirection == .rightToLeft
            arabicOCR = await Task.detached { OCRService.arabicAvailable }.value
            camera.onQuad = { liveQuad = $0 }
            await updateCamera()
        }
        .onChange(of: mode) { _, _ in
            idFront = nil
            Task { await updateCamera() }
        }
        .onDisappear { camera.stop() }
        .fullScreenCover(item: $editing) { e in
            CornerEditor(
                image: e.image, quad: e.quad,
                title: mode == .idCard
                    ? (idFront == nil ? LocalizedStringKey("scan.id.front") : LocalizedStringKey("scan.id.back"))
                    : LocalizedStringKey("scan.adjustCorners"),
                onRetake: { editing = nil },
                onUse: { quad in
                    editing = nil
                    Task { await process(e.image, quad: quad) }
                })
        }
        .fullScreenCover(isPresented: $showDocumentCamera) {
            DocumentCameraView(
                onFinish: { images in
                    showDocumentCamera = false
                    Task { await addDocumentCameraImages(images) }
                },
                onCancel: { showDocumentCamera = false })
            .ignoresSafeArea()
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await importPhotos(items) }
        }
        .alert(Text("common.error"), isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("common.ok", role: .cancel) {}
        } message: {
            Text(verbatim: error ?? "")
        }
    }

    // MARK: - Pieces

    private var topBar: some View {
        HStack {
            Button {
                camera.stop()
                dismiss()
            } label: {
                Image(systemName: "xmark").font(.title3.weight(.semibold)).frame(width: 44, height: 44)
            }
            .accessibilityLabel(Text("common.close"))
            Spacer()
            Text("scan.title").font(.headline)
            Spacer()
            Button {
                ocrEnabled.toggle()
            } label: {
                Image(systemName: ocrEnabled ? "text.viewfinder" : "text.badge.xmark")
                    .font(.title3).frame(width: 44, height: 44)
                    .foregroundStyle(ocrEnabled ? Color.accentColor : Color.white.opacity(0.6))
            }
            .accessibilityLabel(Text(ocrEnabled ? LocalizedStringKey("scan.ocr.on") : LocalizedStringKey("scan.ocr.off")))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 8)
    }

    @ViewBuilder private var viewfinder: some View {
        if mode == .document {
            VStack(spacing: 16) {
                Image(systemName: "doc.viewfinder").font(.system(size: 64)).foregroundStyle(.white.opacity(0.8))
                Text("scan.document.hint").multilineTextAlignment(.center).foregroundStyle(.white.opacity(0.8))
                if VNDocumentCameraViewController.isSupported {
                    Button("scan.document.start") { showDocumentCamera = true }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("scan.document.start")
                } else {
                    Text("scan.cameraUnavailable").font(.footnote).foregroundStyle(.white.opacity(0.6))
                        .multilineTextAlignment(.center)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(white: 0.08))
        } else if cameraRunning {
            GeometryReader { geo in
                ZStack {
                    CameraPreview(session: camera.session)
                    if let q = liveQuad { liveOverlay(q, in: geo.size) }
                }
            }
        } else {
            VStack(spacing: 12) {
                Image(systemName: "camera.fill").font(.system(size: 44)).foregroundStyle(.white.opacity(0.5))
                Text("scan.cameraUnavailable").multilineTextAlignment(.center).foregroundStyle(.white.opacity(0.7))
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(white: 0.08))
        }
    }

    /// Live page outline with corner handles over the preview (aspect-fill of a 3:4 frame).
    private func liveOverlay(_ q: Quad, in size: CGSize) -> some View {
        let s = max(size.width / 3, size.height / 4)
        let w = 3 * s
        let h = 4 * s
        let ox = (size.width - w) / 2
        let oy = (size.height - h) / 2
        let pts = q.points.map { CGPoint(x: ox + $0.x * w, y: oy + $0.y * h) }
        return ZStack {
            Path { p in
                p.addLines(pts)
                p.closeSubpath()
            }
            .fill(Color.accentColor.opacity(0.18))
            Path { p in
                p.addLines(pts)
                p.closeSubpath()
            }
            .stroke(Color.accentColor, lineWidth: 3)
            ForEach(0..<pts.count, id: \.self) { i in
                Circle().fill(.white).frame(width: 18, height: 18)
                    .overlay(Circle().strokeBorder(Color.accentColor, lineWidth: 3))
                    .position(pts[i])
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: q)
        .accessibilityHidden(true)
    }

    @ViewBuilder private var notices: some View {
        VStack(spacing: 4) {
            if ocrEnabled && !arabicOCR {
                Text("scan.ocr.noArabic").font(.caption).foregroundStyle(.yellow).multilineTextAlignment(.center)
            }
            if mode == .idCard {
                Text(idFront == nil ? LocalizedStringKey("scan.id.front") : LocalizedStringKey("scan.id.back")).font(.callout.weight(.semibold)).foregroundStyle(.white)
            }
            if mode == .book {
                Toggle("scan.book.rtl", isOn: $rightToLeftBook).tint(.accentColor).foregroundStyle(.white)
                    .font(.footnote).padding(.horizontal, 40)
            }
        }
        .padding(.top, 8)
    }

    private var modeStrip: some View {
        HStack(spacing: 22) {
            ForEach(DeepLink.ScanMode.allCases, id: \.self) { m in
                Button {
                    mode = m
                } label: {
                    Text(modeName(m))
                        .font(.subheadline.weight(mode == m ? .bold : .regular))
                        .foregroundStyle(mode == m ? Color.yellow : Color.white.opacity(0.75))
                }
                .accessibilityAddTraits(mode == m ? .isSelected : [])
                .accessibilityIdentifier("scan.mode.\(m.rawValue)")
            }
        }
        .padding(.vertical, 12)
    }

    private var bottomBar: some View {
        HStack {
            PhotosPicker(selection: $photoItems, maxSelectionCount: mode == .idCard ? 1 : 20, matching: .images) {
                Image(systemName: "photo.on.rectangle").font(.title2).frame(width: 56, height: 56)
                    .foregroundStyle(.white)
            }
            .accessibilityLabel(Text("scan.importPhotos"))
            Spacer()
            Button {
                Task { await shutter() }
            } label: {
                ZStack {
                    Circle().strokeBorder(.white, lineWidth: 4).frame(width: 74, height: 74)
                    Circle().fill(.white).frame(width: 60, height: 60)
                }
            }
            .disabled(busy || (mode != .document && !cameraRunning) || (mode == .document && !VNDocumentCameraViewController.isSupported))
            .accessibilityLabel(Text("scan.shutter"))
            .accessibilityIdentifier("scan.shutter")
            Spacer()
            Button {
                Task { await save() }
            } label: {
                ZStack(alignment: .topTrailing) {
                    if let last = pages.last {
                        Image(decorative: last.preview.cg, scale: 1).resizable().scaledToFill()
                            .frame(width: 50, height: 60).clipShape(RoundedRectangle(cornerRadius: 6))
                    } else {
                        RoundedRectangle(cornerRadius: 6).strokeBorder(.white.opacity(0.4)).frame(width: 50, height: 60)
                    }
                    if !pages.isEmpty {
                        Text(pages.count, format: .number).font(.caption2.bold()).padding(5)
                            .background(Color.accentColor, in: Circle()).foregroundStyle(.white).offset(x: 8, y: -8)
                    }
                }
                .frame(width: 56, height: 64)
            }
            .disabled(pages.isEmpty || busy)
            .accessibilityLabel(Text("scan.save \(pages.count)"))
            .accessibilityIdentifier("scan.save")
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 20)
    }

    private func modeName(_ m: DeepLink.ScanMode) -> LocalizedStringKey {
        switch m {
        case .document: "scan.mode.document"
        case .whiteboard: "scan.mode.whiteboard"
        case .idCard: "scan.mode.idCard"
        case .book: "scan.mode.book"
        }
    }

    // MARK: - Flow

    private func updateCamera() async {
        if mode == .document {
            camera.stop()
            cameraRunning = false
        } else {
            cameraRunning = await camera.start()
        }
    }

    private func shutter() async {
        if mode == .document {
            showDocumentCamera = true
            return
        }
        guard let data = await camera.capture(), let ui = UIImage(data: data), let img = ScanProcessor.upright(ui) else { return }
        editing = Editing(image: img, quad: await ScanProcessor.detectQuad(img))
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self), let ui = UIImage(data: data),
                  let img = ScanProcessor.upright(ui) else { continue }
            if items.count == 1 || mode == .idCard {
                editing = Editing(image: img, quad: await ScanProcessor.detectQuad(img))
                return
            }
            // Several photos: use the detected outline (or the whole picture) without asking.
            let quad = await ScanProcessor.detectQuad(img) ?? Quad.inset(img.size, by: 0)
            await process(img, quad: quad)
        }
    }

    private func addDocumentCameraImages(_ images: [UIImage]) async {
        busy = true
        defer { busy = false }
        for ui in images {
            guard let img = ScanProcessor.upright(ui) else { continue }
            pages.append(.image(img, await lines(for: img)))
        }
    }

    private func process(_ image: ScanImage, quad: Quad) async {
        busy = true
        defer { busy = false }
        guard let corrected = await ScanProcessor.correct(image, quad: quad, mode: mode) else {
            error = String(localized: "scan.error.process")
            return
        }
        switch mode {
        case .document, .whiteboard:
            pages.append(.image(corrected, await lines(for: corrected)))
        case .book:
            for half in ScanProcessor.splitBook(corrected, rightToLeft: rightToLeftBook) {
                pages.append(.image(half, await lines(for: half)))
            }
        case .idCard:
            let ocr = await lines(for: corrected)
            if let front = idFront {
                pages.append(.idCard(front: front.image, back: corrected, frontLines: front.lines, backLines: ocr))
                idFront = nil
            } else {
                idFront = (corrected, ocr)
            }
        }
    }

    private func lines(for image: ScanImage) async -> [OCRLine] {
        guard ocrEnabled else { return [] }
        return await OCRService.recognize(image)
    }

    private func save() async {
        busy = true
        defer { busy = false }
        var output = pages
        if let front = idFront {
            // Only the front was captured: keep it as an ordinary page.
            output.append(.image(front.image, front.lines))
        }
        let name = FileNaming.scanName(prefix: String(localized: "scan.filePrefix"), date: .now)
        let title = FileNaming.baseName(name)
        let pdf = await Task.detached(priority: .userInitiated) { ScanPDFBuilder.build(output, title: title) }.value
        do {
            let url = try DocumentLibrary.saveNew(pdf, name: name, folder: "Scans")
            await library.record(url: url, data: pdf)
            camera.stop()
            onFinish(url)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
