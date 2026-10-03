import NMCore
import NMData
import SwiftUI
import UniformTypeIdentifiers

/// Everything that is not one of the three tabs: language, location, calculation, downloads,
/// sources & licenses, privacy, about.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(Localization.self) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var installed: [InstalledPack] = []
    @State private var confirmRemove: InstalledPack?
    @State private var importing = false
    @State private var message: String?
    @State private var showCity = false
    @State private var showCalc = false

    var body: some View {
        @Bindable var l10n = l10n
        NavigationStack {
            Form {
                Section {
                    Picker(l10n.t("language"), selection: $l10n.override) {
                        Text(l10n.t("use_device_language")).tag(String?.none)
                        ForEach(Localization.supported, id: \.self) { code in
                            Text(Localization.nativeNames[code] ?? code).tag(Optional(code))
                        }
                    }
                    .pickerStyle(.inline)
                } header: { Text(l10n.t("language")) } footer: { Text(l10n.t("draft_translations_note")) }

                Section(l10n.t("location_section")) {
                    if let loc = app.settings.location {
                        Text(loc.name)
                        Text(l10n.t("time_zone_label", Format.zoneName(loc.zone, locale: l10n.locale))).font(.caption).foregroundStyle(.secondary)
                    }
                    Button(l10n.t("change")) { showCity = true }
                }
                Section {
                    Toggle(l10n.t("online_search"), isOn: Binding(get: { app.settings.onlineSearch }, set: { app.settings.onlineSearch = $0 }))
                } header: { Text(l10n.t("tab_mosques")) } footer: { Text(l10n.t("online_search_body")) }

                Section(l10n.t("prayer_section")) {
                    Text(l10n.t(Format.methodKey(app.settings.prayer.method)))
                    Button(l10n.t("calculation")) { showCalc = true }
                }

                Section {
                    if let m = app.packs?.citiesManifest() {
                        packRow(l10n.t("pack_kind_cities"), m, records: m.recordCount ?? 0, bytes: m.files.reduce(0) { $0 + $1.bytes }, builtin: true)
                    }
                    ForEach(installed) { p in
                        let title = p.kind == "mosques" ? l10n.t("pack_kind_mosques", p.manifest.coverage?.name ?? p.manifest.title(l10n.language))
                            : l10n.t("pack_kind_books", p.manifest.title(l10n.language))
                        packRow(title, p.manifest, records: p.recordCount, bytes: p.bytes, builtin: p.builtin)
                            .swipeActions { Button(l10n.t("remove"), role: .destructive) { confirmRemove = p } }
                            .contextMenu { Button(l10n.t("remove"), role: .destructive) { confirmRemove = p } }
                    }
                    Button(l10n.t("import_pack")) { importing = true }
                    Button(l10n.t("restore_builtin")) { app.packs?.restoreBuiltins(); reload() }
                    if let message { Text(message).font(.footnote) }
                } header: { Text(l10n.t("downloads")) } footer: { Text(l10n.t("downloads_body")) }

                Section(l10n.t("on_device_ai")) {
                    Text(LocalAnswerer.availability(language: l10n.language) == .available ? l10n.t("ai_status_local") : l10n.t("ai_pack_not_installed"))
                }
                Section(l10n.t("cloud_ai")) { Text(l10n.t("cloud_ai_off")) }

                Section(l10n.t("sources_licenses")) {
                    let manifests = [app.packs?.citiesManifest()].compactMap { $0 } + installed.map(\.manifest)
                    ForEach(Array(Set(manifests.map(\.license.attribution))).sorted(), id: \.self) { a in
                        let m = manifests.first { $0.license.attribution == a }!
                        VStack(alignment: .leading) {
                            Text(a)
                            Text(m.license.name + " · " + m.license.url).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Text("Adhan (MIT) · Batoul Apps; GRDB (MIT) · Gwendal Roué").font(.caption)
                    Text("Map and live mosque results: Apple Maps (online)").font(.caption)
                }
                Section(l10n.t("privacy")) { Text(l10n.t("privacy_body")) }
                Section {
                    Button(l10n.t("onb_replay")) {
                        dismiss()
                        app.settings.onboarded = false
                    }
                }
                Section(l10n.t("about")) {
                    Text(l10n.t("version_label", Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""))
                }
            }
            .navigationTitle(l10n.t("settings"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(l10n.t("done")) { dismiss() } } }
            .onAppear(perform: reload)
            .alert(confirmRemove.map { l10n.t("remove_pack_confirm", $0.manifest.coverage?.name ?? $0.manifest.title(l10n.language)) } ?? "",
                   isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } })) {
                Button(l10n.t("remove"), role: .destructive) {
                    if let p = confirmRemove { try? app.packs?.remove(p.id); reload() }
                }
                Button(l10n.t("cancel"), role: .cancel) {}
            }
            // A pack is a folder with manifest.json and its data files (hash-verified on import).
            .fileImporter(isPresented: $importing, allowedContentTypes: [.folder]) { result in
                guard case let .success(url) = result else { return }
                let ok = url.startAccessingSecurityScopedResource()
                defer { if ok { url.stopAccessingSecurityScopedResource() } }
                do {
                    let m = try app.packs?.importFolder(url)
                    message = m.map { l10n.t("import_done", $0.title(l10n.language)) }
                } catch PackError.checksum {
                    message = l10n.t("import_failed", l10n.t("error_pack_checksum"))
                } catch PackError.newerSchema {
                    message = l10n.t("import_failed", l10n.t("error_pack_newer"))
                } catch {
                    message = l10n.t("import_failed", l10n.t("error_pack_format"))
                }
                reload()
            }
            .sheet(isPresented: $showCity) { CityPickerView() }
            .sheet(isPresented: $showCalc) { CalculationView() }
        }
    }

    private func reload() { installed = (try? app.packs?.installed()) ?? [] }

    private func packRow(_ title: String, _ m: PackManifest, records: Int, bytes: Int, builtin: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(l10n.t("pack_details", Format.number(Double(records), digits: 0, locale: l10n.locale),
                        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file), String(m.version))
                 + (builtin ? " · " + l10n.t("pack_builtin") : ""))
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
