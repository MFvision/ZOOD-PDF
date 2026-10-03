import NMCore
import SwiftUI

func qiblaGuidance(_ compass: CompassState, bearing: Double, l10n: Localization) -> String {
    switch compass {
    case .bearingOnly:
        return l10n.t("qibla_no_sensor", Format.degrees(bearing, locale: l10n.locale))
    case let .live(heading, _, calibrate):
        let rel = Angles.relativeToQibla(qiblaBearingTrue: bearing, headingTrue: heading)
        if calibrate { return l10n.t("qibla_calibrate") }
        if abs(rel) <= 5 { return l10n.t("qibla_you_are_facing") }
        let deg = Format.degrees(abs(rel), locale: l10n.locale)
        return rel > 0 ? l10n.t("qibla_turn_right", deg) : l10n.t("qibla_turn_left", deg)
    }
}

/// Live: the ring turns so N points to true north and the Kaaba sits at the Qibla bearing on the ring,
/// both by the shortest path across 359°/0°; a gold line runs from the centre to the Kaaba.
/// Bearing-only: fixed north-up diagram. Compass geometry never mirrors with RTL text.
struct QiblaDial: View {
    @Environment(Localization.self) private var l10n
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let bearing: Double
    let compass: CompassState
    let aligned: Bool
    @State private var ring: Double = 0

    private var target: Double {
        if case let .live(h, _, _) = compass { return -h }
        return 0
    }

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            ZStack {
                if aligned {
                    Circle().fill(Theme.gold.opacity(0.35)).blur(radius: 30).scaleEffect(1.05)
                }
                Circle().fill(.clear).glass(Circle())
                Circle().stroke(.white.opacity(0.35), lineWidth: 1)
                ZStack {
                    ForEach(0..<72, id: \.self) { i in
                        Rectangle().fill(.white.opacity(i % 18 == 0 ? 0.85 : 0.3))
                            .frame(width: i % 18 == 0 ? 2 : 1, height: size * (i % 18 == 0 ? 0.06 : 0.03))
                            .offset(y: -size / 2 + size * 0.05)
                            .rotationEffect(.degrees(Double(i) * 5))
                    }
                    Text(l10n.t("compass_north")).font(.system(size: size * 0.07, weight: .bold)).foregroundStyle(Color(hex: 0xF2B8B5))
                        .offset(y: -size / 2 + size * 0.15)
                    ZStack {
                        Capsule().fill(LinearGradient(colors: [Theme.gold.opacity(0.2), Theme.gold], startPoint: .bottom, endPoint: .top))
                            .frame(width: 3, height: size * 0.3).offset(y: -size * 0.15)
                        KaabaIcon(size: size * 0.13).offset(y: -size * 0.36)
                    }
                    .rotationEffect(.degrees(bearing))
                }
                .rotationEffect(.degrees(ring))
                if case .live = compass {
                    // Forward direction of the phone.
                    Capsule().fill(aligned ? Theme.gold : .white).frame(width: 4, height: 16).offset(y: -size / 2 - 2)
                }
                Circle().fill(Color(hex: 0x4F8EF7)).frame(width: 16, height: 16)
                    .overlay(Circle().stroke(.white, lineWidth: 3))
            }
            .frame(width: size, height: size)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(1, contentMode: .fit)
        .environment(\.layoutDirection, .leftToRight)
        .onAppear { ring = target }
        .onChange(of: target) { _, t in
            let next = Angles.shortestTarget(current: ring, target: t)
            if reduceMotion { ring = next } else { withAnimation(.interpolatingSpring(stiffness: 220, damping: 28)) { ring = next } }
        }
        .accessibilityElement()
        .accessibilityLabel(l10n.t("qibla_dial_a11y", l10n.t("qibla_bearing", Format.degrees(bearing, locale: l10n.locale))))
    }
}

/// Full-screen compass on the sky. Heading runs only while visible.
struct QiblaCompassView: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var detector = AlignmentDetector()
    @State private var aligned = false

    var body: some View {
        let snap = PrayerSnapshot(model: model, now: Date())
        let compass = model.location.compass
        VStack(spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(l10n.t("qibla")).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                    Text(snap.location?.name ?? "").font(.subheadline).foregroundStyle(.white.opacity(0.8))
                }
                Spacer()
                GlassIconButton(systemImage: "xmark", label: l10n.t("close")) { dismiss() }
            }
            Spacer(minLength: 0)
            if let bearing = snap.qiblaBearing {
                QiblaDial(bearing: bearing, compass: compass, aligned: aligned).frame(maxWidth: 380).padding(.horizontal, 12)
                Text(qiblaGuidance(compass, bearing: bearing, l10n: l10n)).font(.title2.weight(.semibold)).multilineTextAlignment(.center)
                    .foregroundStyle(aligned ? Theme.gold : .white)
                    .accessibilityAddTraits(.updatesFrequently)
                GlassGroup(spacing: 8) {
                    HStack(spacing: 8) {
                        info(l10n.t("qibla_bearing", Format.degrees(bearing, locale: l10n.locale)))
                        if let d = snap.qiblaDistance { info(l10n.t("qibla_distance", Format.distance(d, l10n: l10n))) }
                    }
                }
                switch compass {
                case let .live(_, accuracy, _):
                    if let a = accuracy { Text(l10n.t("heading_accuracy", Format.degrees(a, locale: l10n.locale))).font(.footnote).foregroundStyle(.white.opacity(0.75)) }
                case .bearingOnly:
                    Text(l10n.t("qibla_north_up")).font(.footnote).foregroundStyle(.white.opacity(0.75))
                }
                Text(l10n.t("qibla_hold_flat") + " · " + l10n.t("qibla_approximate")).font(.footnote).foregroundStyle(.white.opacity(0.75)).multilineTextAlignment(.center)
            } else {
                Text(l10n.t("qibla_location_needed"))
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(.white)
        .padding(20)
        .skyBackground(horizon: 0.82)
        .sensoryFeedback(.success, trigger: aligned) { _, new in new }
        .onAppear { model.location.beginHeading() }
        .onDisappear { model.location.endHeading() }
        .onChange(of: compass) { _, c in
            guard case let .live(h, acc, _) = c, let b = snap.qiblaBearing else { aligned = false; return }
            _ = detector.update(relativeDeg: Angles.relativeToQibla(qiblaBearingTrue: b, headingTrue: h), accuracyDeg: acc)
            aligned = detector.aligned
        }
    }

    private func info(_ text: String) -> some View {
        Text(text).font(.footnote.weight(.medium)).padding(.horizontal, 12).padding(.vertical, 8).glass(Capsule())
    }
}
