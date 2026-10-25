import Observation
import SwiftUI

/// Ask ZOOD on the iPhone, as the desktop's chat has it: type (or dictate
/// with the keyboard's microphone) and ZOOD either does it — a command from
/// its book: scan, open a file, search, combine, convert, sort, the cloud
/// drives, make a presentation — or answers, with the on-device model.
/// Commands never need the model; answers never leave the phone.
@MainActor @Observable
final class AskZoodChat {
    struct Message: Identifiable, Equatable {
        enum Role { case person, zood }
        let id = UUID()
        let role: Role
        var text: String
        /// A file ZOOD made (a presentation), to share.
        var file: URL?
    }

    private(set) var messages: [Message] = []
    private(set) var working = false
    var draft = ""
    private(set) var engine: (any AIEngine)?
    private(set) var availability: AIAvailability

    init() {
        let found = AIEngines.current()
        engine = found.engine
        availability = found.availability
    }

    func refreshEngine() {
        let found = AIEngines.current()
        engine = found.engine
        availability = found.availability
    }

    static let instructions = """
    You are ZOOD, the assistant inside ZOOD PDF, a PDF editor, running entirely on this iPhone. Answer briefly and \
    helpfully, in the language the person writes in (Arabic gets an Arabic answer, English an English one). You can \
    explain how to do things in ZOOD PDF: scan paper, edit text, sign, fill forms, combine, compress, convert to \
    Word, Excel, PowerPoint, JPG or WebP, protect with a password, summarize a PDF (open it and tap AI), sort files, \
    open files from OneDrive or Google Drive. Never claim to have done something you did not do. Never invent \
    facts, numbers or names; say when you do not know.
    """

    /// Handles what the person sent: a command when the book has one, an answer otherwise.
    func send(library: LibraryModel, run: (LibraryTool) -> Void, close: () -> Void) async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !working else { return }
        draft = ""
        messages.append(Message(role: .person, text: text))
        if let command = CommandBook.match(text) {
            await perform(command, said: text, library: library, run: run, close: close)
            return
        }
        await answer(text)
    }

    private func say(_ text: String, file: URL? = nil) {
        messages.append(Message(role: .zood, text: text, file: file))
    }

    private func perform(_ command: CommandBook.Command, said: String, library: LibraryModel, run: (LibraryTool) -> Void, close: () -> Void) async {
        let arabic = readsArabic(said)
        switch command {
        case let .tool(tool):
            say(arabic ? "تمام، أفتح \(String(localized: String.LocalizationValue(tool.titleKey)))." : "Opening \(tool.titleKey).")
            try? await Task.sleep(for: .milliseconds(450))
            run(tool)
        case .summarizeLast:
            say(arabic ? "أفتح آخر مستند وألخصه." : "Opening your last document to summarize it.")
            try? await Task.sleep(for: .milliseconds(450))
            close()
            library.handle(.askZood)
        case let .open(name):
            if let match = CommandBook.bestDocument(named: name, in: library.documents) {
                say(arabic ? "أفتح «\(match.name)»." : "Opening “\(match.name)”.")
                try? await Task.sleep(for: .milliseconds(450))
                close()
                library.open(match)
            } else {
                say(arabic ? "ما لقيت ملف بهذا الاسم في ملفاتي. جرّب البحث داخل المستندات." : "I couldn't find a file with that name in My files. Try searching inside the documents.")
            }
        case let .search(query):
            say(arabic ? "أبحث عن «\(query)» داخل كل المستندات." : "Searching every document for “\(query)”.")
            try? await Task.sleep(for: .milliseconds(450))
            close()
            library.requestedSearch = query
        case .presentation:
            await makeDeck(topic: DeckMaker.topic(said))
        }
    }

    private func answer(_ text: String) async {
        guard let engine else {
            say(availability == .deviceTooSmall
                ? String(localized: "This iPhone has too little memory for ZOOD's AI, but every command still works: try “scan”, “open …”, “compress” or “convert to Word”.")
                : String(localized: "To answer questions, ZOOD's AI needs to be on this iPhone first. Get it above (once, 1.1 GB). Commands like “scan” or “convert to Word” work already."))
            return
        }
        working = true
        defer { working = false }
        // The last turns, so a follow-up question makes sense.
        let history = messages.dropLast().suffix(6).map { ($0.role == .person ? "Person: " : "ZOOD: ") + $0.text }.joined(separator: "\n")
        let prompt = history.isEmpty ? text : "\(history)\nPerson: \(text)"
        messages.append(Message(role: .zood, text: ""))
        let index = messages.count - 1
        do {
            let reply = try await engine.reply(instructions: Self.instructions, prompt: prompt) { partial in
                Task { @MainActor [weak self] in
                    guard let self, self.messages.indices.contains(index), self.working else { return }
                    self.messages[index].text = partial
                }
            }
            messages[index].text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            messages[index].text = error.localizedDescription
        }
    }

    private func makeDeck(topic: String) async {
        guard let engine else {
            say(String(localized: "Making a presentation needs ZOOD's AI on this iPhone. Get it above, once."))
            return
        }
        working = true
        defer { working = false }
        let arabic = readsArabic(topic)
        say(arabic ? "أكتب الشرائح عن «\(topic)»…" : "Writing the slides about “\(topic)”…")
        let index = messages.count - 1
        do {
            let deck = try await DeckMaker.write(topic: topic, document: nil, engine: engine)
            let file = try DeckMaker.file(deck)
            messages[index].text = arabic
                ? "جاهز: «\(deck.title)»، \(deck.slides.count + 1) شرائح. شاركه أو افتحه في PowerPoint أو Keynote. تأكد من الأرقام والتواريخ قبل العرض."
                : "Ready: “\(deck.title)”, \(deck.slides.count + 1) slides. Share it or open it in PowerPoint or Keynote. Check any numbers and dates before you present."
            messages[index].file = file
        } catch {
            messages[index].text = error.localizedDescription
        }
    }
}

/// The commands typed words map to, in Arabic and English. A fixed book,
/// checked before any model: "compress" always means Compress.
enum CommandBook {
    enum Command: Equatable {
        case tool(LibraryTool)
        case summarizeLast
        case open(String)
        case search(String)
        case presentation
    }

    /// Lowercased, without Arabic's diacritics and with its letter variants folded.
    static func normalize(_ text: String) -> String {
        var s = text.lowercased()
        s = s.unicodeScalars.filter { !(0x064B...0x065F).contains($0.value) && $0.value != 0x0640 }.map(String.init).joined()
        for (from, to) in [("أ", "ا"), ("إ", "ا"), ("آ", "ا"), ("ى", "ي"), ("ة", "ه")] { s = s.replacingOccurrences(of: from, with: to) }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func has(_ said: String, _ words: [String]) -> Bool {
        words.contains { said.contains(normalize($0)) }
    }

    private static func after(_ said: String, _ words: [String]) -> String? {
        for word in words {
            let w = normalize(word)
            if said.hasPrefix(w + " ") {
                return String(said.dropFirst(w.count + 1)).trimmingCharacters(in: CharacterSet(charactersIn: " .!?؟\"«»“”"))
            }
        }
        return nil
    }

    static func match(_ text: String) -> Command? {
        let said = normalize(text)
        if DeckMaker.asked(text) { return .presentation }
        if let query = after(said, ["search for", "search", "find", "look for", "ابحث عن", "ابحث", "دور على", "دور"]), !query.isEmpty {
            return .search(query)
        }
        if let name = after(said, ["open", "افتح", "افتحلي", "افتح لي"]), !name.isEmpty,
           !has(name, ["onedrive", "google drive", "ون درايف", "قوقل درايف", "جوجل درايف", "settings", "الاعدادات"]) {
            return .open(name)
        }
        if has(said, ["summarize", "summary", "لخص", "ملخص", "تلخيص"]), has(said, ["last", "recent", "اخر", "الاخير"]) {
            return .summarizeLast
        }
        // Questions are for the model even when they name a tool ("how do I compress?").
        if has(said, ["how", "what", "why", "can i", "كيف", "ليش", "لماذا", "وش", "ايش", "هل"]) { return nil }
        let table: [(LibraryTool, [String])] = [
            (.scan, ["scan", "camera", "امسح", "مسح ضوئي", "صور مستند", "سكان", "سكانر"]),
            (.combine, ["combine", "merge", "join", "ادمج", "دمج", "اجمع"]),
            (.quickTools, ["compress", "smaller", "convert", "to word", "to excel", "to powerpoint", "to jpg", "to webp", "split", "unlock", "watermark", "page numbers", "rotate",
                           "اضغط", "ضغط", "صغر", "حول", "تحويل", "قسم", "تقسيم", "افصل", "فك القفل", "علامه مائيه", "ترقيم", "تدوير"]),
            (.sort, ["sort", "organize", "organise", "tidy", "رتب", "نظم", "ترتيب", "تنظيم"]),
            (.cloud, ["onedrive", "one drive", "google drive", "cloud", "ون درايف", "قوقل درايف", "جوجل درايف", "السحابه"]),
            (.batch, ["batch", "many files", "دفعه", "ملفات كثيره"]),
            (.help, ["help", "support", "report a problem", "مساعده", "دعم", "مشكله"]),
            (.create, ["photos to pdf", "pictures to pdf", "صور الى pdf", "من الصور"]),
        ]
        for (tool, words) in table where has(said, words) { return .tool(tool) }
        return nil
    }

    /// The document whose name is closest to what was said, if any is close.
    static func bestDocument(named name: String, in documents: [LocalDocument]) -> LocalDocument? {
        let wanted = normalize(name)
        guard !wanted.isEmpty else { return nil }
        let words = wanted.split(separator: " ").map(String.init)
        let scored = documents.map { document -> (LocalDocument, Int) in
            let own = normalize(document.name)
            if own == wanted { return (document, 100) }
            var score = own.contains(wanted) ? 60 : 0
            score += words.filter { own.contains($0) }.count * 10
            return (document, score)
        }
        guard let best = scored.max(by: { $0.1 < $1.1 }), best.1 >= 10 else { return nil }
        return best.0
    }
}

extension LibraryTool {
    /// The tool's title as a catalog key, for sentences that name it.
    var titleKey: String {
        switch self {
        case .askZood: "Ask ZOOD"
        case .scan: "Scan"
        case .create: "Create a PDF"
        case .combine: "Combine files"
        case .quickTools: "Quick tools"
        case .sort: "Sort with ZOOD"
        case .cloud: "Cloud drives"
        case .search: "Search"
        case .batch: "Batch"
        case .help: "Help & Support"
        }
    }
}

/// The chat screen.
struct AskZoodView: View {
    let library: LibraryModel
    /// Runs a tool of the Library (closes this screen first).
    let run: (LibraryTool) -> Void
    @State private var chat = AskZoodChat()
    @FocusState private var typing: Bool
    @Environment(\.dismiss) private var dismiss

    private var suggestions: [String] {
        [String(localized: "Summarize my last document"),
         String(localized: "Make a presentation about saving energy at home"),
         String(localized: "Compress a PDF"),
         String(localized: "How do I sign a PDF?")]
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: Space.x4) {
                            if chat.engine == nil {
                                List { ZoodModelSetupSection(availability: chat.availability) { chat.refreshEngine() } }
                                    .frame(height: 230)
                                    .scrollDisabled(true)
                                    .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                            }
                            if chat.messages.isEmpty {
                                welcome
                            }
                            ForEach(chat.messages) { message in
                                bubble(message).id(message.id)
                            }
                        }
                        .padding(Space.x5)
                    }
                    .onChange(of: chat.messages.last?.text) {
                        if let last = chat.messages.last { withAnimation(Motion.quick) { proxy.scrollTo(last.id, anchor: .bottom) } }
                    }
                }
                inputBar
            }
            .themedGround()
            .navigationTitle("Ask ZOOD")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("ask.done")
                }
            }
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: Space.x4) {
            Image(systemName: "sparkles")
                .font(.system(size: 34))
                .foregroundStyle(Color.accentColor)
            Text("Ask ZOOD anything, or tell it what to do.")
                .themeFont(.title)
            Text("It runs on this iPhone, in Arabic and English. Nothing you type leaves it. Tap the microphone on the keyboard to speak.")
                .foregroundStyle(Surface.secondaryLabel)
            ForEach(suggestions, id: \.self) { suggestion in
                Button {
                    chat.draft = suggestion
                    send()
                } label: {
                    Text(suggestion)
                        .padding(.horizontal, Space.x5)
                        .padding(.vertical, Space.x3)
                        .background(Surface.groupedCell, in: Capsule())
                }
                .buttonStyle(.pressable)
                .foregroundStyle(Surface.label)
            }
        }
        .padding(.vertical, Space.x5)
    }

    private func bubble(_ message: AskZoodChat.Message) -> some View {
        let mine = message.role == .person
        return HStack {
            if mine { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: Space.x3) {
                if message.text.isEmpty {
                    ProgressView()
                } else {
                    Text(message.text)
                        .textSelection(.enabled)
                }
                if let file = message.file {
                    ShareLink(item: file) {
                        Label(file.lastPathComponent, systemImage: "rectangle.on.rectangle")
                    }
                    .accessibilityIdentifier("ask.file")
                }
            }
            .padding(Space.x4)
            .foregroundStyle(mine ? Color.white : Surface.label)
            .background(mine ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Surface.groupedCell),
                        in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            if !mine { Spacer(minLength: 40) }
        }
        .accessibilityIdentifier(mine ? "ask.mine" : "ask.reply")
    }

    private var inputBar: some View {
        HStack(spacing: Space.x3) {
            TextField("Ask or tell ZOOD…", text: $chat.draft, axis: .vertical)
                .lineLimit(1...4)
                .focused($typing)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.horizontal, Space.x4)
                .padding(.vertical, Space.x3)
                .background(Surface.groupedCell, in: RoundedRectangle(cornerRadius: Radius.sheet, style: .continuous))
                .accessibilityIdentifier("ask.field")
            Button(action: send) {
                Image(systemName: chat.working ? "ellipsis.circle" : "arrow.up.circle.fill")
                    .font(.system(size: 30))
            }
            .disabled(chat.working || chat.draft.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("ask.send")
        }
        .padding(Space.x4)
        .background(.bar)
    }

    private func send() {
        Task { await chat.send(library: library, run: run, close: { dismiss() }) }
    }
}
