import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Scan to PDF: a dark camera screen. The page on the stage with the
/// corners Vision found as four handles that can be dragged there and
/// then; "Auto" at the top (the corners found by Vision, or the whole
/// photo); the mode strip along the bottom — Document · Whiteboard ·
/// ID Card · Book — and the large round shutter. Where there is a camera
/// the shutter opens VisionKit's document camera; where there is none
/// (the simulator) the shutter takes a photo from the library and its
/// caption says so; Files and Photos are always there. Save makes the PDF
/// with its text layer and hands it back to the Library.
struct ScanView: View {
    @State private var session: ScanSession
    let onSaved: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(SettingsKey.scanColorMode) private var storedColorMode: ScanColorMode = .color
    @AppStorage(SettingsKey.ocrLanguages) private var storedLanguages = "ar,en"
    @State private var showingCamera = false
    @State private var showingPhotos = false
    @State private var showingFiles = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var showingEnhance = false
    @State private var showingText = false
    @State private var showingSave = false
    @State private var retaking: UUID?
    @State private var captures = 0
    @State private var liveText = false
    @State private var loadedLaunchArguments = false
    /// Auto: the corners Vision finds. Off: the whole photo, corners by hand.
    @State private var auto = true
    /// Pictures the scanner starts with: a photo handed to the app from
    /// Files or another app.
    private let initialImages: [CGImage]

    init(mode: ScanMode = .document, images: [CGImage] = [], documentsFolder: URL? = nil, onSaved: @escaping (URL) -> Void) {
        let folder = documentsFolder ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        _session = State(initialValue: ScanSession(mode: mode, documentsFolder: folder))
        initialImages = images
        self.onSaved = onSaved
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                stage
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                actions
                PageStrip(session: session, onRetake: { id in
                    retaking = id
                    showingPhotos = true
                })
                modeStrip
                shutterBar
            }
            .background(Color.black)
            .navigationTitle("Scan to PDF")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar { toolbar }
        }
        .preferredColorScheme(.dark)
        .onAppear(perform: applyStoredSettings)
        .task {
            if !initialImages.isEmpty, session.pages.isEmpty {
                take(initialImages)
            }
            loadLaunchArguments()
        }
        .fullScreenCover(isPresented: $showingCamera) {
            DocumentCameraView { images in
                showingCamera = false
                take(images)
            } onCancel: {
                showingCamera = false
            } onError: { message in
                showingCamera = false
                session.error = LocalizedStringKey(message)
            }
            .ignoresSafeArea()
        }
        .photosPicker(isPresented: $showingPhotos, selection: $picked, maxSelectionCount: retaking == nil ? ScanSession.maxPages : 1, matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await load(items) }
        }
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.image], allowsMultipleSelection: retaking == nil) { result in
            guard case let .success(urls) = result else { return }
            Task { await load(urls) }
        }
        .sheet(isPresented: $showingEnhance) {
            if let page = session.selected {
                EnhancePanel(session: session, pageID: page.id)
            }
        }
        .sheet(isPresented: $showingText) {
            ScanTextSheet(session: session)
        }
        .sheet(isPresented: $showingSave) {
            SaveScanSheet(session: session) { url in
                showingSave = false
                onSaved(url)
                dismiss()
            }
        }
        .alert("Could not scan", isPresented: Binding(get: { session.error != nil }, set: { if !$0 { session.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(session.error ?? "")
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: captures)
        .sensoryFeedback(.selection, trigger: session.mode)
        .onChange(of: auto) { _, on in
            // Off: the whole photo; on: the corners found again.
            for page in session.pages {
                if on {
                    let image = page.original
                    let book = session.mode == .book
                    Task {
                        let found = await Task.detached { book ? ScanPipeline.detectSpread(in: image) : ScanPipeline.detectPage(in: image) }.value
                        session.setQuad(found ?? .whole(page.originalSize), for: page.id)
                    }
                } else {
                    session.setQuad(.whole(page.originalSize), for: page.id)
                }
            }
        }
    }

    // MARK: - Pieces

    @ViewBuilder
    private var stage: some View {
        if session.mode.composesOnePage, let composed = session.composedPage {
            ScanStage(image: composed, quad: nil, label: composedLabel, processing: session.isProcessing, liveText: liveText, onQuad: nil)
                .padding(Space.x5)
        } else if let page = session.selected {
            ScanStage(image: session.previewOriginal ? (page.corrected ?? page.original) : page.display,
                      quad: page.enhanced == nil && page.corrected == nil ? page.quad : nil,
                      label: pageLabel(page), processing: page.isProcessing, liveText: liveText) { quad in
                session.setQuad(quad, for: page.id)
            }
            .padding(Space.x5)
        } else {
            EmptyState(symbol: session.mode.symbol, title: emptyTitle, message: emptyMessage)
                .accessibilityIdentifier("scan.empty")
        }
    }

    private var composedLabel: Text {
        session.passport ? Text("Passport page at real size") : Text("Front and back on one page, at card size")
    }

    private func pageLabel(_ page: ScanPage) -> Text {
        let index = (session.selectedIndex ?? 0) + 1
        var text = Text("Page \(index) of \(session.pages.count)")
        if let side = page.side {
            text = text + Text(verbatim: " · ") + Text(side.title)
        }
        if page.skew != 0 {
            text = text + Text(verbatim: " · ") + Text("levelled \(page.skew, format: .number.precision(.fractionLength(1)))°")
        }
        if let bow = page.bow, bow > 0 {
            text = text + Text(verbatim: " · ") + Text("curve \(Int(bow.rounded())) px")
        }
        return text
    }

    private var emptyTitle: LocalizedStringKey {
        switch session.mode {
        case .document: "No pages yet"
        case .whiteboard: "Scan a whiteboard"
        case .idCard: session.passport ? "Scan the passport's page" : "Scan the front, then the back"
        case .book: "Scan an open book"
        }
    }

    private var emptyMessage: LocalizedStringKey {
        if DocumentCameraView.isSupported {
            return "Point the camera at the page; it finds the edges and takes the picture. Or choose photos."
        }
        return "This device has no camera. Choose photos from the library or from Files; the pages are found, straightened and cleaned the same way."
    }

    private var actions: some View {
        HStack(spacing: Space.x3) {
            Button("Enhance", systemImage: "wand.and.stars") {
                showingEnhance = true
            }
            .accessibilityIdentifier("scan.enhance")
            Button("Retake", systemImage: "arrow.triangle.2.circlepath.camera") {
                guard let page = session.selected else { return }
                retaking = page.id
                if DocumentCameraView.isSupported { showingCamera = true } else { showingPhotos = true }
            }
            .accessibilityIdentifier("scan.retake")
            if LiveTextView.isSupported {
                Toggle("Live Text", systemImage: "text.viewfinder", isOn: $liveText)
                    .toggleStyle(.button)
                    .accessibilityIdentifier("scan.livetext")
            }
            Button("Delete", systemImage: "trash", role: .destructive) {
                if let page = session.selected { session.remove(page.id) }
            }
            .accessibilityIdentifier("scan.delete")
            if session.mode == .idCard {
                Spacer()
                Toggle("Passport size", isOn: $session.passport)
                    .toggleStyle(.button)
                    .accessibilityIdentifier("scan.passport")
            }
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .tint(.white)
        .disabled(session.pages.isEmpty && session.mode != .idCard)
        .padding(.horizontal, Space.x5)
        .padding(.bottom, Space.x3)
    }

    /// Document · Whiteboard · ID Card · Book, the chosen one lit.
    private var modeStrip: some View {
        HStack(spacing: Space.x2) {
            ForEach(ScanMode.allCases) { mode in
                Button {
                    withAnimation(Motion.travel(reduceMotion: reduceMotion)) { session.mode = mode }
                } label: {
                    Text(mode.title)
                        .font(.subheadline.weight(session.mode == mode ? .semibold : .regular))
                        .foregroundStyle(session.mode == mode ? Color.black : Color.white.opacity(0.85))
                        .padding(.horizontal, Space.x4)
                        .padding(.vertical, Space.x3)
                        .background(session.mode == mode ? Color.white : Color.white.opacity(0.12), in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.pressable)
                .accessibilityAddTraits(session.mode == mode ? [.isSelected] : [])
                .accessibilityIdentifier("scan.mode.\(mode.rawValue)")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Space.x5)
        .padding(.top, Space.x3)
        .background(Color.black)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("scan.mode")
    }

    private var shutterBar: some View {
        VStack(spacing: Space.x2) {
            HStack {
                Button {
                    retaking = nil
                    showingFiles = true
                } label: {
                    Label("Files", systemImage: "folder")
                        .labelStyle(.iconOnly)
                        .font(.title2)
                        .frame(width: 56, height: 56)
                }
                .buttonStyle(.pressable)
                .accessibilityIdentifier("scan.files")
                Spacer()
                ShutterButton(cameraAvailable: DocumentCameraView.isSupported) {
                    retaking = nil
                    if DocumentCameraView.isSupported { showingCamera = true } else { showingPhotos = true }
                }
                Spacer()
                Button {
                    retaking = nil
                    showingPhotos = true
                } label: {
                    Label("Photos", systemImage: "photo.on.rectangle")
                        .labelStyle(.iconOnly)
                        .font(.title2)
                        .frame(width: 56, height: 56)
                }
                .buttonStyle(.pressable)
                .accessibilityIdentifier("scan.photos")
            }
            .foregroundStyle(.white)
            .padding(.horizontal, Space.x7)
            Text(DocumentCameraView.isSupported ? "Camera" : "No camera on this device — the shutter chooses a photo")
                .font(TextStyle.caption)
                .foregroundStyle(Color.white.opacity(0.6))
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("scan.shutterCaption")
        }
        .padding(.top, Space.x4)
        .padding(.bottom, Space.x5)
        .background(Color.black)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }
                .accessibilityIdentifier("scan.close")
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button("Text", systemImage: "text.quote") {
                showingText = true
            }
            .disabled(session.pages.isEmpty)
            .accessibilityIdentifier("scan.text")
            Button("Save", systemImage: "square.and.arrow.down") {
                showingSave = true
            }
            .disabled(session.pages.isEmpty || session.isBusy)
            .accessibilityIdentifier("scan.save")
            Toggle("Auto", isOn: $auto)
                .toggleStyle(.button)
                .tint(.yellow)
                .accessibilityHint(Text("The page's corners found by Vision; off, the whole photo"))
                .accessibilityIdentifier("scan.auto")
        }
    }

    // MARK: - Taking pictures in

    private func applyStoredSettings() {
        session.defaultEnhancement.mode = storedColorMode
        session.chosenLanguages = storedLanguages.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private func take(_ images: [CGImage]) {
        guard !images.isEmpty else { return }
        Task {
            if let retaking, let first = images.first {
                await session.retake(retaking, with: first)
            } else {
                await session.add(images: images, detect: auto)
            }
            retaking = nil
            captures += 1
        }
    }

    private func load(_ items: [PhotosPickerItem]) async {
        var images: [CGImage] = []
        for item in items.prefix(ScanSession.maxPages) {
            if let data = try? await item.loadTransferable(type: Data.self), let image = ScanPipeline.loadImage(from: data) {
                images.append(image)
            }
        }
        if images.isEmpty {
            session.error = "None of the chosen pictures could be read."
            retaking = nil
            return
        }
        take(images)
    }

    private func load(_ urls: [URL]) async {
        var images: [CGImage] = []
        for url in urls.prefix(ScanSession.maxPages) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let image = ScanPipeline.loadImage(from: url) {
                images.append(image)
            }
        }
        if images.isEmpty {
            session.error = "None of the chosen pictures could be read."
            retaking = nil
            return
        }
        take(images)
    }

    /// A UI test, or a run from the command line: `-warraqScan <path>[,<path>…]`
    /// takes those photos in as if chosen; `-warraqScanMode document|whiteboard|idCard|passport|book`
    /// picks the mode (passport: ID Card at passport size).
    private func loadLaunchArguments() {
        #if DEBUG
        guard !loadedLaunchArguments else { return }
        loadedLaunchArguments = true
        let defaults = UserDefaults.standard
        if let raw = defaults.string(forKey: "warraqScanMode") {
            if raw == "passport" {
                session.mode = .idCard
                session.passport = true
            } else if let mode = ScanMode(rawValue: raw) {
                session.mode = mode
            }
        }
        guard let list = defaults.string(forKey: "warraqScan"), !list.isEmpty else { return }
        let urls = list.split(separator: ",").map { URL(filePath: String($0)) }
        Task { await load(urls) }
        #endif
    }
}

/// The page on the stage: the picture, and over it the corners Vision
/// found as four handles while the page is still being cut out — they
/// spring into place the moment detection answers, follow the finger 1:1
/// with a magnifier over the fingertip, and go with the picture once it
/// is cut. Once cut, a tap on the picture brings the corners back.
struct ScanStage: View {
    let image: CGImage
    let quad: Quad?
    let label: Text
    let processing: Bool
    let liveText: Bool
    /// Corners moved by hand (nil: not editable).
    let onQuad: ((Quad) -> Void)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    @State private var dragging: Int?
    @State private var dragged: Quad?
    @State private var releases = 0

    private static let magnifierSize: CGFloat = 120
    private static let magnification: CGFloat = 2.6

    var body: some View {
        GeometryReader { geometry in
            let size = CGSize(width: image.width, height: image.height)
            let fit = ScanGeometry.fit(size, in: CGRect(origin: .zero, size: geometry.size))
            let shown = dragged ?? quad
            ZStack {
                Group {
                    if liveText, LiveTextView.isSupported {
                        LiveTextView(image: image)
                    } else {
                        Image(decorative: image, scale: 1)
                            .resizable()
                            .interpolation(.high)
                    }
                }
                .frame(width: fit.width, height: fit.height)
                .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .position(x: fit.midX, y: fit.midY)
                if let shown {
                    DimmingShape(quad: shown, imageSize: size, rect: fit)
                        .fill(Color.black.opacity(0.4), style: FillStyle(eoFill: true))
                        .allowsHitTesting(false)
                    QuadShape(quad: shown, imageSize: size, rect: fit)
                        .stroke(shown.isConvex ? Color.accentColor : Color.red, style: StrokeStyle(lineWidth: 2, lineJoin: .round))
                        .allowsHitTesting(false)
                    ForEach(0..<4, id: \.self) { corner in
                        handle(corner, quad: shown, imageSize: size, fit: fit)
                    }
                    if let dragging {
                        magnifier(corner: dragging, quad: shown, imageSize: size, fit: fit, in: geometry.size)
                            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                    }
                }
                if processing {
                    ProgressView()
                        .controlSize(.small)
                        .padding(Space.x3)
                        .background(.regularMaterial, in: Capsule())
                        .position(x: fit.maxX - Space.x7, y: fit.maxY - Space.x7)
                        .accessibilityIdentifier("scan.processing")
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .coordinateSpace(name: "stage")
            .animation(dragging == nil ? Motion.travel(reduceMotion: reduceMotion) : nil, value: shown)
        }
        .sensoryFeedback(.impact(flexibility: .soft), trigger: releases)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
        .accessibilityValue(quad.map { Text(verbatim: ScanGeometry.describe($0)) } ?? Text("cut out"))
        .accessibilityIdentifier("scan.stage")
    }

    private func handle(_ corner: Int, quad: Quad, imageSize: CGSize, fit: CGRect) -> some View {
        let point = ScanGeometry.viewPoint(quad[corner], imageSize: imageSize, in: fit)
        let active = dragging == corner
        return ZStack {
            Circle().fill(Color.white).frame(width: 20, height: 20)
            Circle().stroke(Color.accentColor, lineWidth: 3).frame(width: 20, height: 20)
        }
        .scaleEffect(active && !reduceMotion ? 1.35 : 1)
        .frame(width: 52, height: 52)
        .contentShape(Circle())
        .position(point)
        .animation(Motion.press, value: active)
        .gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .named("stage"))
                .onChanged { value in
                    guard onQuad != nil else { return }
                    if dragging != corner {
                        dragging = corner
                        dragged = quad
                    }
                    guard var moved = dragged else { return }
                    let scale = imageSize.width / fit.width
                    let dx = value.translation.width * (layoutDirection == .rightToLeft ? -1 : 1) * scale
                    let dy = value.translation.height * scale
                    var p = quad[corner]
                    p.x = min(max(p.x + dx, 0), imageSize.width)
                    p.y = min(max(p.y + dy, 0), imageSize.height)
                    moved[corner] = p
                    dragged = moved
                }
                .onEnded { _ in
                    if let dragged, dragged.isConvex { onQuad?(dragged) }
                    dragging = nil
                    dragged = nil
                    releases += 1
                }
        )
        .accessibilityElement()
        .accessibilityLabel(cornerName(corner))
        .accessibilityValue(Text(verbatim: "\(Int(quad[corner].x.rounded())),\(Int(quad[corner].y.rounded()))"))
        .accessibilityIdentifier("crop.handle.\(corner)")
    }

    private func cornerName(_ corner: Int) -> Text {
        switch corner {
        case 0: Text("Top-left corner")
        case 1: Text("Top-right corner")
        case 2: Text("Bottom-right corner")
        default: Text("Bottom-left corner")
        }
    }

    /// The photo around the corner, magnified, placed above the finger (or
    /// below it near the top) so the finger does not hide it, with a
    /// crosshair on the corner itself.
    private func magnifier(corner: Int, quad: Quad, imageSize: CGSize, fit: CGRect, in size: CGSize) -> some View {
        let pixel = quad[corner]
        let side = Self.magnifierSize
        let scale = fit.width / imageSize.width * Self.magnification
        let handlePoint = ScanGeometry.viewPoint(pixel, imageSize: imageSize, in: fit)
        let above = handlePoint.y - side / 2 - 40 > 0
        let centre = CGPoint(x: min(max(handlePoint.x, side / 2 + Space.x2), size.width - side / 2 - Space.x2),
                             y: above ? handlePoint.y - side / 2 - 40 : handlePoint.y + side / 2 + 40)
        return ZStack {
            Image(decorative: image, scale: 1)
                .resizable()
                .interpolation(.high)
                .frame(width: imageSize.width * scale, height: imageSize.height * scale)
                .offset(x: side / 2 - pixel.x * scale - (imageSize.width * scale - side) / 2,
                        y: side / 2 - pixel.y * scale - (imageSize.height * scale - side) / 2)
            Path { path in
                path.move(to: CGPoint(x: side / 2, y: 0))
                path.addLine(to: CGPoint(x: side / 2, y: side))
                path.move(to: CGPoint(x: 0, y: side / 2))
                path.addLine(to: CGPoint(x: side, y: side / 2))
            }
            .stroke(Color.accentColor.opacity(0.9), lineWidth: 1)
        }
        .frame(width: side, height: side)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white, lineWidth: 2.5))
        .shadow(color: .black.opacity(0.35), radius: 8, y: 4)
        .position(centre)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .accessibilityIdentifier("crop.magnifier")
    }
}

/// The corners as a path on the screen; animatable, so the edges spring
/// from where they were to where they are found.
struct QuadShape: Shape {
    var quad: Quad
    var imageSize: CGSize
    var rect: CGRect

    var animatableData: AnimatablePair<AnimatablePair<CGPoint.AnimatableData, CGPoint.AnimatableData>,
                                       AnimatablePair<CGPoint.AnimatableData, CGPoint.AnimatableData>> {
        get {
            AnimatablePair(AnimatablePair(quad.topLeft.animatableData, quad.topRight.animatableData),
                           AnimatablePair(quad.bottomRight.animatableData, quad.bottomLeft.animatableData))
        }
        set {
            quad.topLeft.animatableData = newValue.first.first
            quad.topRight.animatableData = newValue.first.second
            quad.bottomRight.animatableData = newValue.second.first
            quad.bottomLeft.animatableData = newValue.second.second
        }
    }

    func path(in _: CGRect) -> Path {
        var path = Path()
        let points = quad.points.map { ScanGeometry.viewPoint($0, imageSize: imageSize, in: rect) }
        path.move(to: points[0])
        for point in points.dropFirst() { path.addLine(to: point) }
        path.closeSubpath()
        return path
    }
}

/// The dimming outside the corners: the photo's rectangle with the quad
/// cut out of it (filled even-odd), animatable with the corners.
struct DimmingShape: Shape {
    var quad: Quad
    var imageSize: CGSize
    var rect: CGRect

    var animatableData: QuadShape.AnimatableData {
        get { QuadShape(quad: quad, imageSize: imageSize, rect: rect).animatableData }
        set {
            var shape = QuadShape(quad: quad, imageSize: imageSize, rect: rect)
            shape.animatableData = newValue
            quad = shape.quad
        }
    }

    func path(in _: CGRect) -> Path {
        var path = Path(rect)
        path.addPath(QuadShape(quad: quad, imageSize: imageSize, rect: rect).path(in: rect))
        return path
    }
}

/// Where a picture sits on the screen and how its pixels map to points.
enum ScanGeometry {
    /// The picture fitted inside `bounds`, centred.
    static func fit(_ size: CGSize, in bounds: CGRect) -> CGRect {
        guard size.width > 0, size.height > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
        let scale = min(bounds.width / size.width, bounds.height / size.height)
        let fitted = CGSize(width: size.width * scale, height: size.height * scale)
        return CGRect(x: bounds.midX - fitted.width / 2, y: bounds.midY - fitted.height / 2, width: fitted.width, height: fitted.height)
    }

    static func viewPoint(_ pixel: CGPoint, imageSize: CGSize, in rect: CGRect) -> CGPoint {
        CGPoint(x: rect.minX + pixel.x / imageSize.width * rect.width, y: rect.minY + pixel.y / imageSize.height * rect.height)
    }

    static func pixelPoint(_ point: CGPoint, imageSize: CGSize, in rect: CGRect) -> CGPoint {
        CGPoint(x: (point.x - rect.minX) / rect.width * imageSize.width, y: (point.y - rect.minY) / rect.height * imageSize.height)
    }

    /// "12,34 80,30 82,120 10,118" — the corners, for tests and VoiceOver.
    static func describe(_ quad: Quad) -> String {
        quad.points.map { "\(Int($0.x.rounded())),\(Int($0.y.rounded()))" }.joined(separator: " ")
    }
}

/// The shutter: a large white disc in a ring, pressed with a shrink the
/// instant the finger lands. Where there is no camera it carries the photo
/// symbol, so it does not promise one.
struct ShutterButton: View {
    let cameraAvailable: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .stroke(Color.white.opacity(0.9), lineWidth: 4)
                    .frame(width: 84, height: 84)
                Circle()
                    .fill(Color.white)
                    .frame(width: 70, height: 70)
                if !cameraAvailable {
                    Image(systemName: "photo")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.black)
                }
            }
            .contentShape(Circle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel(cameraAvailable ? Text("Take a picture") : Text("Choose a photo"))
        .accessibilityIdentifier("scan.shutter")
    }
}

/// The pages captured so far, along the bottom: the newest springs in,
/// a drag moves one before another, the selected one is ringed, a long
/// press offers retake and delete.
struct PageStrip: View {
    @Bindable var session: ScanSession
    let onRetake: (UUID) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dropTarget: UUID?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: Space.x3) {
                    ForEach(Array(session.pages.enumerated()), id: \.element.id) { index, page in
                        thumbnail(page, index: index)
                            .id(page.id)
                            .transition(reduceMotion ? .opacity : .scale(scale: 0.4).combined(with: .opacity))
                    }
                    if !session.pages.isEmpty {
                        // Room to drop a page at the end.
                        Color.clear
                            .frame(width: 44, height: 80)
                            .dropDestination(for: String.self) { items, _ in
                                guard let raw = items.first, let id = UUID(uuidString: raw) else { return false }
                                session.move(id, before: nil)
                                return true
                            }
                    }
                }
                .padding(.horizontal, Space.x5)
                .padding(.vertical, Space.x3)
                .animation(Motion.flick, value: session.pages.map(\.id))
            }
            .scrollIndicators(.hidden)
            .frame(height: session.pages.isEmpty ? 0 : 100)
            .background(Color.black)
            .accessibilityIdentifier("scan.pages")
            .onChange(of: session.pages.count) { _, count in
                if let last = session.pages.last, count > 0 {
                    withAnimation(Motion.travel(reduceMotion: reduceMotion)) { proxy.scrollTo(last.id, anchor: .trailing) }
                }
            }
        }
    }

    private func thumbnail(_ page: ScanPage, index: Int) -> some View {
        let selected = session.selected?.id == page.id
        return Button {
            withAnimation(Motion.travel(reduceMotion: reduceMotion)) { session.selectedID = page.id }
        } label: {
            VStack(spacing: Space.x1) {
                ZStack(alignment: .topLeading) {
                    Image(decorative: page.display, scale: 1)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 58, height: 66)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                .stroke(selected ? Color.accentColor : Color.white.opacity(0.3), lineWidth: selected ? 2.5 : 0.5)
                        }
                    Text(index + 1, format: .number)
                        .font(.caption2.weight(.semibold))
                        .tabularNumbers()
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.thinMaterial, in: Capsule())
                        .padding(3)
                }
                if let side = page.side {
                    Text(side.title)
                        .font(.caption2)
                        .foregroundStyle(Color.white.opacity(0.7))
                        .lineLimit(1)
                }
            }
            .opacity(dropTarget == page.id ? 0.5 : 1)
        }
        .buttonStyle(.pressable)
        .draggable(page.id.uuidString)
        .dropDestination(for: String.self) { items, _ in
            guard let raw = items.first, let id = UUID(uuidString: raw), id != page.id else { return false }
            session.move(id, before: page.id)
            return true
        } isTargeted: { targeted in
            dropTarget = targeted ? page.id : nil
        }
        .contextMenu {
            Button("Retake", systemImage: "arrow.triangle.2.circlepath.camera") { onRetake(page.id) }
            if index > 0 {
                Button("Move left", systemImage: "arrow.left") { session.move(fromOffsets: IndexSet(integer: index), toOffset: index - 1) }
            }
            if index < session.pages.count - 1 {
                Button("Move right", systemImage: "arrow.right") { session.move(fromOffsets: IndexSet(integer: index), toOffset: index + 2) }
            }
            Button("Delete", systemImage: "trash", role: .destructive) { session.remove(page.id) }
        }
        .accessibilityLabel(Text("Page \(index + 1) of \(session.pages.count)"))
        .accessibilityIdentifier("scan.page.\(index)")
    }
}
