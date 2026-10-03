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
    let sky: SkyPeriod

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
        sky = location == nil ? .night : SkyPeriod.at(now, today: today, current: current)
    }

    /// Elapsed fraction of the current prayer period (time progress, not sun position).
    var progress: Double {
        guard let n = next, let start = n.periodStart else { return 0 }
        let total = n.at.timeIntervalSince(start)
        return total > 0 ? min(1, max(0, now.timeIntervalSince(start) / total)) : 0
    }
}

/// Prayer & Qibla: the sky for the current prayer period, the Qibla arc with the next prayer inside,
/// and today's times on glass. Scrolling past the arc pins a compact glass summary at the top.
struct PrayerView: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @Binding var showSettings: Bool
    @State private var scrollOffset: CGFloat = 0
    @State private var showCity = false
    @State private var showCalc = false
    @State private var showCompass = false
    @State private var detector = AlignmentDetector()
    @State private var aligned = false

    private var showCompact: Bool { scrollOffset > 300 }

    var body: some View {
        ScrollViewReader { proxy in
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let snap = PrayerSnapshot(model: model, now: ctx.date)
                ZStack(alignment: .top) {
                    ScrollView {
                        VStack(spacing: 14) {
                            PrayerHero(snap: snap, compass: model.location.compass, aligned: aligned,
                                       onLocation: { showCity = true }, onSettings: { showSettings = true }, onQibla: { showCompass = true })
                                .id("top")
                            if snap.location == nil {
                                ChooseLocationCard(onPickCity: { showCity = true })
                            } else {
                                content(snap)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 32)
                    }
                    .scrollIndicators(.hidden)
                    .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, v in scrollOffset = v }
                    if showCompact, snap.next != nil {
                        CompactPrayerBar(snap: snap, compass: model.location.compass) {
                            withAnimation(Theme.spring) { proxy.scrollTo("top", anchor: .top) }
                        }
                        .padding(.horizontal, 16)
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .animation(Theme.spring, value: showCompact)
                .onChange(of: model.location.compass) { _, c in updateAlignment(c, snap.qiblaBearing) }
            }
        }
        .skyBackground()
        .toolbar(.hidden, for: .navigationBar)
        .sensoryFeedback(.success, trigger: aligned) { _, new in new }
        .onAppear {
            model.location.beginHeading()
            #if DEBUG
            if UserDefaults.standard.bool(forKey: "demoCompass") { showCompass = true }
            #endif
        }
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
        if snap.today?.status.isEstimated == true {
            Label(l10n.t("estimated_badge"), systemImage: "exclamationmark.circle")
                .font(.footnote.weight(.semibold)).foregroundStyle(Theme.gold)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .glass(Capsule())
        }
        if !loc.zoneConfirmed { ZoneConfirmCard(location: loc, onChange: { showCity = true }) }
        if snap.today?.status == .unavailable { PolarCard() }
        if let today = snap.today, today.status != .unavailable { ScheduleCard(snap: snap, today: today) }
        DatesCard(snap: snap, onCalculation: { showCalc = true })
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
            Text(l10n.t("choose_city_body")).foregroundStyle(.white.opacity(0.85))
            GlassGroup {
                VStack(spacing: 10) {
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
                        Label(l10n.t(locating ? "locating" : "use_my_location"), systemImage: "location.fill").frame(maxWidth: .infinity, minHeight: 32)
                    }
                    .prominentButton().disabled(locating)
                    Button(action: onPickCity) {
                        Label(l10n.t("search_city"), systemImage: "magnifyingglass").frame(maxWidth: .infinity, minHeight: 32)
                    }
                    .glassButton()
                }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(Color(hex: 0xF2B8B5)) }
        }
        .foregroundStyle(.white)
        .glassCard(padding: 20)
    }
}

private struct ZoneConfirmCard: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    let location: PrayerLocation
    var onChange: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(l10n.t("confirm_time_zone_title"), systemImage: "clock.badge.questionmark").font(.headline)
            Text(l10n.t("confirm_time_zone_body", Format.zoneName(location.zone, locale: l10n.locale))).font(.subheadline)
            HStack {
                Button(l10n.t("use_this_time_zone")) { model.settings.location?.zoneConfirmed = true }.prominentButton()
                Button(l10n.t("change"), action: onChange).glassButton()
            }
        }
        .foregroundStyle(.white)
        .glassCard()
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
        .foregroundStyle(.white)
        .glassCard()
    }
}

/// Today's times on glass. The upcoming prayer sits in a gold glass pill with an "Upcoming" badge.
private struct ScheduleCard: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    let snap: PrayerSnapshot
    let today: DaySchedule

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(l10n.t("todays_times")).font(.subheadline.weight(.semibold)).foregroundStyle(.white.opacity(0.8))
                .accessibilityAddTraits(.isHeader).padding(.horizontal, 8).padding(.bottom, 6)
            GlassGroup(spacing: 4) {
                VStack(spacing: 2) {
                    ForEach(PrayerEvent.allCases, id: \.self) { e in
                        if let at = today[e] { row(e, at) }
                    }
                }
            }
            Text(l10n.t("sunrise_not_prayer_note")).font(.caption).foregroundStyle(.white.opacity(0.7)).padding(.horizontal, 8).padding(.top, 8)
        }
        .foregroundStyle(.white)
        .glassCard(padding: 10)
    }

    @ViewBuilder private func row(_ e: PrayerEvent, _ at: Date) -> some View {
        let isNext = snap.next?.event == e && snap.next?.isTomorrow == false
        let name = l10n.t(Format.prayerKey(e))
        let nextDay = CivilDate.of(at, in: today.zone) > today.date
        HStack(spacing: 12) {
            Image(systemName: Theme.icon(e)).font(.system(size: 17)).frame(width: 26)
                .foregroundStyle(isNext ? Theme.gold : .white.opacity(e.isPrayer ? 0.9 : 0.6))
                .accessibilityHidden(true)
            Text(name).font(.body.weight(isNext ? .semibold : .regular))
                .foregroundStyle(isNext ? Theme.gold : .white.opacity(e.isPrayer ? 1 : 0.7))
            if isNext {
                Text(l10n.t("upcoming")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.gold)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .overlay(Capsule().stroke(Theme.gold.opacity(0.7), lineWidth: 1))
            }
            Spacer(minLength: 4)
            Text(Format.time(at, zone: today.zone, locale: l10n.locale) + (nextDay ? " (\(l10n.t("next_day")))" : ""))
                .font(.title3.weight(isNext ? .semibold : .regular)).monospacedDigit()
                .foregroundStyle(isNext ? Theme.gold : .white)
            if e.isPrayer {
                let on = model.settings.reminders.contains(e)
                Button { Task { await model.setReminder(e, !on) } } label: {
                    Image(systemName: on ? "bell.fill" : "bell.slash").font(.system(size: 15))
                        .foregroundStyle(on ? Theme.gold : .white.opacity(0.55))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(l10n.t(on ? "reminder_on_a11y" : "reminder_off_a11y", name))
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
        }
        .padding(.leading, 10)
        .frame(minHeight: 52)
        .background {
            if isNext {
                RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.gold.opacity(0.14))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.gold.opacity(0.55), lineWidth: 1))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct DatesCard: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    let snap: PrayerSnapshot
    var onCalculation: () -> Void

    var body: some View {
        if let loc = snap.location {
            let d = CivilDate.of(snap.now, in: loc.zone)
            VStack(alignment: .leading, spacing: 6) {
                Text(Format.gregorian(d, locale: l10n.locale)).font(.headline)
                Text(Format.hijri(d, adjustment: model.settings.prayer.hijriAdjustmentDays, locale: l10n.locale)).foregroundStyle(Theme.gold)
                Text(l10n.t("hijri_calendar_note")).font(.caption).foregroundStyle(.white.opacity(0.7))
                Divider().overlay(.white.opacity(0.2)).padding(.vertical, 4)
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(l10n.t(Format.methodKey(model.settings.prayer.method))).font(.subheadline)
                        Text(l10n.t("time_zone_label", Format.zoneName(loc.zone, locale: l10n.locale))).font(.caption).foregroundStyle(.white.opacity(0.7))
                    }
                    Spacer()
                    Button(l10n.t("calculation"), action: onCalculation).glassButton()
                }
            }
            .foregroundStyle(.white)
            .glassCard()
        }
    }
}
