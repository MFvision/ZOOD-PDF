import NMCore
import SwiftUI

func qiblaGuidance(_ compass: CompassState, bearing: Double, l10n: Localization) -> String {
    switch compass {
    case .bearingOnly:
        return l10n.t("qibla_no_sensor", Format.degrees(bearing, locale: l10n.locale))
    case let .live(heading, _, calibrate):
        let rel = Angles.relativeToQibla(qiblaBearingTrue: bearing, headingTrue: heading)
        if calibrate { return l10n.t("qibla_calibrate") }
        if abs(rel) <= 5 { return l10n.t("qibla_aligned") }
        let deg = Format.degrees(abs(rel), locale: l10n.locale)
        return rel > 0 ? l10n.t("qibla_turn_right", deg) : l10n.t("qibla_turn_left", deg)
    }
}

struct QiblaCard: View {
    @Environment(Localization.self) private var l10n
    @Environment(\.colorScheme) private var scheme
    let snap: PrayerSnapshot
    let compass: CompassState
    let aligned: Bool
    var onOpen: () -> Void

    var body: some View {
        if let bearing = snap.qiblaBearing {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(l10n.t("qibla")).font(.headline).accessibilityAddTraits(.isHeader)
                        Text(l10n.t("qibla_bearing", Format.degrees(bearing, locale: l10n.locale)))
                        if let d = snap.qiblaDistance {
                            Text(l10n.t("qibla_distance", Format.distance(d, l10n: l10n))).font(.subheadline).foregroundStyle(.secondary)
                        }
                        Text(qiblaGuidance(compass, bearing: bearing, l10n: l10n)).font(.subheadline).foregroundStyle(Theme.accentText(scheme))
                    }
                    Spacer()
                    QiblaDial(bearing: bearing, compass: compass, aligned: aligned).frame(width: 96, height: 96)
                }
                Button(action: onOpen) {
                    Label(l10n.t("qibla_open_compass"), systemImage: "location.north.circle").frame(maxWidth: .infinity, minHeight: 44)
                }
                .prominentButton()
            }
            .card()
            .padding(.horizontal)
        }
    }
}

/// Live: the ring turns so N points to true north and the gold arrow sits at the Qibla bearing on the
/// ring, both by the shortest path across 359°/0°. Bearing-only: fixed north-up diagram.
/// Compass geometry never mirrors with RTL text.
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
                if aligned { Circle().fill(Theme.gold.opacity(0.35)).blur(radius: 12) }
                Circle().fill(Color.primary.opacity(0.06))
                Circle().stroke(Color.primary.opacity(0.35), lineWidth: 1.5)
                ZStack {
                    ForEach(0..<72, id: \.self) { i in
                        Rectangle().fill(Color.primary.opacity(i % 18 == 0 ? 0.7 : 0.25))
                            .frame(width: i % 18 == 0 ? 2 : 1, height: size * (i % 18 == 0 ? 0.08 : 0.04))
                            .offset(y: -size / 2 + size * 0.04 + 2)
                            .rotationEffect(.degrees(Double(i) * 5))
                    }
                    Text(l10n.t("compass_north")).font(.system(size: size * 0.13, weight: .bold)).foregroundStyle(.red)
                        .offset(y: -size / 2 + size * 0.2)
                    // Qibla arrow fixed to the ring at the true bearing.
                    ZStack {
                        Capsule().fill(Theme.gold).frame(width: 5, height: size * 0.41).offset(y: -size * 0.205)
                        Circle().fill(Theme.gold).frame(width: 14, height: 14).offset(y: -size * 0.41)
                    }
                    .rotationEffect(.degrees(bearing))
                }
                .rotationEffect(.degrees(ring))
                if case .live = compass {
                    Capsule().fill(Color.primary.opacity(0.6)).frame(width: 3, height: 12).offset(y: -size / 2 + 4)
                }
                Circle().fill(Theme.navy).frame(width: 12, height: 12)
            }
            .frame(width: size, height: size)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
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

/// Full-screen compass. Heading runs only while visible.
struct QiblaCompassView: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var detector = AlignmentDetector()
    @State private var aligned = false

    var body: some View {
        let snap = PrayerSnapshot(model: model, now: Date())
        let compass = model.location.compass
        VStack(spacing: 16) {
            HStack {
                Text(l10n.t("qibla")).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                    .accessibilityLabel(l10n.t("close"))
                    .glassChrome(cornerRadius: 22)
            }
            Text(snap.location?.name ?? "").foregroundStyle(.secondary)
            if let bearing = snap.qiblaBearing {
                QiblaDial(bearing: bearing, compass: compass, aligned: aligned).frame(maxWidth: 420).padding(.horizontal, 24)
                Text(qiblaGuidance(compass, bearing: bearing, l10n: l10n)).font(.title2.weight(.semibold)).multilineTextAlignment(.center)
                    .foregroundStyle(aligned ? Theme.accentText(scheme) : .primary)
                    .accessibilityAddTraits(.updatesFrequently)
                Text(l10n.t("qibla_bearing", Format.degrees(bearing, locale: l10n.locale)))
                switch compass {
                case let .live(_, accuracy, _):
                    if let a = accuracy { Text(l10n.t("heading_accuracy", Format.degrees(a, locale: l10n.locale))).font(.subheadline).foregroundStyle(.secondary) }
                case .bearingOnly:
                    Text(l10n.t("qibla_north_up")).font(.subheadline).foregroundStyle(.secondary)
                }
                Text(l10n.t("qibla_hold_flat") + " · " + l10n.t("qibla_approximate")).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            } else {
                Text(l10n.t("qibla_location_needed"))
            }
            Spacer()
        }
        .padding(20)
        .sensoryFeedback(.success, trigger: aligned) { _, new in new }
        .onAppear { model.location.beginHeading() }
        .onDisappear { model.location.endHeading() }
        .onChange(of: compass) { _, c in
            guard case let .live(h, acc, _) = c, let b = snap.qiblaBearing else { aligned = false; return }
            _ = detector.update(relativeDeg: Angles.relativeToQibla(qiblaBearingTrue: b, headingTrue: h), accuracyDeg: acc)
            aligned = detector.aligned
        }
    }
}
