import SwiftUI
import UniformTypeIdentifiers
import WarraqCore

/// Compare: the open document against another version of it. The other is
/// chosen from Files, My documents or Recents; the core reads both in logical
/// order and says what changed — word by word, each change with the words
/// round it — and draws every page both have to say where they look
/// different. Next and Previous step through the changes; on iPad the two
/// versions' pages stand side by side, on iPhone a switch shows one or the
/// other. Nothing is written to either file.
struct CompareView: View {
    @State private var compare: CompareModel
    /// The document's own file, left out of the lists it could be compared with.
    private let thisURL: URL?
    @Environment(\.dismiss) private var dismiss
    @Environment(LibraryModel.self) private var library: LibraryModel?
    @State private var choosingFile = false
    @State private var password = ""
    @State private var recents: [RecentDocument] = []

    init(model: DocumentModel) {
        _compare = State(initialValue: CompareModel(this: CompareSide(name: model.name, bytes: model.bytes, password: model.password)))
        thisURL = model.url
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Compare")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
        }
        .fileImporter(isPresented: $choosingFile, allowedContentTypes: [.pdf]) { result in
            if case let .success(url) = result {
                Task { await compare.choose(url: url) }
            }
        }
        .task {
            recents = library?.recents ?? RecentsStore().load()
        }
        .onDisappear { compare.close() }
    }

    @ViewBuilder
    private var content: some View {
        switch compare.phase {
        case .choosing:
            chooser
        case let .comparing(done, of):
            VStack(spacing: Space.x5) {
                ProgressView(value: Double(done), total: Double(max(of, 1)))
                    .frame(maxWidth: 320)
                    .accessibilityIdentifier("compare.progress")
                (compare.text == nil ? Text("Reading both versions…") : Text("Comparing how the pages look: \(done) of \(of)"))
                    .font(TextStyle.callout)
                    .foregroundStyle(Surface.secondaryLabel)
                    .tabularNumbers()
                Button("Stop", role: .cancel) { compare.stop() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("compare.stop")
            }
            .padding(Space.x8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .themedGround()
        case .compared:
            CompareResultView(compare: compare)
        case let .failed(message):
            EmptyState(symbol: "exclamationmark.triangle", title: "Could not compare", message: LocalizedStringKey(message),
                       actionTitle: "Try again", action: { compare.again() }, actionIdentifier: "compare.retry")
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Close") {
                compare.close()
                dismiss()
            }
            .accessibilityIdentifier("compare.close")
        }
        ToolbarItem(placement: .confirmationAction) {
            switch compare.phase {
            case .choosing:
                Button("Compare") { compare.compare() }
                    .disabled(compare.other == nil)
                    .accessibilityIdentifier("compare.run")
            case .compared:
                Button("Change…") { compare.again() }
                    .accessibilityIdentifier("compare.again")
            default:
                EmptyView()
            }
        }
    }

    // MARK: - Choosing

    private var chooser: some View {
        Form {
            Section {
                versionRow(name: compare.this.name, older: compare.thisIsOlder)
                if let name = compare.chosenName {
                    versionRow(name: name, older: !compare.thisIsOlder)
                        .accessibilityIdentifier("compare.chosen")
                }
                if compare.other != nil {
                    Button("Swap older and newer", systemImage: "arrow.up.arrow.down") {
                        compare.thisIsOlder.toggle()
                    }
                    .accessibilityIdentifier("compare.swap")
                }
            } header: {
                Text("Versions")
            } footer: {
                Text("What the newer version has that the older does not is shown as added.")
            }
            if compare.otherNeedsPassword {
                Section {
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .onSubmit(unlock)
                        .accessibilityIdentifier("compare.password")
                    Button("Open", action: unlock)
                        .disabled(password.isEmpty)
                        .accessibilityIdentifier("compare.password.open")
                } header: {
                    Text("This file is protected")
                } footer: {
                    if compare.otherPasswordWrong {
                        Text("That password is not right. Try again.")
                            .foregroundStyle(.red)
                    }
                }
            }
            if compare.otherUnreadable {
                Section {
                    Label("That file could not be read as a PDF.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("compare.unreadable")
                }
            }
            Section("Compare with") {
                Button("Choose from Files…", systemImage: "folder") { choosingFile = true }
                    .accessibilityIdentifier("compare.files")
            }
            let documents = (library?.documents ?? []).filter { !same($0.url) }
            if !documents.isEmpty {
                Section("My documents") {
                    ForEach(documents) { document in
                        candidate(name: document.name) {
                            Task { await compare.choose(url: document.url) }
                        }
                    }
                }
            }
            let opened = recents.filter { recent in !same(recent.resolveURL()) && !documents.contains { $0.name == recent.name } }
            if !opened.isEmpty {
                Section("Recents") {
                    ForEach(opened) { recent in
                        candidate(name: recent.name) {
                            guard let url = recent.resolveURL() else { return }
                            Task { await compare.choose(url: url) }
                        }
                    }
                }
            }
            Section {
                Toggle("Ignore tashkeel and tatweel", isOn: $compare.ignoreMarks)
                    .accessibilityIdentifier("compare.ignoreMarks")
                Toggle("Count أ and ا, ة and ه, ى and ي as one letter", isOn: $compare.unifyLetters)
                    .accessibilityIdentifier("compare.unifyLetters")
            } header: {
                Text("Options")
            } footer: {
                Text("Digits are compared as written: ٢٠٢٦ and 2026 are a change.")
            }
        }
        .themedScrollBackground()
    }

    private func versionRow(name: String, older: Bool) -> some View {
        LabeledContent {
            older ? Text("Older") : Text("Newer")
        } label: {
            Label {
                Text(verbatim: name).lineLimit(2)
            } icon: {
                Image(systemName: older ? "clock.arrow.circlepath" : "doc.badge.clock")
            }
        }
    }

    private func candidate(name: String, choose: @escaping () -> Void) -> some View {
        Button(action: choose) {
            HStack {
                Label { Text(verbatim: name).foregroundStyle(Surface.label) } icon: { Image(systemName: "doc.text") }
                Spacer()
                if compare.chosenName == name {
                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                }
            }
        }
        .accessibilityIdentifier("compare.pick.\(name)")
    }

    private func same(_ url: URL?) -> Bool {
        guard let url, let thisURL else { return false }
        return url.standardizedFileURL.resolvingSymlinksInPath() == thisURL.standardizedFileURL.resolvingSymlinksInPath()
    }

    private func unlock() {
        guard !password.isEmpty else { return }
        let typed = password
        Task { await compare.unlockOther(password: typed) }
    }
}

// MARK: - The result

/// What the comparison found: the counts, then the changes of the text or
/// the pages that look different, with Previous and Next under them.
struct CompareResultView: View {
    @Bindable var compare: CompareModel

    var body: some View {
        VStack(spacing: 0) {
            CompareSummary(compare: compare)
                .padding(.horizontal, Space.x5)
                .padding(.top, Space.x4)
            Picker("Show", selection: $compare.mode) {
                Text("Text").tag(CompareModel.Mode.text)
                Text("Pages").tag(CompareModel.Mode.pages)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Space.x5)
            .padding(.vertical, Space.x4)
            .accessibilityIdentifier("compare.mode")
            Divider()
            switch compare.mode {
            case .text: CompareChangesList(compare: compare)
            case .pages: ComparePagesPane(compare: compare)
            }
            Divider()
            CompareStepper(compare: compare)
        }
        .themedGround()
    }
}

/// The counts, said plainly: places inserted, deleted and replaced, the
/// words added and removed, and how many pages look different.
struct CompareSummary: View {
    let compare: CompareModel

    var body: some View {
        if let text = compare.text {
            VStack(alignment: .leading, spacing: Space.x3) {
                headline(text)
                    .font(TextStyle.headline)
                    .accessibilityIdentifier("compare.headline")
                HStack(spacing: Space.x3) {
                    tile(text.inserted, "Inserted", "compare.inserted", .green)
                    tile(text.deleted, "Deleted", "compare.deleted", .red)
                    tile(text.replaced, "Replaced", "compare.replaced", .orange)
                    tile(compare.changedLooks.count, "Pages look different", "compare.looksChanged", .blue)
                }
                Group {
                    Text("\(text.added) words added, \(text.removed) removed.")
                        .accessibilityIdentifier("compare.words")
                    if text.olderPages != text.newerPages {
                        Text("The older version has \(text.olderPages) pages, the newer \(text.newerPages).")
                    }
                    if text.hasNoText {
                        Text("Neither version has text to compare: the pages are compared by how they look.")
                    }
                    if !compare.looksComplete {
                        Text("Stopped: only the first \(compare.looks.count) pages were compared by how they look.")
                            .foregroundStyle(.orange)
                    }
                }
                .font(TextStyle.caption)
                .foregroundStyle(Surface.secondaryLabel)
                .tabularNumbers()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func headline(_ text: TextComparison) -> Text {
        if text.changes.isEmpty, compare.changedLooks.isEmpty {
            return Text("No differences found.")
        }
        return Text("\(text.changes.count) changes in the text")
    }

    private func tile(_ count: Int, _ title: LocalizedStringKey, _ id: String, _ tint: Color) -> some View {
        VStack(spacing: Space.x1) {
            Text(count, format: .number)
                .font(.title3.weight(.semibold))
                .foregroundStyle(tint)
                .tabularNumbers()
            Text(title)
                .font(TextStyle.caption)
                .foregroundStyle(Surface.secondaryLabel)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.x3)
        .background(RoundedRectangle(cornerRadius: Radius.group, style: .continuous).fill(Surface.groupedCell))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .accessibilityValue(Text(verbatim: "\(count)"))
        .accessibilityIdentifier(id)
    }
}

/// Every change of the text, in reading order: what was removed and what was
/// added, and the passage it sits in, the words as each version has them.
struct CompareChangesList: View {
    let compare: CompareModel

    var body: some View {
        if let text = compare.text, !text.changes.isEmpty {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Space.x4) {
                        ForEach(Array(text.changes.enumerated()), id: \.offset) { index, change in
                            CompareChangeCard(index: index, change: change, passage: text.passage(of: change),
                                              current: index == compare.currentChange) {
                                compare.currentChange = index
                                compare.currentPage = change.page
                            } showPage: {
                                compare.showPage(of: index)
                            }
                            .id(index)
                        }
                    }
                    .padding(Space.x5)
                }
                .onChange(of: compare.currentChange, initial: true) { _, index in
                    withAnimation(Motion.quick) { proxy.scrollTo(index, anchor: .center) }
                }
            }
        } else {
            EmptyState(symbol: "text.badge.checkmark", title: "The text is the same",
                       message: compare.text?.hasNoText == true ? "Neither version has text to compare." : "Every page reads the same, word for word.")
        }
    }
}

struct CompareChangeCard: View {
    let index: Int
    let change: TextComparison.Change
    let passage: TextComparison.Passage?
    let current: Bool
    let select: () -> Void
    let showPage: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.x3) {
            HStack {
                kindLabel
                    .font(TextStyle.caption.weight(.semibold))
                    .padding(.horizontal, Space.x3)
                    .padding(.vertical, Space.x1)
                    .background(Capsule().fill(tint.opacity(0.15)))
                    .foregroundStyle(tint)
                Text("Page \(change.page)")
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
                    .tabularNumbers()
                Spacer()
                Button("Show page", systemImage: "doc.text.magnifyingglass", action: showPage)
                    .labelStyle(.iconOnly)
                    .accessibilityIdentifier("compare.change.\(index).page")
            }
            if let passage {
                directional(passageText(passage))
                    .font(TextStyle.body)
                    .accessibilityIdentifier("compare.change.\(index).passage")
            }
            if !change.removed.isEmpty {
                line(symbol: "minus.circle.fill", tint: .red, text: change.removed, struck: true)
                    .accessibilityIdentifier("compare.change.\(index).removed")
            }
            if !change.added.isEmpty {
                line(symbol: "plus.circle.fill", tint: .green, text: change.added, struck: false)
                    .accessibilityIdentifier("compare.change.\(index).added")
            }
        }
        .padding(Space.x5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).fill(Surface.groupedCell))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(current ? Color.accentColor : .clear, lineWidth: 2)
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: select)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("compare.change.\(index)")
    }

    private var tint: Color {
        switch change.kind {
        case .inserted: .green
        case .deleted: .red
        case .replaced: .orange
        }
    }

    private var kindLabel: Text {
        switch change.kind {
        case .inserted: Text("Inserted")
        case .deleted: Text("Deleted")
        case .replaced: Text("Replaced")
        }
    }

    /// A removed or added stretch on a line of its own, in its own direction.
    private func line(symbol: String, tint: Color, text: String, struck: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.x3) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            directional(Text(verbatim: text).strikethrough(struck, color: tint))
                .font(TextStyle.body)
        }
        // One element: what it is, and the words exactly as the version has them.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(struck ? Text("Removed: \(text)") : Text("Added: \(text)"))
        .accessibilityValue(Text(verbatim: text))
    }

    /// The passage, with the changes marked: struck through for what the
    /// older version had, underlined for what the newer has — told apart
    /// without colour, and the change on screen in bold.
    private func passageText(_ passage: TextComparison.Passage) -> Text {
        var out = AttributedString()
        if passage.before { out += AttributedString("… ") }
        for (n, part) in passage.parts.enumerated() {
            if n > 0 { out += AttributedString(" ") }
            var piece = AttributedString(part.text)
            switch part.kind {
            case "removed":
                piece.strikethroughStyle = .single
                piece.foregroundColor = .red
            case "added":
                piece.underlineStyle = .single
                piece.foregroundColor = .green
            default:
                break
            }
            if part.change == index, part.kind != "same" {
                piece.inlinePresentationIntent = .stronglyEmphasized
            }
            out += piece
        }
        if passage.after { out += AttributedString(" …") }
        return Text(out)
    }

    /// Arabic reads from the right whatever the interface's language.
    private func directional(_ text: Text) -> some View {
        let plain = passage.map { $0.parts.map(\.text).joined(separator: " ") } ?? (change.added.isEmpty ? change.removed : change.added)
        let rtl = TextRecognizer.readsRightToLeft(plain)
        return text
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.layoutDirection, rtl ? .rightToLeft : .leftToRight)
    }
}

/// The pages, as each version has them, with where they look different
/// outlined: side by side where there is room, one at a time on a phone.
struct ComparePagesPane: View {
    @Bindable var compare: CompareModel
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        VStack(spacing: Space.x3) {
            if sizeClass == .compact {
                Picker("Version", selection: $compare.shownVersion) {
                    Text("Older").tag(CompareModel.Version.older)
                    Text("Newer").tag(CompareModel.Version.newer)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, Space.x5)
                .padding(.top, Space.x3)
                .accessibilityIdentifier("compare.version")
                ComparePagePicture(compare: compare, version: compare.shownVersion, page: compare.currentPage)
                    .padding(.horizontal, Space.x5)
            } else {
                HStack(alignment: .top, spacing: Space.x5) {
                    ComparePagePicture(compare: compare, version: .older, page: compare.currentPage)
                    ComparePagePicture(compare: compare, version: .newer, page: compare.currentPage)
                }
                .padding(.horizontal, Space.x5)
                .padding(.top, Space.x4)
            }
            let boxes = compare.boxes(onPage: compare.currentPage).count
            Text(boxes == 0 ? "This page looks the same in both versions." : "\(boxes) places look different on this page.")
                .font(TextStyle.caption)
                .foregroundStyle(Surface.secondaryLabel)
                .accessibilityIdentifier("compare.pageBoxes")
                .padding(.bottom, Space.x3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

struct ComparePagePicture: View {
    let compare: CompareModel
    let version: CompareModel.Version
    let page: Int
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var loaded = false

    var body: some View {
        VStack(spacing: Space.x3) {
            HStack(spacing: Space.x2) {
                version == .older ? Text("Older") : Text("Newer")
                Text(verbatim: "·")
                Text(verbatim: (version == .older ? compare.older : compare.newer)?.name ?? "")
                    .lineLimit(1)
            }
            .font(TextStyle.caption)
            .foregroundStyle(Surface.secondaryLabel)
            GeometryReader { proxy in
                ZStack {
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .overlay {
                                GeometryReader { inner in
                                    ForEach(compare.boxes(onPage: page), id: \.self) { box in
                                        Rectangle()
                                            .fill(Color.red.opacity(0.12))
                                            .overlay(Rectangle().strokeBorder(Color.red, lineWidth: 2))
                                            .frame(width: inner.size.width * box.w + 4, height: inner.size.height * box.h + 4)
                                            .position(x: inner.size.width * (box.x + box.w / 2), y: inner.size.height * (box.y + box.h / 2))
                                    }
                                }
                                // The boxes are where the page is: they never mirror.
                                .environment(\.layoutDirection, .leftToRight)
                            }
                            .background(Surface.paper)
                            .shadow(color: .black.opacity(0.16), radius: 6, y: 3)
                    } else if loaded {
                        ContentUnavailableView {
                            Label("No such page", systemImage: "doc")
                        } description: {
                            Text("This version has no page \(page).")
                        }
                    } else {
                        ProgressView()
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height)
                .task(id: "\(version.rawValue)-\(page)-\(Int(proxy.size.width))") {
                    loaded = false
                    image = await compare.picture(of: version, page: page, width: proxy.size.width * displayScale)
                    loaded = true
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(version == .older ? Text("Older version, page \(page)") : Text("Newer version, page \(page)"))
        .accessibilityValue(Text(verbatim: "\(image == nil ? 0 : compare.boxes(onPage: page).count)"))
        .accessibilityIdentifier("compare.page.\(version.rawValue)")
    }
}

/// Previous and Next under the result: through the changes of the text, or
/// through the pages that look different.
struct CompareStepper: View {
    @Bindable var compare: CompareModel

    var body: some View {
        HStack(spacing: Space.x5) {
            Button("Previous", systemImage: "chevron.backward") {
                compare.mode == .text ? compare.previousChange() : compare.previousLook()
            }
            .labelStyle(.iconOnly)
            .disabled(compare.mode == .text ? compare.currentChange == 0 || compare.changeCount == 0 : !compare.hasPreviousLook)
            .accessibilityIdentifier("compare.previous")
            Spacer()
            position
                .font(TextStyle.callout)
                .tabularNumbers()
                .accessibilityIdentifier("compare.position")
            Spacer()
            Button("Next", systemImage: "chevron.forward") {
                compare.mode == .text ? compare.nextChange() : compare.nextLook()
            }
            .labelStyle(.iconOnly)
            .disabled(compare.mode == .text ? compare.currentChange >= compare.changeCount - 1 : !compare.hasNextLook)
            .accessibilityIdentifier("compare.next")
        }
        .font(.title3)
        .padding(.horizontal, Space.x6)
        .padding(.vertical, Space.x4)
        .background(.bar)
    }

    private var position: Text {
        switch compare.mode {
        case .text:
            if compare.changeCount == 0 { return Text("No changes in the text") }
            return Text("Change \(compare.currentChange + 1) of \(compare.changeCount)")
        case .pages:
            let total = compare.changedLooks.count
            if let at = compare.lookPosition {
                return Text("Page \(compare.currentPage) · \(at) of \(total) that look different")
            }
            return Text("Page \(compare.currentPage) · \(total) look different")
        }
    }
}
