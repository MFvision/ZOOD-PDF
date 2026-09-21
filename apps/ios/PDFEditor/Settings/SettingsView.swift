import SwiftUI
import UniformTypeIdentifiers
import WarraqCore

/// Settings: the language and the appearance, applied the moment they are
/// chosen; the scanner's default mode; the OCR languages Vision can read
/// here; the folder in Files or iCloud Drive the Library reads; the app
/// lock; "Delete everything", which deletes; and what this build is.
struct SettingsView: View {
    let library: LibraryModel
    @AppStorage(SettingsKey.language) private var language: AppLanguage = .system
    @AppStorage(SettingsKey.appearance) private var appearance: AppAppearance = .system
    @AppStorage(SettingsKey.scanMode) private var scanMode: ScanMode = .color
    @AppStorage(SettingsKey.appLock) private var appLock = false
    @State private var ocrLanguages: Set<String> = Set(LibraryIndexer.ocrLanguages)
    @State private var recognizable: [(code: String, name: String)] = []
    @State private var choosingFolder = false
    @State private var confirmingDelete = false
    @State private var deleting = false
    @State private var lockError: String?
    @Environment(\.dismiss) private var dismiss

    /// The languages Vision can read on this device, with their names.
    private static func recognizableLanguages() -> [(code: String, name: String)] {
        let codes = VisionTextRecognizer.supportedLanguages().map { String($0.split(separator: "-")[0]).lowercased() }
        return Array(Set(codes)).sorted().map { code in
            (code, Locale.current.localizedString(forLanguageCode: code) ?? code)
        }
    }

    var body: some View {
        AppSheet(title: "Settings") {
            Form {
                interface
                scanning
                folder
                privacy
                everything
                about
            }
            .accessibilityIdentifier("settings.form")
            .onAppear { recognizable = Self.recognizableLanguages() }
            .fileImporter(isPresented: $choosingFolder, allowedContentTypes: [.folder]) { result in
                if case let .success(url) = result {
                    library.choose(folder: url)
                }
            }
            .confirmationDialog("Delete everything?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete everything", role: .destructive) {
                    deleting = true
                    Task {
                        await library.deleteEverything()
                        deleting = false
                        dismiss()
                    }
                }
                .accessibilityIdentifier("settings.deleteConfirm")
            } message: {
                Text("Every document in My documents, the index, the recents, the thumbnails and the settings will be deleted from this device. Documents in your own folder are not touched.")
            }
            .alert("Cannot turn on the lock", isPresented: Binding(get: { lockError != nil }, set: { if !$0 { lockError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(lockError ?? "")
            }
            .overlay {
                if deleting {
                    ProgressView("Deleting…")
                        .padding(Space.x6)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                }
            }
        }
        .sensoryFeedback(.selection, trigger: language)
        .sensoryFeedback(.selection, trigger: appearance)
        .sensoryFeedback(.selection, trigger: scanMode)
    }

    private var interface: some View {
        Section {
            Picker("Language", selection: $language) {
                ForEach(AppLanguage.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .accessibilityIdentifier("settings.language")
            Picker("Appearance", selection: $appearance) {
                ForEach(AppAppearance.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .accessibilityIdentifier("settings.appearance")
        } header: {
            Text("Interface")
        } footer: {
            Text("The system's own parts — alerts, the file browser — follow the language from the next launch. The Settings app can set it too.")
        }
    }

    private var scanning: some View {
        Section {
            Picker("Default scan mode", selection: $scanMode) {
                ForEach(ScanMode.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .accessibilityIdentifier("settings.scanMode")
            if recognizable.isEmpty {
                LabeledContent("Text recognition", value: String(localized: "Not available on this device"))
            } else {
                ForEach(recognizable, id: \.code) { language in
                    Toggle(isOn: Binding(
                        get: { ocrLanguages.contains(language.code) },
                        set: { on in
                            if on { ocrLanguages.insert(language.code) } else if ocrLanguages.count > 1 { ocrLanguages.remove(language.code) }
                            UserDefaults.standard.set(ocrLanguages.sorted(), forKey: SettingsKey.ocrLanguages)
                        }
                    )) {
                        Text(language.name)
                    }
                    .accessibilityIdentifier("settings.ocr.\(language.code)")
                }
            }
        } header: {
            Text("Scan and text recognition")
        } footer: {
            Text("The languages ticked are read off scans and pictures, on this device only. The list is what this device can read.")
        }
    }

    private var folder: some View {
        Section {
            if let chosen = library.chosenFolder {
                LabeledContent("Folder", value: chosen.name)
                Button("Choose another folder…") { choosingFolder = true }
                Button("Stop reading this folder", role: .destructive) {
                    Task { await library.forgetFolder() }
                }
                .accessibilityIdentifier("settings.forgetFolder")
            } else {
                Button("Choose a folder in Files or iCloud Drive…") { choosingFolder = true }
                    .accessibilityIdentifier("settings.chooseFolder")
            }
        } header: {
            Text("Library")
        } footer: {
            Text("The Library reads the PDFs and pictures in the folder you choose, as well as My documents, and searches inside them. The files stay where they are.")
        }
    }

    private var privacy: some View {
        Section {
            Toggle(isOn: Binding(get: { appLock }, set: { on in
                if on, !AppLock.canLock {
                    lockError = String(localized: "Set up Face ID, Touch ID or a passcode on this device first.")
                    return
                }
                appLock = on
            })) {
                Label {
                    Text(AppLock.biometryName.map { String(localized: "Lock with \($0)") } ?? String(localized: "Lock the app"))
                } icon: {
                    Image(systemName: AppLock.biometryName == "Touch ID" ? "touchid" : "faceid")
                }
            }
            .accessibilityIdentifier("settings.appLock")
        } header: {
            Text("Privacy")
        } footer: {
            Text("With the lock on, the app asks for \(AppLock.biometryName ?? String(localized: "the passcode")) whenever it comes to the front. Nothing leaves this device either way.")
        }
    }

    private var everything: some View {
        Section {
            Button("Delete everything…", role: .destructive) {
                confirmingDelete = true
            }
            .accessibilityIdentifier("settings.deleteEverything")
        } footer: {
            Text("Deletes every document kept by the app, its index and its settings.")
        }
    }

    private var about: some View {
        Section("About") {
            LabeledContent("Version", value: Self.appVersion)
            LabeledContent("Core", value: Core.version)
            LabeledContent("Privacy") {
                Text("Nothing leaves this device.")
                    .multilineTextAlignment(.trailing)
            }
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: url) {
                    Label("Open in the Settings app", systemImage: "arrow.up.forward.app")
                }
            }
        }
    }

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(version) (\(build))"
    }
}
