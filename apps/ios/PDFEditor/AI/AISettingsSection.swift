import SwiftUI

/// The Settings section for on-device AI: which models answer here — ZOOD's
/// own (carried in the app or fetched once) and Apple's — and, for each one
/// that does not, exactly why; and the autofill profile.
struct AISettingsSection: View {
    @State private var availability = AIEngines.availability()
    @State private var engineName = AIEngines.current().engine?.name
    @State private var apple = AIEngines.appleAvailability()
    @State private var download = ZoodModelDownload.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Section {
            LabeledContent("On-device model") {
                Text(availability.title)
                    .foregroundStyle(availability.isAvailable ? Surface.label : Surface.secondaryLabel)
            }
            .accessibilityIdentifier("settings.ai.status")
            if availability.isAvailable, let engineName {
                LabeledContent("Provider", value: engineName)
            }
            LabeledContent("ZOOD's AI") {
                Text(ZoodModel.isPresent ? (ZoodModel.isBundled ? "Built in" : "On this iPhone") : "Not yet")
            }
            .accessibilityIdentifier("settings.ai.zood")
            LabeledContent("Apple Intelligence") {
                Text(apple.title)
            }
            if apple == .appleIntelligenceOff, !ZoodModel.isPresent, let url = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: url) {
                    Label("Turn on Apple Intelligence", systemImage: "arrow.up.forward.app")
                }
            }
            if ZoodModel.isPresent, !ZoodModel.isBundled {
                Button("Remove ZOOD's AI from this iPhone", systemImage: "trash", role: .destructive) {
                    download.remove()
                    refresh()
                }
            }
            NavigationLink {
                ProfileEditorView()
            } label: {
                Label("Autofill profile", systemImage: "person.text.rectangle")
            }
            .accessibilityIdentifier("settings.ai.profile")
        } header: {
            Text("AI on this device")
        } footer: {
            Text(availability.isAvailable
                 ? "The model runs on this iPhone, in Arabic and English. Nothing leaves it."
                 : availability.message)
                .accessibilityIdentifier("settings.ai.reason")
        }
        .onChange(of: scenePhase) { _, phase in
            // Apple Intelligence may have been turned on in the meantime.
            if phase == .active { refresh() }
        }
        if !ZoodModel.isPresent {
            ZoodModelSetupSection(availability: ZoodModel.deviceCanRun ? .needsModel : .deviceTooSmall) { refresh() }
        }
    }

    private func refresh() {
        availability = AIEngines.availability()
        engineName = AIEngines.current().engine?.name
        apple = AIEngines.appleAvailability()
    }
}
