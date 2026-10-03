import NMCore
import SwiftUI

/// Values for one instant, computed from cached schedules (countdown derives from instants).
struct PrayerSnapshot {
    let now: Date
    let location: PrayerLocation?
    let today: DaySchedule?
    let next: Upcoming?
    let current: PrayerEvent?
    let fajrEndsAt: Date?
    let qiblaBearing: Double?
    let qiblaDistance: Double?

    @MainActor
    init(model: AppModel, now: Date) {
        self.now = now
        location = model.settings.location
        let days = model.days(now: now)
        today = days.count == 3 ? days[1] : nil
        next = model.calculator.nextPrayer(days, now: now)
        if let t = today {
            current = PrayerEvent.allCases.last { (t[$0] ?? .distantFuture) <= now } ?? (days[0][.isha] != nil ? .isha : nil)
            fajrEndsAt = model.calculator.fajrEndsAt(t, now: now)
        } else {
            current = nil; fajrEndsAt = nil
        }
        qiblaBearing = location.map { Qibla.bearing(from: $0.location) }
        qiblaDistance = location.map { Qibla.distanceMeters(from: $0.location) }
    }

    /// Elapsed fraction of the current prayer period (time progress, not sun position).
    var progress: Double {
        guard let n = next, let start = n.periodStart else { return 0 }
        let total = n.at.timeIntervalSince(start)
        return total > 0 ? min(1, max(0, now.timeIntervalSince(start) / total)) : 0
    }
}

struct PrayerView: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @Environment(\.colorScheme) private var scheme
    @Binding var showSettings: Bool
    @State private var expanded = false
    @State private var scrollOffset: CGFloat = 0
    @State private var showCity = false
    @State private var showCalc = false
    @State private var showCompass = false
    @State private var detector = AlignmentDetector()
    @State private var aligned = false

    private var collapse: CGFloat { min(1, max(0, scrollOffset / (Theme.homeHeader - Theme.compactHeader))) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let snap = PrayerSnapshot(model: model, now: ctx.date)
            ZStack(alignment: .top) {
                ScrollView {
                    VStack(spacing: 12) {
                        PrayerHeaderView(snap: snap, expanded: expanded, collapse: collapse, aligned: aligned,
                                         onToggle: { withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { expanded.toggle() } },
                                         onSettings: { showSettings = true })
                        if snap.location == nil {
                            ChooseLocationCard(onPickCity: { showCity = true })
                        } else {
                            content(snap)
                        }
                    }
                    .padding(.bottom, 24)
                }
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, v in scrollOffset = v }
                if collapse >= 0.98, snap.next != nil {
                    CompactPrayerBar(snap: snap, compass: model.location.compass) {
                        withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { expanded = true }
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.2), value: collapse >= 0.98)
            .ignoresSafeArea(edges: .top)
            .onChange(of: model.location.compass) { _, c in updateAlignment(c, snap.qiblaBearing) }
        }
        .toolbar(.hidden, for: .navigationBar)
        .sensoryFeedback(.success, trigger: aligned) { _, new in new }
        .onAppear { model.location.beginHeading() }
        .onDisappear { model.location.endHeading() }
        .sheet(isPresented: $showCity) { CityPickerView() }
        .sheet(isPresented: $showCalc) { CalculationView() }
        .fullScreenCover(isPresented: $showCompass) { QiblaCompassView() }
    }

    private func updateAlignment(_ c: CompassState, _ bearing: Double?) {
        guard case let .live(heading, accuracy, _) = c, let b = bearing else {
            _ = detector.update(relativeDeg: 180, accuracyDeg: nil); aligned = false; return
        }
        _ = detector.update(relativeDeg: Angles.relativeToQibla(qiblaBearingTrue: b, headingTrue: heading), accuracyDeg: accuracy)
        aligned = detector.aligned
    }

    @ViewBuilder private func content(_ snap: PrayerSnapshot) -> some View {
        let loc = snap.location!
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Button { showCity = true } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(loc.name).font(.headline).foregroundStyle(.primary)
                        Text(l10n.t(Format.methodKey(model.settings.prayer.method))).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button(l10n.t("calculation")) { showCalc = true }
                Button(l10n.t("change")) { showCity = true }
            }
            .padding(.horizontal)
            if snap.today?.status.isEstimated == true {
                Text(l10n.t("estimated_badge")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentText(scheme)).padding(.horizontal)
            }
            if !loc.zoneConfirmed { ZoneConfirmCard(location: loc, onChange: { showCity = true }) }
            if let end = snap.fajrEndsAt {
                Text(l10n.t("fajr_ends_at_sunrise", Format.time(end, zone: loc.zone, locale: l10n.locale)))
                    .font(.subheadline).foregroundStyle(Theme.accentText(scheme)).padding(.horizontal)
            }
            if snap.today?.status == .unavailable { PolarCard() }
            QiblaCard(snap: snap, compass: model.location.compass, aligned: aligned, onOpen: { showCompass = true })
            if let today = snap.today, today.status != .unavailable { ScheduleCard(snap: snap, today: today) }
            DatesCard(snap: snap)
        }
        .padding(.horizontal, 4)
    }
}

private struct ChooseLocationCard: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    var onPickCity: () -> Void
    @State private var locating = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(l10n.t("choose_city_title")).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
            Text(l10n.t("choose_city_body")).foregroundStyle(.secondary)
            Button(action: onPickCity) { Text(l10n.t("search_city")).frame(maxWidth: .infinity, minHeight: 44) }.prominentButton()
            Button {
                Task {
                    locating = true
                    switch await model.useDeviceLocation() {
                    case .ok: error = nil
                    case .denied: error = l10n.t("location_denied")
                    case .noFix: error = l10n.t("location_fix_failed")
                    }
                    locating = false
                }
            } label: {
                Label(l10n.t(locating ? "locating" : "use_my_location"), systemImage: "location").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered).disabled(locating)
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .card()
        .padding(.horizontal)
    }
}

private struct ZoneConfirmCard: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    let location: PrayerLocation
    var onChange: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(l10n.t("confirm_time_zone_title")).font(.headline)
            Text(l10n.t("confirm_time_zone_body", Format.zoneName(location.zone, locale: l10n.locale))).font(.subheadline)
            HStack {
                Button(l10n.t("use_this_time_zone")) { model.settings.location?.zoneConfirmed = true }.prominentButton()
                Button(l10n.t("change"), action: onChange)
            }
        }
        .card().padding(.horizontal)
    }
}

private struct PolarCard: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(l10n.t("polar_unavailable_title"), systemImage: "exclamationmark.triangle").font(.headline)
            Text(l10n.t("polar_unavailable_body")).font(.subheadline)
            Button(l10n.t("polar_use_nearest")) { model.settings.prayer.polarRule = .NEAREST_LATITUDE }.prominentButton()
        }
        .card().padding(.horizontal)
    }
}

private struct ScheduleCard: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    let snap: PrayerSnapshot
    let today: DaySchedule

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(l10n.t("todays_times")).font(.headline).accessibilityAddTraits(.isHeader).padding(.bottom, 6)
            ForEach(PrayerEvent.allCases, id: \.self) { e in
                if let at = today[e] {
                    let isNext = snap.next?.event == e && snap.next?.isTomorrow == false
                    let name = l10n.t(Format.prayerKey(e))
                    let nextDay = CivilDate.of(at, in: today.zone) > today.date
                    HStack {
                        Text(name).fontWeight(isNext ? .bold : .regular).foregroundStyle(e.isPrayer ? .primary : .secondary)
                        Spacer()
                        Text(Format.time(at, zone: today.zone, locale: l10n.locale) + (nextDay ? " (\(l10n.t("next_day")))" : ""))
                            .monospacedDigit().fontWeight(isNext ? .bold : .medium)
                        if e.isPrayer {
                            let on = model.settings.reminders.contains(e)
                            Button { Task { await model.setReminder(e, !on) } } label: {
                                Image(systemName: on ? "bell.fill" : "bell.slash").frame(width: 44, height: 44)
                            }
                            .accessibilityLabel(l10n.t(on ? "reminder_on_a11y" : "reminder_off_a11y", name))
                        } else {
                            Color.clear.frame(width: 44, height: 44)
                        }
                    }
                    .frame(minHeight: 48)
                    .padding(.horizontal, 8)
                    .background(isNext ? Theme.gold.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 12))
                    if e != .isha { Divider() }
                }
            }
            Text(l10n.t("sunrise_not_prayer_note")).font(.caption).foregroundStyle(.secondary).padding(.top, 8)
        }
        .card().padding(.horizontal)
    }
}

private struct DatesCard: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @Environment(\.colorScheme) private var scheme
    let snap: PrayerSnapshot
    var body: some View {
        if let loc = snap.location {
            let d = CivilDate.of(snap.now, in: loc.zone)
            VStack(alignment: .leading, spacing: 4) {
                Text(Format.gregorian(d, locale: l10n.locale))
                Text(Format.hijri(d, adjustment: model.settings.prayer.hijriAdjustmentDays, locale: l10n.locale)).foregroundStyle(Theme.accentText(scheme))
                Text(l10n.t("hijri_calendar_note")).font(.caption).foregroundStyle(.secondary)
            }
            .card().padding(.horizontal)
        }
    }
}
