import NMCore
import SwiftUI

struct CityPickerView: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var locating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        Task {
                            locating = true
                            let r = await model.useDeviceLocation()
                            locating = false
                            switch r {
                            case .ok: dismiss()
                            case .denied: error = l10n.t("location_denied")
                            case .noFix: error = l10n.t("location_fix_failed")
                            }
                        }
                    } label: {
                        Label(l10n.t(locating ? "locating" : "use_my_location"), systemImage: "location.fill")
                    }
                    .disabled(locating)
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                }
                let results = model.cities?.search(query, limit: 40) ?? []
                if results.isEmpty && !query.isEmpty {
                    Text(l10n.t("no_city_results")).foregroundStyle(.secondary)
                }
                ForEach(results) { city in
                    Button {
                        model.choose(city: city)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(city.displayName(l10n.language)).foregroundStyle(.primary)
                            Text(Format.country(city.countryCode, locale: l10n.locale) + " · " + city.zoneId).font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(minHeight: 44)
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: l10n.t("search_city"))
            .navigationTitle(l10n.t("choose_city_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(l10n.t("cancel")) { dismiss() } } }
        }
    }
}

struct CalculationView: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    Picker(l10n.t("calculation_method"), selection: Binding(get: { model.settings.prayer.method }, set: { model.setMethod($0) })) {
                        ForEach(PrayerMethod.allCases, id: \.self) { Text(l10n.t(Format.methodKey($0))).tag($0) }
                    }
                    .pickerStyle(.inline)
                } footer: { Text(l10n.t("method_suggested")) }
                Section(l10n.t("asr_method")) {
                    Picker(l10n.t("asr_method"), selection: $model.settings.prayer.madhab) {
                        Text(l10n.t("asr_standard")).tag(AsrMadhab.SHAFI)
                        Text(l10n.t("asr_hanafi")).tag(AsrMadhab.HANAFI)
                    }
                    .pickerStyle(.inline).labelsHidden()
                }
                Section(l10n.t("high_latitude_rule")) {
                    Picker(l10n.t("high_latitude_rule"), selection: $model.settings.prayer.highLatitudeRule) {
                        Text(l10n.t("hl_auto")).tag(HighLatRule.AUTO)
                        Text(l10n.t("hl_middle")).tag(HighLatRule.MIDDLE_OF_THE_NIGHT)
                        Text(l10n.t("hl_seventh")).tag(HighLatRule.SEVENTH_OF_THE_NIGHT)
                        Text(l10n.t("hl_twilight")).tag(HighLatRule.TWILIGHT_ANGLE)
                    }
                    .pickerStyle(.inline).labelsHidden()
                }
                Section(l10n.t("polar_rule")) {
                    Picker(l10n.t("polar_rule"), selection: $model.settings.prayer.polarRule) {
                        Text(l10n.t("polar_none")).tag(PolarRule.UNAVAILABLE)
                        Text(l10n.t("polar_nearest")).tag(PolarRule.NEAREST_LATITUDE)
                    }
                    .pickerStyle(.inline).labelsHidden()
                }
                if model.settings.prayer.method == .UMM_AL_QURA {
                    Toggle(l10n.t("ramadan_isha"), isOn: $model.settings.prayer.ramadanIshaExtension)
                }
                Section {
                    Stepper(value: $model.settings.prayer.hijriAdjustmentDays, in: -2...2) {
                        Text(l10n.t("hijri_adjustment") + ": " + Format.number(Double(model.settings.prayer.hijriAdjustmentDays), digits: 0, locale: l10n.locale))
                    }
                } footer: { Text(l10n.t("hijri_calendar_note")) }
                Section(l10n.t("minute_adjustments")) {
                    ForEach(PrayerEvent.allCases, id: \.self) { e in
                        Stepper(value: Binding(get: { model.settings.prayer.offsets[e] ?? 0 }, set: { model.settings.prayer.offsets[e] = $0 == 0 ? nil : $0 }), in: -30...30) {
                            Text(l10n.t(Format.prayerKey(e)) + ": " + l10n.t("minutes_value", model.settings.prayer.offsets[e] ?? 0))
                        }
                    }
                }
            }
            .navigationTitle(l10n.t("calculation"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(l10n.t("done")) { dismiss() } } }
            .onDisappear { Task { await model.rescheduleReminders() } }
        }
    }
}
