import SwiftUI
import WarraqCore

/// Settings: the language and the appearance, applied the moment they are
/// chosen; and what this build is. Further settings (the scanner's modes,
/// OCR languages, the iCloud folder, the app lock) join with their features.
struct SettingsView: View {
    @AppStorage(SettingsKey.language) private var language: AppLanguage = .system
    @AppStorage(SettingsKey.appearance) private var appearance: AppAppearance = .system

    var body: some View {
        AppSheet(title: "Settings") {
            Form {
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
                Section {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        Link(destination: url) {
                            Label("Open in the Settings app", systemImage: "arrow.up.forward.app")
                        }
                    }
                }
                Section("About") {
                    LabeledContent("Version", value: Self.appVersion)
                    LabeledContent("Core", value: Core.version)
                    LabeledContent("Privacy") {
                        Text("Nothing leaves this device.")
                            .multilineTextAlignment(.trailing)
                    }
                }
            }
            .accessibilityIdentifier("settings.form")
        }
        .sensoryFeedback(.selection, trigger: language)
        .sensoryFeedback(.selection, trigger: appearance)
    }

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(version) (\(build))"
    }
}
