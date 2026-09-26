import SwiftUI
import UniformTypeIdentifiers
import ZoodCore

/// "1.1 GB" / "١٫١ غ.ب." in the current locale.
func fileSize(_ bytes: Int64) -> String {
    bytes.formatted(.byteCount(style: .file))
}

/// One-time setup of the portable model: size shown before anything is downloaded.
struct ModelSetupCard: View {
    @State private var models = ModelManager.shared
    @State private var importing = false
    @State private var pick: LocalModelSpec?

    private var spec: LocalModelSpec { pick ?? models.downloading ?? models.recommended }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ai.model.title").font(.headline)
            Text("ai.model.explain").font(.callout).foregroundStyle(.secondary)
            switch models.state {
            case .downloading(let received, let total):
                ProgressView(value: Double(received), total: Double(max(total, 1))) {
                    Text("ai.model.downloading \(spec.displayName)")
                } currentValueLabel: {
                    Text(verbatim: "\(received.formatted(.byteCount(style: .file))) / \(total.formatted(.byteCount(style: .file)))")
                }
                HStack {
                    Button("ai.model.pause") { models.pause() }
                    Button("common.cancel", role: .destructive) { models.cancel() }
                }
            case .verifying:
                ProgressView { Text("ai.model.verifying") }
            case .paused:
                Text("ai.model.paused").font(.callout)
                HStack {
                    Button("ai.model.resume") { models.download(spec) }.buttonStyle(.borderedProminent)
                    Button("common.cancel", role: .destructive) { models.cancel() }
                }
            case .idle, .failed:
                if case .failed(let message) = models.state {
                    Text(verbatim: message).font(.callout).foregroundStyle(.red)
                }
                Picker(selection: Binding(get: { spec.id }, set: { pick = LocalModelCatalog.spec(id: $0) })) {
                    ForEach(LocalModelCatalog.all) { m in
                        Text("ai.model.option \(m.displayName) \(fileSize(m.byteCount))").tag(m.id)
                    }
                } label: {
                    Text("ai.model.choose")
                }
                if spec.id == models.recommended.id {
                    Text("ai.model.recommended").font(.caption).foregroundStyle(.secondary)
                }
                Button {
                    models.download(spec)
                } label: {
                    Label("ai.model.download \(fileSize(spec.byteCount))", systemImage: "arrow.down.circle")
                }
                .buttonStyle(.borderedProminent)
                Button { importing = true } label: { Label("ai.model.import", systemImage: "folder") }
                Text("ai.model.footer").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass()
        .fileImporter(isPresented: $importing, allowedContentTypes: [UTType(filenameExtension: "gguf") ?? .data]) { result in
            if case .success(let url) = result {
                Task { await models.importModel(from: url) }
            }
        }
    }
}

/// On-device AI, voices and "My details" in one place.
struct AISettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var ai = LocalAI.shared
    @State private var models = ModelManager.shared
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent {
                        Text(ai.appleAvailable ? "ai.apple.ready" : "ai.apple.off")
                    } label: {
                        Text("ai.backend.apple")
                    }
                    if let reason = ai.appleUnavailableReason {
                        Text(verbatim: reason).font(.caption).foregroundStyle(.secondary)
                    } else {
                        LabeledContent("ai.apple.arabic") {
                            Text(AppleModel.supports(.arabic) ? "common.yes" : "common.no")
                        }
                    }
                } header: {
                    Text("ai.settings.apple")
                } footer: {
                    Text("ai.settings.apple.footer")
                }

                Section {
                    if !ai.portableRuntime {
                        Text("ai.error.runtimeMissing").font(.callout).foregroundStyle(.secondary)
                    } else if let installed = models.installed {
                        LabeledContent(installed.displayName) {
                            Text(installed.byteCount.formatted(.byteCount(style: .file)))
                        }
                        Button("ai.model.delete", role: .destructive) { confirmDelete = true }
                    } else {
                        ModelSetupCard().listRowInsets(EdgeInsets())
                    }
                } header: {
                    Text("ai.settings.portable")
                } footer: {
                    Text("ai.settings.portable.footer")
                }

                Section {
                    NavigationLink { ProfileView() } label: { Label("profile.title", systemImage: "person.text.rectangle") }
                    NavigationLink { VoicePickerView() } label: { Label("read.voices", systemImage: "waveform") }
                }
            }
            .navigationTitle(Text("ai.settings"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("common.done") { dismiss() } }
            }
            .confirmationDialog(Text("ai.model.delete"), isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("ai.model.delete", role: .destructive) { Task { await models.deleteInstalled() } }
                Button("common.cancel", role: .cancel) {}
            } message: {
                Text("ai.model.delete.message")
            }
        }
    }
}
