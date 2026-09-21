import SwiftUI
import WarraqCore

/// The stamps: the usual words in Arabic and English. Each is written on
/// the page by the core as a page mark (`marks.add`) — shaped Arabic in
/// the bundled face, an incremental update — so it reads back as text.
struct Stamp: Identifiable, Hashable {
    let id: String
    let arabic: String
    let english: String

    static let all: [Stamp] = [
        Stamp(id: "approved", arabic: "معتمد", english: "APPROVED"),
        Stamp(id: "draft", arabic: "مسودة", english: "DRAFT"),
        Stamp(id: "confidential", arabic: "سري", english: "CONFIDENTIAL"),
        Stamp(id: "final", arabic: "نهائي", english: "FINAL"),
        Stamp(id: "reviewed", arabic: "تمت المراجعة", english: "REVIEWED"),
        Stamp(id: "received", arabic: "تم الاستلام", english: "RECEIVED"),
        Stamp(id: "paid", arabic: "مدفوع", english: "PAID"),
        Stamp(id: "rejected", arabic: "مرفوض", english: "REJECTED"),
        Stamp(id: "copy", arabic: "نسخة", english: "COPY"),
        Stamp(id: "void", arabic: "ملغى", english: "VOID"),
    ]
}

/// Where a stamp sits on the page.
enum StampPosition: String, CaseIterable, Identifiable {
    case topLeft, top, topRight, left, center, right, bottomLeft, bottom, bottomRight

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .topLeft: "Top left"
        case .top: "Top"
        case .topRight: "Top right"
        case .left: "Left"
        case .center: "Centre"
        case .right: "Right"
        case .bottomLeft: "Bottom left"
        case .bottom: "Bottom"
        case .bottomRight: "Bottom right"
        }
    }
}

/// Choose a stamp, its language, colour, place and pages; Add writes it.
struct StampSheet: View {
    let model: DocumentModel
    let undoManager: UndoManager?
    let onDone: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var stamp = Stamp.all[0]
    @State private var arabic = true
    @State private var position: StampPosition = .topRight
    @State private var color: MarkupColor = .red
    @State private var allPages = false
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Stamp") {
                    Picker("Language", selection: $arabic) {
                        Text("العربية").tag(true)
                        Text("English").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("stamp.language")
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: Space.x3)], spacing: Space.x3) {
                        ForEach(Stamp.all) { item in
                            Button {
                                stamp = item
                            } label: {
                                Text(arabic ? item.arabic : item.english)
                                    .font(TextStyle.headline)
                                    .foregroundStyle(color.color)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, Space.x3)
                                    .overlay {
                                        RoundedRectangle(cornerRadius: Radius.button, style: .continuous)
                                            .strokeBorder(stamp == item ? Color.accentColor : color.color.opacity(0.6), lineWidth: stamp == item ? 3 : 1.5)
                                    }
                                    .background(stamp == item ? Color.accentColor.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                            }
                            .buttonStyle(.pressable)
                            .accessibilityAddTraits(stamp == item ? .isSelected : [])
                            .accessibilityIdentifier("stamp.\(item.id)")
                        }
                    }
                    .padding(.vertical, Space.x2)
                }
                Section("Place") {
                    Picker("Position", selection: $position) {
                        ForEach(StampPosition.allCases) { item in
                            Text(item.title).tag(item)
                        }
                    }
                    .accessibilityIdentifier("stamp.position")
                    Picker("Colour", selection: $color) {
                        ForEach([MarkupColor.red, .blue, .green, .black]) { item in
                            Text(item.title).tag(item)
                        }
                    }
                    .accessibilityIdentifier("stamp.color")
                    Toggle("Every page", isOn: $allPages)
                        .accessibilityIdentifier("stamp.allPages")
                }
            }
            .navigationTitle("Add stamp")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button("Add", action: add)
                            .accessibilityIdentifier("stamp.add")
                    }
                }
            }
            .alert("Could not add the stamp", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
        }
        .presentationDetents([.large])
        .onAppear {
            arabic = locale.language.languageCode?.identifier == "ar"
        }
    }

    private func add() {
        working = true
        let text = arabic ? stamp.arabic : stamp.english
        let pages = allPages ? [] : [model.currentPage]
        Task {
            do {
                try await Self.add(text: text, position: position, color: color, pages: pages, to: model, undoManager: undoManager)
                onDone()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            working = false
        }
    }

    /// Writes the stamp through the core: a watermark-kind page mark in
    /// front of the content, sized for a stamp, in the bundled Arabic face.
    static func add(text: String, position: StampPosition, color: MarkupColor, pages: [Int], to model: DocumentModel, undoManager: UndoManager?) async throws {
        guard let font = AppFonts.arabic else { throw CoreError.font("the bundled font is missing") }
        struct Mark: Encodable {
            let kind = "watermark"
            let text: String
            let position: String
            let size: Float
            let color: String
            let opacity: Float
            let rotation: Float
            let front = true
            let direction = "auto"
            let marginX: Float
            let marginY: Float
        }
        struct Args: Encodable {
            let password: String?
            let mark: Mark
            let pages: [Int]
            let replace = false
            let fontBlob = 1
        }
        let mark = Mark(text: text, position: position.rawValue, size: 28, color: color.hex, opacity: 0.85,
                        rotation: position == .center ? 30 : 0, marginX: 36, marginY: 36)
        let reply = try await Core.callStatic(op: "marks.add", args: Args(password: model.password, mark: mark, pages: pages), blobs: [model.bytes, font])
        guard let bytes = reply.blobs.first else { throw CoreError.badReply("marks.add answered no bytes") }
        try await model.replace(bytes: bytes, undoManager: undoManager)
    }
}
