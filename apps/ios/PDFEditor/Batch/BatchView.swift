import SwiftUI
import UniformTypeIdentifiers

/// Batch: a sequence of the app's own steps — recognize text, compress,
/// rotate, delete or keep pages, page marks, remove hidden information,
/// protect, export — run over many files from Files or the Library, one file
/// at a time. Progress per file, Stop, and a report that says what became of
/// each: the new file's name, or why it was not done. Results are new files
/// in My documents; the originals are only ever read. A sequence can be saved
/// under a name and run again; it never keeps a password.
struct BatchView: View {
    let library: LibraryModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var run = BatchRun()
    @State private var steps: [BatchStep] = []
    @State private var saved: [SavedSequence] = []
    @State private var choosingFiles = false
    @State private var choosingFromLibrary = false
    @State private var naming = false
    @State private var name = ""
    @State private var password = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var ownerPassword = ""
    @State private var suffix = String(localized: "processed")
    private let store = BatchSequenceStore()

    private var hasProtect: Bool { steps.contains { $0.kind == .protect } }

    /// Why Run cannot start yet, or nil.
    private var runProblem: LocalizedStringKey? {
        if let problem = BatchSequence.problem(steps) { return problem.message }
        if run.inputs.isEmpty { return "Add the files to run it on." }
        if hasProtect {
            if !Protect.isUsable(newPassword) { return "Type the new password for Protect." }
            if newPassword != confirmPassword { return "The two passwords are not the same." }
        }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                if !saved.isEmpty, !run.isRunning { savedSection }
                stepsSection
                filesSection
                if !run.isRunning { passwordsSection }
                if !run.isRunning { resultsSection }
                if run.isRunning || run.summary != nil { progressSection }
            }
            .themedScrollBackground()
            .navigationTitle("Batch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .disabled(false)
        }
        .interactiveDismissDisabled(run.isRunning)
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.pdf], allowsMultipleSelection: true) { result in
            if case let .success(urls) = result { run.add(urls) }
        }
        .sheet(isPresented: $choosingFromLibrary) {
            BatchLibraryPicker(library: library) { urls in run.add(urls) }
        }
        .alert("Save the sequence", isPresented: $naming) {
            TextField("Name", text: $name)
                .accessibilityIdentifier("batch.save.name")
            Button("Save") {
                saved = store.save(name: name, steps: steps)
            }
            .accessibilityIdentifier("batch.save.confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its steps and their options are kept on this device. Passwords never are.")
        }
        .task {
            saved = store.load()
        }
        .onChange(of: run.summary) { _, summary in
            // The results are in My documents: the Library lists them at once.
            if summary != nil { library.refresh() }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Close") { dismiss() }
                .disabled(run.isRunning)
                .accessibilityIdentifier("batch.close")
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if run.isRunning {
                Button("Stop", role: .destructive) { run.stop() }
                    .accessibilityIdentifier("batch.stop")
            } else {
                Button("Save…", systemImage: "square.and.arrow.down") {
                    name = ""
                    naming = true
                }
                .disabled(steps.isEmpty)
                .accessibilityIdentifier("batch.save")
                Button("Run", action: start)
                    .disabled(runProblem != nil)
                    .accessibilityIdentifier("batch.run")
            }
        }
    }

    // MARK: - Sections

    private var savedSection: some View {
        Section("Saved sequences") {
            ForEach(saved) { sequence in
                Button {
                    steps = sequence.steps.map { step in
                        var copy = step
                        copy.id = UUID()
                        return copy
                    }
                } label: {
                    LabeledContent {
                        Text("\(sequence.steps.count) steps").tabularNumbers()
                    } label: {
                        Label { Text(verbatim: sequence.name).foregroundStyle(Surface.label) } icon: { Image(systemName: "list.bullet.rectangle") }
                    }
                }
                .accessibilityIdentifier("batch.saved.\(sequence.name)")
            }
            .onDelete { offsets in
                for index in offsets { saved = store.delete(name: saved[index].name) }
            }
        }
    }

    private var stepsSection: some View {
        Section {
            ForEach($steps) { $step in
                NavigationLink {
                    BatchStepEditor(step: $step)
                } label: {
                    stepRow(step, number: (steps.firstIndex(of: step) ?? 0) + 1)
                }
                .accessibilityIdentifier("batch.step.\((steps.firstIndex(of: step) ?? 0))")
            }
            .onDelete { steps.remove(atOffsets: $0) }
            .onMove { steps.move(fromOffsets: $0, toOffset: $1) }
            .deleteDisabled(run.isRunning)
            .moveDisabled(run.isRunning)
            if !run.isRunning {
                NavigationLink {
                    BatchStepPicker { kind in steps.append(BatchStep(kind: kind)) }
                } label: {
                    Label("Add a step", systemImage: "plus.circle")
                }
                .accessibilityIdentifier("batch.addStep")
            }
        } header: {
            Text("Steps, in order")
        } footer: {
            if let problem = BatchSequence.problem(steps), !steps.isEmpty {
                Text(problem.message).foregroundStyle(.red)
                    .accessibilityIdentifier("batch.problem")
            }
        }
    }

    private func stepRow(_ step: BatchStep, number: Int) -> some View {
        HStack(spacing: Space.x4) {
            Text(number, format: .number)
                .font(TextStyle.caption.weight(.semibold))
                .frame(width: 22, height: 22)
                .background(Circle().fill(Surface.groupedCell))
                .tabularNumbers()
            VStack(alignment: .leading, spacing: Space.x1) {
                Label(step.kind.title, systemImage: step.kind.symbol)
                step.summary
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
                if let problem = step.problem {
                    Text(problem).font(TextStyle.caption).foregroundStyle(.red)
                }
            }
        }
    }

    private var filesSection: some View {
        Section {
            ForEach(run.inputs) { input in
                BatchFileRow(input: input, state: run.state(of: input), steps: run.steps.isEmpty ? steps : run.steps)
            }
            .onDelete { offsets in
                for index in offsets { run.remove(run.inputs[index]) }
            }
            .deleteDisabled(run.isRunning)
            if !run.isRunning {
                Button("Add from Files…", systemImage: "folder") { choosingFiles = true }
                    .accessibilityIdentifier("batch.addFiles")
                Button("Add from My documents…", systemImage: "books.vertical") { choosingFromLibrary = true }
                    .accessibilityIdentifier("batch.addLibrary")
            }
        } header: {
            Text("Files")
        } footer: {
            Text("Each result is a new file in My documents. The originals are never changed.")
        }
    }

    private var passwordsSection: some View {
        Section {
            SecureField("Password of protected files (if any)", text: $password)
                .textContentType(.password)
                .accessibilityIdentifier("batch.password")
            if hasProtect {
                SecureField("New password", text: $newPassword)
                    .textContentType(.newPassword)
                    .accessibilityIdentifier("batch.newPassword")
                SecureField("New password again", text: $confirmPassword)
                    .textContentType(.newPassword)
                    .accessibilityIdentifier("batch.confirmPassword")
                SecureField("Owner password (optional)", text: $ownerPassword)
                    .accessibilityIdentifier("batch.ownerPassword")
            }
        } header: {
            Text("Passwords")
        } footer: {
            Text("Used for this run only and never saved.")
        }
    }

    private var resultsSection: some View {
        Section {
            TextField("Added to each name", text: $suffix)
                .accessibilityIdentifier("batch.suffix")
        } header: {
            Text("Results")
        } footer: {
            let sample = BatchRun.cleanSuffix(suffix)
            Text(verbatim: sample.isEmpty ? "report.pdf" : "report – \(sample).pdf")
        }
    }

    @ViewBuilder
    private var progressSection: some View {
        Section {
            if run.isRunning {
                ProgressView(value: Double(run.finishedCount), total: Double(max(1, run.inputs.count))) {
                    Text("\(run.finishedCount) of \(run.inputs.count) files")
                        .tabularNumbers()
                }
                .accessibilityIdentifier("batch.progress")
                switch run.backgroundKind {
                case .continued:
                    Text("It goes on if you leave the app; its progress is shown outside the app.")
                        .font(TextStyle.caption).foregroundStyle(Surface.secondaryLabel)
                case .shortGrace:
                    Text("Keep the app open: iOS gives an app only a short time in the background, and the batch stops when it ends.")
                        .font(TextStyle.caption).foregroundStyle(Surface.secondaryLabel)
                case .none:
                    EmptyView()
                }
            }
            if run.systemStopped {
                Label("iOS stopped the batch while the app was in the background. The files it had not finished are marked; run them again with the app open.",
                      systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("batch.systemStopped")
            }
            if let summary = run.summary {
                Text("Done \(summary.done) · Failed \(summary.failed) · Stopped \(summary.cancelled + summary.stoppedBySystem)")
                    .tabularNumbers()
                    .accessibilityIdentifier("batch.summary")
                if !run.outputs.isEmpty {
                    ShareLink(items: run.outputs) {
                        Label("Share the results", systemImage: "square.and.arrow.up")
                    }
                    .accessibilityIdentifier("batch.share")
                }
            }
        } header: {
            Text("Progress")
        }
    }

    private func start() {
        guard runProblem == nil else { return }
        run.start(BatchRun.Options(steps: steps,
                                   password: password.isEmpty ? nil : password,
                                   openPassword: hasProtect ? newPassword : nil,
                                   ownerPassword: hasProtect && !ownerPassword.isEmpty ? ownerPassword : nil,
                                   outputFolder: library.documentsFolder,
                                   suffix: suffix,
                                   languages: PageOCR.languages,
                                   locale: locale))
    }
}

/// A file of the batch and what became of it.
struct BatchFileRow: View {
    let input: BatchInput
    let state: BatchFileState
    let steps: [BatchStep]

    var body: some View {
        HStack(spacing: Space.x4) {
            icon.frame(width: 24)
            VStack(alignment: .leading, spacing: Space.x1) {
                Text(verbatim: input.name)
                    .lineLimit(2)
                detail
                    .font(TextStyle.caption)
                    .foregroundStyle(tint)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: input.name))
        .accessibilityValue(detail)
        .accessibilityIdentifier("batch.file.\(input.name)")
    }

    @ViewBuilder
    private var icon: some View {
        switch state {
        case .waiting: Image(systemName: "circle").foregroundStyle(Surface.tertiaryLabel)
        case .working: ProgressView()
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed: Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        case .cancelled, .stoppedBySystem: Image(systemName: "pause.circle").foregroundStyle(.orange)
        }
    }

    private var tint: Color {
        switch state {
        case .failed: .red
        case .cancelled, .stoppedBySystem: .orange
        default: Surface.secondaryLabel
        }
    }

    private var detail: Text {
        switch state {
        case .waiting:
            return Text("Waiting")
        case let .working(step):
            if step < 0 || step >= steps.count { return Text("Reading…") }
            return Text("Step \(step + 1) of \(steps.count): ") + Text(steps[step].kind.title)
        case let .done(output):
            return Text("Saved as \(output.lastPathComponent)")
        case let .failed(step, failure):
            if let step, step < steps.count {
                return Text("Not done at step \(step + 1), ") + Text(steps[step].kind.title) + Text(verbatim: ": ") + Text(failure.message)
            }
            return Text("Not done: ") + Text(failure.message)
        case .cancelled:
            return Text("Stopped before it was finished")
        case .stoppedBySystem:
            return Text("Stopped by the system before it was finished")
        }
    }
}

/// My documents and the chosen folder's files, to pick several at once.
struct BatchLibraryPicker: View {
    let library: LibraryModel
    let add: ([URL]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var chosen: Set<URL> = []

    private var files: [(name: String, url: URL)] {
        library.documents.map { ($0.name, $0.url) }
            + library.folderFiles.filter { $0.url.pathExtension.lowercased() == "pdf" }.map { ($0.name, $0.url) }
    }

    var body: some View {
        NavigationStack {
            List {
                if files.isEmpty {
                    Text("No PDFs in My documents yet.")
                        .foregroundStyle(Surface.secondaryLabel)
                }
                ForEach(files, id: \.url) { file in
                    Button {
                        if chosen.contains(file.url) { chosen.remove(file.url) } else { chosen.insert(file.url) }
                    } label: {
                        HStack {
                            Image(systemName: chosen.contains(file.url) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(chosen.contains(file.url) ? Color.accentColor : Surface.tertiaryLabel)
                            Text(verbatim: file.name).foregroundStyle(Surface.label)
                        }
                    }
                    .accessibilityIdentifier("batch.library.\(file.name)")
                    .accessibilityAddTraits(chosen.contains(file.url) ? .isSelected : [])
                }
            }
            .themedScrollBackground()
            .navigationTitle("My documents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        add(files.map(\.url).filter(chosen.contains))
                        dismiss()
                    }
                    .disabled(chosen.isEmpty)
                    .accessibilityIdentifier("batch.library.add")
                }
                ToolbarItem(placement: .bottomBar) {
                    Button(chosen.count == files.count ? "Choose none" : "Choose all") {
                        chosen = chosen.count == files.count ? [] : Set(files.map(\.url))
                    }
                    .accessibilityIdentifier("batch.library.all")
                }
            }
        }
    }
}

/// The steps there are, one tap to add one.
struct BatchStepPicker: View {
    let add: (BatchStep.Kind) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List(BatchStep.Kind.allCases) { kind in
            Button {
                add(kind)
                dismiss()
            } label: {
                Label { Text(kind.title).foregroundStyle(Surface.label) } icon: { Image(systemName: kind.symbol) }
            }
            .accessibilityIdentifier("batch.addStep.\(kind.rawValue)")
        }
        .themedScrollBackground()
        .navigationTitle("Add a step")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// One step's options.
struct BatchStepEditor: View {
    @Binding var step: BatchStep

    var body: some View {
        Form {
            switch step.kind {
            case .ocr:
                Section {
                    Picker("Which pages", selection: $step.ocrScope) {
                        Text("Pages with no text of their own").tag(BatchStep.OCRScope.blank)
                        Text("Every page").tag(BatchStep.OCRScope.all)
                    }
                    .pickerStyle(.inline)
                } footer: {
                    Text("Read on this device in the languages chosen in the scanner's settings. The words become an invisible, searchable layer; the pages look as they did.")
                }
            case .compress:
                Section {
                    Picker("Compression", selection: $step.compressLevel) {
                        ForEach(BatchStep.CompressLevel.allCases) { level in
                            Text(level.title).tag(level)
                        }
                    }
                    .pickerStyle(.inline)
                } footer: {
                    Text("Protected and signed files are left as they are and reported.")
                }
            case .rotate:
                Section {
                    Picker("Turn", selection: $step.quarterTurns) {
                        Text(verbatim: "90°").tag(1)
                        Text(verbatim: "180°").tag(2)
                        Text(verbatim: "270°").tag(3)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("batch.edit.turn")
                }
                pagesSection(emptyMeansAll: true)
            case .deletePages, .extractPages:
                pagesSection(emptyMeansAll: false)
            case .pageMarks:
                Section {
                    Picker("Kind", selection: $step.markKind) {
                        ForEach(BatchStep.markKinds) { kind in
                            Text(kind.title).tag(kind.rawValue)
                        }
                    }
                    .accessibilityIdentifier("batch.edit.markKind")
                    if step.mark != .pageNumber {
                        TextField("What it says", text: $step.markText)
                            .accessibilityIdentifier("batch.edit.markText")
                    }
                } footer: {
                    Text("Drawn as the Page marks sheet draws them; {page}, {pages}, {date} and {file} are filled in for each file.")
                }
                pagesSection(emptyMeansAll: true)
            case .removeHidden:
                Section {
                    ForEach(BatchStep.allHiddenKinds, id: \.self) { kind in
                        Toggle(isOn: Binding(
                            get: { step.hiddenKinds.contains(kind) },
                            set: { on in
                                if on { step.hiddenKinds = BatchStep.allHiddenKinds.filter { step.hiddenKinds.contains($0) || $0 == kind } }
                                else { step.hiddenKinds.removeAll { $0 == kind } }
                            }
                        )) {
                            Text(Self.hiddenTitle(kind))
                        }
                        .accessibilityIdentifier("batch.edit.hidden.\(kind)")
                    }
                } footer: {
                    Text("The file is written whole, without them and without its earlier versions.")
                }
            case .protect:
                Section {
                    Toggle("Allow printing", isOn: $step.allowPrint)
                    Toggle("Allow copying text", isOn: $step.allowCopy)
                    Toggle("Allow changes", isOn: $step.allowChange)
                } footer: {
                    Text("AES-256. The password is typed on the Batch screen when the sequence runs, and never saved with it.")
                }
            case .export:
                Section {
                    Picker("Format", selection: $step.exportFormat) {
                        Text("Word (.docx)").tag(BatchStep.ExportFormat.word)
                        Text("Text (.txt)").tag(BatchStep.ExportFormat.text)
                    }
                    .pickerStyle(.inline)
                } footer: {
                    Text("Export makes something other than a PDF, so it is always the last step.")
                }
            }
        }
        .themedScrollBackground()
        .navigationTitle(step.kind.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func pagesSection(emptyMeansAll: Bool) -> some View {
        Section {
            TextField(emptyMeansAll ? "Every page" : "Pages", text: $step.pages)
                .keyboardType(.numbersAndPunctuation)
                .accessibilityIdentifier("batch.edit.pages")
        } header: {
            Text("Pages")
        } footer: {
            if let problem = step.problem {
                Text(problem).foregroundStyle(.red)
            } else {
                Text("For example 1-3, 5. Pages a file does not have are passed over.")
            }
        }
    }

    static func hiddenTitle(_ kind: String) -> LocalizedStringKey {
        switch kind {
        case "metadata": "Document information (author, dates, …)"
        case "scripts": "Scripts and actions"
        case "attachments": "Attached files"
        case "comments": "Comments and marks"
        case "forms": "Form fields"
        case "hiddenLayers": "Hidden layers"
        case "bookmarks": "Bookmarks"
        case "thumbnails": "Page thumbnails"
        case "privateData": "Other programs' private data"
        case "links": "Links"
        default: "Hidden text"
        }
    }
}

