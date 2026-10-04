import SwiftUI

/// The Settings section for on-device AI: whether Apple's model is
/// available here and, when it is not, exactly why; and the autofill
/// profile. Nothing to switch on: the model is used when it is there.
struct AISettingsSection: View {
    @State private var availability = AIEngines.availability()
    @State private var engineName = AIEngines.current().engine?.name
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
            if availability == .appleIntelligenceOff, let url = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: url) {
                    Label("Turn on Apple Intelligence", systemImage: "arrow.up.forward.app")
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
            Text(availability.message)
                .accessibilityIdentifier("settings.ai.reason")
        }
        .onChange(of: scenePhase) { _, phase in
            // Apple Intelligence may have been turned on in the meantime.
            if phase == .active {
                availability = AIEngines.availability()
                engineName = AIEngines.current().engine?.name
            }
        }
    }
}
