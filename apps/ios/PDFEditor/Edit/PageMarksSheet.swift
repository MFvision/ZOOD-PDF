import SwiftUI
import WarraqCore

/// Page marks: a watermark, a header, a footer, page numbers or Bates
/// numbers, on any pages, drawn by the core (`marks.add`) as a form XObject
/// tagged as a pagination artifact round the page's own streams — so it is
/// listed, replaced and taken off again leaving the page as it was, and the
/// page's own text never has it in.
///
/// The page above the form is the core's own drawing of the mark on the
/// current page (`marks.preview`), so what is chosen is what will be
/// written; the marks already on the file are listed under it, each with
/// what it says and where, and Remove takes one off.
struct PageMarksSheet: View {
    let model: DocumentModel
    let undoManager: UndoManager?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var form = MarkSpec.Form()
    @State private var marks: [PageMarkInfo] = []
    @State private var preview: UIImage?
    @State private var previewing = false
    @State private var working = false
    @State private var error: LocalizedStringKey?
    @State private var added = 0

    /// Which pages the form asks for, or nil when what was typed is not
    /// pages of this file.
    private var chosenPages: [Int]? {
        MarkSpec.pages(form.pages, count: model.pageCount)
    }

    var body: some View {
        NavigationStack {
            Form {
                previewSection
                Section {
                    Picker("Kind", selection: $form.kind) {
                        ForEach(MarkSpec.Kind.allCases) { kind in
                            Label { Text(kind.title) } icon: { Image(systemName: kind.symbol) }.tag(kind)
                        }
                    }
                    .accessibilityIdentifier("marks.kind")
                }
                switch form.kind {
                case .watermark: watermarkSection
                case .header, .footer: bandSection
                case .pageNumber: pageNumberSection
                case .bates: batesSection
                }
                placeSection
                pagesSection
                if !marks.isEmpty { listSection }
            }
            .navigationTitle("Page marks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("marks.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button("Add", action: add)
                            .disabled(!form.hasContent || chosenPages == nil)
                            .accessibilityIdentifier("marks.add")
                    }
                }
            }
            .alert("Could not add the mark", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
        }
        .presentationDetents([.large])
        .sensoryFeedback(.success, trigger: added)
        .task(id: model.revision) {
            await list()
        }
        .task(id: previewKey) {
            await drawPreview()
        }
        .onAppear {
            // An Arabic interface starts with Arabic-Indic digits and the
            // Hijri calendar, which is what those marks are read with here.
            if locale.language.languageCode?.identifier == "ar" {
                form.numerals = .arabic
                form.calendar = .hijri
            }
        }
    }

    // MARK: - The preview

    @ViewBuilder
    private var previewSection: some View {
        Section {
            ZStack {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(Surface.paper)
                if let preview {
                    Image(uiImage: preview)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                        .accessibilityIdentifier("marks.preview")
                } else if previewing {
                    ProgressView()
                } else {
                    Image(systemName: "doc")
                        .font(.system(size: 30, weight: .light))
                        .foregroundStyle(Surface.tertiaryLabel)
                }
            }
            .frame(height: 220)
            .frame(maxWidth: .infinity)
            .listRowBackground(Surface.underPage)
        } footer: {
            Text("Page \(model.currentPage + 1) of \(model.pageCount), as the mark will be drawn on it.")
        }
    }

    /// What the preview must be drawn again for.
    private var previewKey: String {
        "\(model.revision)|\(model.currentPage)|\(form)"
    }

    private func drawPreview() async {
        guard form.hasContent, let font = form.font.bytes else {
            preview = nil
            return
        }
        previewing = true
        defer { previewing = false }
        struct Args: Encodable {
            let password: String?
            let mark: [String: JSONValue]
            let page: Int
            let scale: Float
            let fontBlob = 1
        }
        let args = Args(password: model.password,
                        mark: MarkSpec.spec(of: form, fileName: model.name, now: Date(), locale: locale),
                        page: model.currentPage, scale: 1)
        do {
            let reply = try await Core.callStatic(op: "marks.preview", args: args, blobs: [model.bytes, font])
            struct Size: Decodable { let width: Int; let height: Int }
            let size: Size = try reply.decode()
            guard let rgba = reply.blobs.first else { throw CoreError.badReply("marks.preview answered no pixels") }
            preview = UIImage.from(rgba: rgba, width: size.width, height: size.height)
        } catch {
            // A preview that cannot be drawn is not worth an alert: Add says
            // what went wrong if it goes wrong there too.
            preview = nil
        }
    }

    // MARK: - The form, by kind

    @ViewBuilder
    private var watermarkSection: some View {
        Section("Watermark") {
            TextField("What it says", text: $form.watermarkText, axis: .vertical)
                .accessibilityIdentifier("marks.watermark.text")
            LabeledContent("Size") {
                Stepper(value: $form.watermarkSize, in: 8...200, step: 4) {
                    Text(Int(form.watermarkSize), format: .number).tabularNumbers()
                }
                .accessibilityIdentifier("marks.watermark.size")
            }
            LabeledContent("Turn") {
                Stepper(value: $form.rotation, in: -90...90, step: 5) {
                    Text("\(Int(form.rotation))°").tabularNumbers()
                }
                .accessibilityIdentifier("marks.watermark.rotation")
            }
            VStack(alignment: .leading) {
                Text("How solid")
                Slider(value: $form.opacity, in: 5...100, step: 5)
                    .accessibilityIdentifier("marks.watermark.opacity")
            }
            Toggle("In front of the page", isOn: $form.front)
                .accessibilityIdentifier("marks.watermark.front")
        }
    }

    @ViewBuilder
    private var bandSection: some View {
        Section(form.kind == .header ? "Header" : "Footer") {
            TextField("Start", text: slot(0))
                .accessibilityIdentifier("marks.band.start")
            TextField("Centre", text: slot(1))
                .accessibilityIdentifier("marks.band.center")
            TextField("End", text: slot(2))
                .accessibilityIdentifier("marks.band.end")
            Picker("Calendar", selection: $form.calendar) {
                ForEach(MarkSpec.Calendar.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("marks.band.calendar")
        } footer: {
            Text("“Start” is the right-hand side in Arabic. {page}, {pages}, {date} and {file} are filled in page by page.")
        }
        Section("Put in") {
            // Each token goes into whichever slot was last typed in; the
            // first is the one a person fills most often.
            HStack {
                ForEach(MarkSpec.tokens, id: \.self) { token in
                    Button {
                        form.slots[lastSlot] += token
                    } label: {
                        Text(verbatim: token)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("marks.token.\(token.dropFirst().dropLast())")
                }
            }
        }
    }

    @State private var lastSlot = 0

    private func slot(_ index: Int) -> Binding<String> {
        Binding(get: { form.slots[index] }, set: { form.slots[index] = $0; lastSlot = index })
    }

    @ViewBuilder
    private var pageNumberSection: some View {
        Section("Page number") {
            Picker("How it reads", selection: $form.numberFormat) {
                ForEach(MarkSpec.NumberFormat.allCases) { item in
                    Text(verbatim: sample(item)).tag(item)
                }
            }
            .accessibilityIdentifier("marks.number.format")
            LabeledContent("Start at") {
                Stepper(value: $form.startNumber, in: 0...9999) {
                    Text(MarkSpec.inDigits(form.startNumber, form.numerals)).tabularNumbers()
                }
                .accessibilityIdentifier("marks.number.start")
            }
            Toggle("Not on the first page", isOn: $form.skipFirst)
                .accessibilityIdentifier("marks.number.skipFirst")
        }
    }

    /// What a format looks like, in the digits the mark will draw.
    private func sample(_ format: MarkSpec.NumberFormat) -> String {
        let page = MarkSpec.inDigits(form.startNumber, form.numerals)
        let pages = MarkSpec.inDigits(form.startNumber + max(0, model.pageCount - (form.skipFirst ? 1 : 0)) - 1, form.numerals)
        switch format {
        case .plain: return page
        case .ofTotal: return "\(page) / \(pages)"
        case .pageOfEnglish: return "Page \(page) of \(pages)"
        case .pageOfArabic: return "صفحة \(page) من \(pages)"
        case .roman: return "I, II, III"
        }
    }

    @ViewBuilder
    private var batesSection: some View {
        Section("Bates number") {
            TextField("Before", text: $form.batesPrefix)
                .accessibilityIdentifier("marks.bates.prefix")
            TextField("After", text: $form.batesSuffix)
                .accessibilityIdentifier("marks.bates.suffix")
            LabeledContent("Start at") {
                Stepper(value: $form.batesStart, in: 0...999_999) {
                    Text(form.batesStart, format: .number).tabularNumbers()
                }
                .accessibilityIdentifier("marks.bates.start")
            }
            LabeledContent("Digits") {
                Stepper(value: $form.batesDigits, in: 1...20) {
                    Text(form.batesDigits, format: .number).tabularNumbers()
                }
                .accessibilityIdentifier("marks.bates.digits")
            }
        } footer: {
            Text(verbatim: MarkSpec.batesSample(form))
        }
    }

    @ViewBuilder
    private var placeSection: some View {
        Section("Place") {
            Picker("Position", selection: positionBinding) {
                ForEach(positions) { item in
                    Text(item.title).tag(item)
                }
            }
            .accessibilityIdentifier("marks.position")
            if form.kind != .watermark {
                LabeledContent("Size") {
                    Stepper(value: $form.size, in: 6...48, step: 1) {
                        Text(Int(form.size), format: .number).tabularNumbers()
                    }
                    .accessibilityIdentifier("marks.size")
                }
            }
            LabeledContent("Margin") {
                Stepper(value: $form.margin, in: 0...144, step: 4) {
                    Text(Int(form.margin), format: .number).tabularNumbers()
                }
                .accessibilityIdentifier("marks.margin")
            }
            Picker("Digits", selection: $form.numerals) {
                ForEach(MarkSpec.Numerals.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("marks.numerals")
            Picker("Colour", selection: colorBinding) {
                ForEach([MarkupColor.red, .blue, .green, .black]) { item in
                    Text(item.title).tag(item)
                }
            }
            .accessibilityIdentifier("marks.color")
            Picker("Font", selection: $form.font) {
                ForEach(EditFace.allCases) { face in
                    Text(verbatim: face.name).tag(face)
                }
            }
            .accessibilityIdentifier("marks.font")
        }
    }

    /// A header or a footer sits where its kind says; the others are placed.
    private var positions: [MarkSpec.Position] {
        form.kind == .watermark
            ? MarkSpec.Position.allCases
            : MarkSpec.Position.allCases.filter { $0 != .tiled }
    }

    private var positionBinding: Binding<MarkSpec.Position> {
        switch form.kind {
        case .watermark: $form.watermarkPosition
        case .bates: $form.batesPosition
        default: $form.numberPosition
        }
    }

    /// The colour as one of the app's four, which is what the bar and the
    /// stamps offer too; the core takes any `#rrggbb`.
    private var colorBinding: Binding<MarkupColor> {
        Binding(
            get: { [MarkupColor.red, .blue, .green, .black].first { $0.hex == form.color } ?? .red },
            set: { form.color = $0.hex })
    }

    @ViewBuilder
    private var pagesSection: some View {
        Section("Pages") {
            TextField("Every page", text: $form.pages)
                .autocorrectionDisabled()
                .accessibilityIdentifier("marks.pages")
            if let pages = chosenPages {
                Text(pages.isEmpty ? "Every page" : "Pages \(MarkSpec.pagesLabel(pages))")
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
                    .accessibilityIdentifier("marks.pages.summary")
            } else {
                Text("That is not a range of this document's pages.")
                    .font(TextStyle.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("marks.pages.error")
            }
        }
    }

    // MARK: - The marks on the file

    @ViewBuilder
    private var listSection: some View {
        Section("On this document") {
            ForEach(marks) { mark in
                HStack {
                    VStack(alignment: .leading, spacing: Space.x1) {
                        Text(mark.title)
                            .font(TextStyle.callout)
                        Text(mark.detail(of: model.pageCount))
                            .font(TextStyle.caption)
                            .foregroundStyle(Surface.secondaryLabel)
                    }
                    Spacer()
                    Button("Remove", systemImage: "trash") {
                        remove(mark)
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .disabled(working)
                    .accessibilityIdentifier("marks.remove.\(mark.id)")
                }
                .accessibilityIdentifier("marks.item.\(mark.id)")
            }
        }
    }

    private func list() async {
        struct Args: Encodable { let password: String? }
        struct Answer: Decodable { let marks: [PageMarkInfo] }
        do {
            let reply = try await Core.callStatic(op: "marks.list", args: Args(password: model.password), blobs: [model.bytes])
            marks = try reply.decode(Answer.self).marks
        } catch {
            marks = []
        }
    }

    // MARK: - Writing

    private func add() {
        guard let font = form.font.bytes else {
            error = "The bundled font is missing."
            return
        }
        guard let pages = chosenPages else { return }
        struct Args: Encodable {
            let password: String?
            let mark: [String: JSONValue]
            let pages: [Int]
            let replace = false
            let fontBlob = 1
        }
        let args = Args(password: model.password,
                        mark: MarkSpec.spec(of: form, fileName: model.name, now: Date(), locale: locale),
                        pages: pages)
        working = true
        Task {
            do {
                let reply = try await Core.callStatic(op: "marks.add", args: args, blobs: [model.bytes, font])
                guard let bytes = reply.blobs.first else { throw CoreError.badReply("marks.add answered no bytes") }
                try await model.replace(bytes: bytes, undoManager: undoManager)
                added += 1
                await list()
            } catch {
                self.error = PagesModel.describe(error)
            }
            working = false
        }
    }

    private func remove(_ mark: PageMarkInfo) {
        struct Args: Encodable { let password: String?; let ids: [Int] }
        working = true
        Task {
            do {
                let reply = try await Core.callStatic(op: "marks.remove", args: Args(password: model.password, ids: [mark.id]), blobs: [model.bytes])
                guard let bytes = reply.blobs.first else { throw CoreError.badReply("marks.remove answered no bytes") }
                try await model.replace(bytes: bytes, undoManager: undoManager)
                await list()
            } catch {
                self.error = PagesModel.describe(error)
            }
            working = false
        }
    }
}

/// A mark on the file, as `marks.list` answers it: its id, its kind, what
/// it was made with and which pages it is on.
struct PageMarkInfo: Decodable, Identifiable, Equatable, Sendable {
    let id: Int
    let kind: String
    let front: Bool
    let pages: [Int]
    /// What it says, from the settings it was made with.
    let text: String?
    let position: String?

    private enum CodingKeys: String, CodingKey {
        case id, kind, front, pages, spec
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        kind = try container.decode(String.self, forKey: .kind)
        front = (try? container.decode(Bool.self, forKey: .front)) ?? true
        pages = (try? container.decode([Int].self, forKey: .pages)) ?? []
        // The settings are the interface's own; only two of them are shown.
        let spec = try? container.decode(Spec.self, forKey: .spec)
        text = spec?.text ?? spec?.slots?.first { !$0.isEmpty }
        position = spec?.position
    }

    private struct Spec: Decodable {
        let text: String?
        let slots: [String]?
        let position: String?
    }

    var title: Text {
        let kindName: LocalizedStringResource = MarkSpec.Kind(rawValue: kind)?.title ?? "Watermark"
        if let text, !text.isEmpty {
            return Text(kindName) + Text(verbatim: " — ") + Text(verbatim: text)
        }
        return Text(kindName)
    }

    /// Which pages it is on, and where it sits.
    func detail(of count: Int) -> Text {
        let where_ = position.flatMap { MarkSpec.Position(rawValue: $0) }
        let place = where_.map { Text($0.title) } ?? Text(verbatim: "")
        let onPages = pages.isEmpty || pages.count == count
            ? Text("Every page")
            : Text("Pages \(MarkSpec.pagesLabel(pages))")
        return place + Text(verbatim: " · ") + onPages
    }
}

extension UIImage {
    /// A picture from the core's RGBA8 pixels, premultiplied over white.
    static func from(rgba: Data, width: Int, height: Int) -> UIImage? {
        guard width > 0, height > 0, rgba.count == width * height * 4 else { return nil }
        guard let provider = CGDataProvider(data: rgba as CFData) else { return nil }
        guard let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                                 bytesPerRow: width * 4,
                                 space: CGColorSpaceCreateDeviceRGB(),
                                 bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                 provider: provider, decode: nil, shouldInterpolate: true,
                                 intent: .defaultIntent) else { return nil }
        return UIImage(cgImage: image)
    }
}
