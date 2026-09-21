import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The scanner: the page on the stage with its edges found, the mode across
/// the top, the pages captured so far stacked along the bottom (drag to
/// reorder, retake, delete), and the shutter. Where there is a camera the
/// shutter opens VisionKit's document camera; where there is none (the
/// simulator) the shutter says so and takes photos from the library
/// instead; Files and Photos are always there. Save makes the PDF with its
/// text layer and hands it back to the Library.
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
    @State private var editingCorners: CornerTarget?
    @State private var showingEnhance = false
    @State private var showingText = false
    @State private var showingSave = false
    @State private var retaking: UUID?
    @State private var captures = 0
    @State private var liveText = false
    @State private var loadedLaunchArguments = false

    struct CornerTarget: Identifiable {
        let id: UUID
    }

    init(mode: ScanMode = .document, documentsFolder: URL? = nil, onSaved: @escaping (URL) -> Void) {
        let folder = documentsFolder ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        _session = State(initialValue: ScanSession(mode: mode, documentsFolder: folder))
        self.onSaved = onSaved
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                modePicker
                stage
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                actions
                PageStrip(session: session, onRetake: { id in
                    retaking = id
                    showingPhotos = true
                }, onCrop: { id in
                    editingCorners = CornerTarget(id: id)
                })
                shutterBar
            }
            .background(Surface.underPage)
            .navigationTitle("Scan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
        .onAppear(perform: applyStoredSettings)
        .task { loadLaunchArguments() }
        .fullScreenCover(isPresented: $showingCamera) {
            DocumentCameraView { images in
                showingCamera = false
                take(images)
            } onCancel: {
                showingCamera = false
            } onError: { message in
                showingCamera = false
                session.error = message
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
        .fullScreenCover(item: $editingCorners) { target in
            if let page = session.page(target.id) {
                CornerEditor(image: page.original, quad: page.quad) { quad in
                    session.setQuad(quad, for: target.id)
                    editingCorners = nil
                } onCancel: {
                    editingCorners = nil
                } onAuto: {
                    let image = page.original
                    return await Task.detached { ScanPipeline.detectPage(in: image) }.value
                }
            }
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
    }

    // MARK: - Pieces

    private var modePicker: some View {
        Picker("Mode", selection: $session.mode) {
            ForEach(ScanMode.allCases) { mode in
                Text(mode.title).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, Space.x5)
        .padding(.vertical, Space.x3)
        .accessibilityIdentifier("scan.mode")
    }

    @ViewBuilder
    private var stage: some View {
        if session.mode.composesOnePage, let composed = session.composedPage {
            ScanStage(image: composed, quad: nil, label: composedLabel, processing: session.isProcessing, liveText: liveText)
                .padding(Space.x5)
        } else if let page = session.selected {
            ScanStage(image: session.previewOriginal ? (page.corrected ?? page.original) : page.display,
                      quad: page.enhanced == nil && page.corrected == nil ? page.quad : nil,
                      label: pageLabel(page), processing: page.isProcessing, liveText: liveText)
                .padding(Space.x5)
        } else {
            EmptyState(symbol: session.mode.symbol, title: emptyTitle, message: emptyMessage)
                .accessibilityIdentifier("scan.empty")
        }
    }

    private var composedLabel: Text {
        switch session.mode {
        case .idCard: Text("Front and back on one page, at card size")
        case .passport: Text("Passport page at real size")
        default: Text("")
        }
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
        case .idCard: "Scan the front, then the back"
        case .passport: "Scan the passport's page"
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
            Button("Corners", systemImage: "crop") {
                if let page = session.selected { editingCorners = CornerTarget(id: page.id) }
            }
            .accessibilityIdentifier("scan.crop")
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
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .disabled(session.pages.isEmpty)
        .padding(.horizontal, Space.x5)
        .padding(.bottom, Space.x3)
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
            .padding(.horizontal, Space.x7)
            Text(DocumentCameraView.isSupported ? "Camera" : "No camera on this device — the shutter chooses a photo")
                .font(TextStyle.caption)
                .foregroundStyle(Surface.secondaryLabel)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("scan.shutterCaption")
        }
        .padding(.top, Space.x4)
        .padding(.bottom, Space.x5)
        .background(.bar)
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
                await session.add(images: images)
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
            session.error = String(localized: "None of the chosen pictures could be read.")
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
            session.error = String(localized: "None of the chosen pictures could be read.")
            retaking = nil
            return
        }
        take(images)
    }

    /// A UI test, or a run from the command line: `-warraqScan <path>[,<path>…]`
    /// takes those photos in as if chosen, `-warraqScanMode idCard|passport|book`
    /// picks the mode.
    private func loadLaunchArguments() {
        #if DEBUG
        guard !loadedLaunchArguments else { return }
        loadedLaunchArguments = true
        let defaults = UserDefaults.standard
        if let mode = defaults.string(forKey: "warraqScanMode").flatMap(ScanMode.init(rawValue:)) {
            session.mode = mode
        }
        guard let list = defaults.string(forKey: "warraqScan"), !list.isEmpty else { return }
        let urls = list.split(separator: ",").map { URL(filePath: String($0)) }
        Task { await load(urls) }
        #endif
    }
}

/// The page on the stage: the picture, and over it the edges Vision found
/// while the page is still being cut out — they spring into place the
/// moment detection answers, and go with the picture once it is cut.
struct ScanStage: View {
    let image: CGImage
    let quad: Quad?
    let label: Text
    let processing: Bool
    let liveText: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            let size = CGSize(width: image.width, height: image.height)
            let fit = ScanGeometry.fit(size, in: CGRect(origin: .zero, size: geometry.size))
            ZStack {
                Depth.page(
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
                )
                if let quad {
                    QuadShape(quad: quad, imageSize: size, rect: fit)
                        .fill(Color.accentColor.opacity(0.14))
                    QuadShape(quad: quad, imageSize: size, rect: fit)
                        .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2.5, lineJoin: .round))
                    ForEach(0..<4, id: \.self) { corner in
                        let point = ScanGeometry.viewPoint(quad[corner], imageSize: size, in: fit)
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 10, height: 10)
                            .position(point)
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
            .animation(Motion.travel(reduceMotion: reduceMotion), value: quad)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(quad.map { Text(verbatim: ScanGeometry.describe($0)) } ?? Text("cut out"))
        .accessibilityIdentifier("scan.stage")
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

/// The shutter: a ring around a white disc, pressed with a shrink the
/// instant the finger lands. Where there is no camera it carries the photo
/// symbol, so it does not promise one.
struct ShutterButton: View {
    let cameraAvailable: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .stroke(Surface.label.opacity(0.85), lineWidth: 4)
                    .frame(width: 76, height: 76)
                Circle()
                    .fill(Surface.label)
                    .frame(width: 62, height: 62)
                if !cameraAvailable {
                    Image(systemName: "photo")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Surface.window)
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
/// press offers retake, corners and delete.
struct PageStrip: View {
    @Bindable var session: ScanSession
    let onRetake: (UUID) -> Void
    let onCrop: (UUID) -> Void
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
            .frame(height: 100)
            .background(Surface.window)
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
                                .stroke(selected ? Color.accentColor : Surface.separator, lineWidth: selected ? 2.5 : 0.5)
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
                        .foregroundStyle(Surface.secondaryLabel)
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
            Button("Corners", systemImage: "crop") { onCrop(page.id) }
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
