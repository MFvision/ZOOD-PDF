import NMCore
import SwiftUI
import UIKit

/// Top of Prayer & Qibla: glass location pill and gear, the Qibla arc with the brand disc at the top
/// and the next prayer inside, and quick facts. The gold dot on the arc is where the Qibla is relative
/// to the top of the phone; when it meets the disc the phone faces the Qibla and the disc glows.
/// Without a live true heading the arc is north-up and the dot is the bearing from true north.
struct PrayerHero: View {
    @Environment(Localization.self) private var l10n
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let snap: PrayerSnapshot
    let compass: CompassState
    let aligned: Bool
    var onLocation: () -> Void
    var onSettings: () -> Void
    var onQibla: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Color.clear.frame(width: 44, height: 44)
                Spacer()
                LocationPill(name: snap.location?.name ?? l10n.t("choose_city_title"), action: onLocation)
                Spacer()
                GlassIconButton(systemImage: "gearshape", label: l10n.t("settings"), action: onSettings)
            }
            .padding(.top, 4)

            QiblaArc(angle: dotAngle, mode: arcMode, aligned: aligned) {
                arcContent
            }
            .contentShape(Rectangle())
            .onTapGesture { if snap.location != nil { onQibla() } }
            .accessibilityElement(children: .contain)

            if let bearing = snap.qiblaBearing {
                GlassGroup(spacing: 8) {
                    HStack(spacing: 8) {
                        chip(l10n.t("qibla_bearing", Format.degrees(bearing, locale: l10n.locale)), "location.north.line")
                        if let d = snap.qiblaDistance { chip(l10n.t("qibla_distance", Format.distance(d, l10n: l10n)), "point.topleft.down.to.point.bottomright.curvepath") }
                    }
                }
                Button(action: onQibla) {
                    Label(l10n.t("qibla_open_compass"), systemImage: "safari").frame(minHeight: 30)
                }
                .glassButton()
                .padding(.top, 2)
            }
        }
        .foregroundStyle(.white)
    }

    private func chip(_ text: String, _ icon: String) -> some View {
        Label(text, systemImage: icon)
            .font(.footnote.weight(.medium)).lineLimit(1).minimumScaleFactor(0.8)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .glass(Capsule())
    }

    private var arcMode: ArcMode {
        guard snap.qiblaBearing != nil else { return .none }
        if case .live = compass { return .live }
        return .northUp
    }

    private var dotAngle: Double {
        guard let b = snap.qiblaBearing else { return 0 }
        if case let .live(h, _, _) = compass { return Angles.relativeToQibla(qiblaBearingTrue: b, headingTrue: h) }
        return b
    }

    @ViewBuilder private var arcContent: some View {
        let zone = snap.location?.zone ?? .current
        VStack(spacing: 4) {
            if let next = snap.next {
                let name = l10n.t(Format.prayerKey(next.event))
                let time = Format.time(next.at, zone: zone, locale: l10n.locale)
                let remaining = PrayerCalculator.remaining(snap.now, next.at)
                VStack(spacing: 2) {
                    Text(name).font(.title2.weight(.medium)).foregroundStyle(.white.opacity(0.92))
                    Text(time).font(.system(size: 60, weight: .light)).monospacedDigit().minimumScaleFactor(0.5).lineLimit(1)
                        .contentTransition(.numericText())
                    Text(l10n.t("remaining_long", Format.remainingLong(remaining, locale: l10n.locale)))
                        .font(.callout).monospacedDigit().foregroundStyle(.white.opacity(0.85))
                        .contentTransition(reduceMotion ? .identity : .numericText(countsDown: true))
                }
                .accessibilityElement(children: .ignore)
                .accessibilityAddTraits(.isHeader)
                .accessibilityLabel(l10n.t("countdown_a11y", name, time, Format.countdown(remaining, locale: l10n.locale)))
            } else if snap.location == nil {
                Text(l10n.t("app_name")).font(.largeTitle.weight(.semibold))
            }
            if snap.qiblaBearing != nil {
                Text(guidance).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                    .foregroundStyle(aligned ? Theme.gold : .white)
                    .padding(.top, 14)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityAction { onQibla() }
                if arcMode == .northUp {
                    Text(l10n.t("qibla_from_north_hint")).font(.caption).foregroundStyle(.white.opacity(0.75))
                        .multilineTextAlignment(.center).padding(.horizontal, 24)
                }
            }
        }
    }

    private var guidance: String {
        guard let b = snap.qiblaBearing else { return "" }
        switch compass {
        case .bearingOnly:
            return l10n.t("qibla_bearing", Format.degrees(b, locale: l10n.locale))
        case let .live(_, _, calibrate):
            if calibrate { return l10n.t("qibla_calibrate") }
            return l10n.t(aligned ? "qibla_you_are_facing" : "qibla_move_phone")
        }
    }
}

/// Glass capsule with the prayer location; opens the city picker.
struct LocationPill: View {
    let name: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "mappin.and.ellipse").font(.subheadline)
                Text(name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption.weight(.bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glass(Capsule())
    }
}

/// Large circle whose top is the phone's forward direction (live) or north (north-up). The disc sits
/// at the top; the gold dot sits at `angle` degrees clockwise from the top, reached along the arc by
/// the shortest path. The lower half fades out so content can sit inside. Geometry never mirrors.
enum ArcMode: Equatable { case live, northUp, none }

struct QiblaArc<Content: View>: View {
    let angle: Double
    let mode: ArcMode
    let aligned: Bool
    /// False when the caller already animates `angle` frame by frame (onboarding demo).
    var springs = true
    @ViewBuilder var content: Content
    @Environment(Localization.self) private var l10n
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown: Double = 0

    init(angle: Double, mode: ArcMode, aligned: Bool, springs: Bool = true, @ViewBuilder content: () -> Content) {
        self.angle = angle; self.mode = mode; self.aligned = aligned; self.springs = springs; self.content = content()
    }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let r = w * 0.43
            let discY = Theme.discSize / 2 + 6
            let c = CGPoint(x: w / 2, y: discY + r)
            ZStack(alignment: .top) {
                ArcLayer(angle: shown, center: c, radius: r, mode: mode, aligned: aligned)
                LogoDisc(glow: aligned).position(x: c.x, y: discY)
                if mode == .northUp {
                    Text(l10n.t("compass_north")).font(.caption.weight(.bold)).foregroundStyle(.white.opacity(0.85))
                        .position(x: c.x, y: discY + Theme.discSize / 2 + 14)
                }
                // Content starts below the disc (never overlapping it), centred inside the circle.
                content
                    .frame(width: r * 1.7)
                    .padding(.top, discY + Theme.discSize / 2 + 26)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
            .environment(\.layoutDirection, .leftToRight)
        }
        .aspectRatio(1 / 1.0, contentMode: .fit)
        .frame(maxWidth: 520)
        .onAppear { shown = angle }
        .onChange(of: angle) { _, a in
            let next = Angles.shortestTarget(current: shown, target: a)
            if reduceMotion || !springs { shown = next } else { withAnimation(.interpolatingSpring(stiffness: 140, damping: 22)) { shown = next } }
        }
    }
}

/// Animatable drawing of the arc, the trail from the disc to the dot, and the dot.
private struct ArcLayer: View, Animatable {
    var angle: Double
    let center: CGPoint
    let radius: CGFloat
    let mode: ArcMode
    let aligned: Bool
    var animatableData: Double { get { angle } set { angle = newValue } }

    var body: some View {
        Canvas { ctx, size in
            let c = center, r = radius
            var circle = Path()
            circle.addEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
            ctx.stroke(circle, with: .linearGradient(Gradient(stops: [
                .init(color: .white.opacity(0.55), location: 0),
                .init(color: .white.opacity(0.22), location: 0.45),
                .init(color: .white.opacity(0.0), location: 0.8),
            ]), startPoint: CGPoint(x: c.x, y: c.y - r), endPoint: CGPoint(x: c.x, y: c.y + r)), lineWidth: 1.5)

            if aligned {
                for side in [-1.0, 1.0] {
                    var glow = Path()
                    glow.addArc(center: c, radius: r, startAngle: .degrees(-90), endAngle: .degrees(-90 + side * 38), clockwise: side < 0)
                    ctx.stroke(glow, with: .color(Theme.gold.opacity(0.9)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                }
            }
            guard mode != .none else { return }
            let rel = Angles.normalize180(angle)
            var trail = Path()
            trail.addArc(center: c, radius: r, startAngle: .degrees(-90), endAngle: .degrees(-90 + rel), clockwise: rel < 0)
            ctx.stroke(trail, with: .color(.white.opacity(0.75)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
            let rad = angle * .pi / 180
            let m = CGPoint(x: c.x + r * sin(rad), y: c.y - r * cos(rad))
            ctx.fill(Path(ellipseIn: CGRect(x: m.x - 22, y: m.y - 22, width: 44, height: 44)),
                     with: .radialGradient(Gradient(colors: [Theme.gold.opacity(0.6), .clear]), center: m, startRadius: 0, endRadius: 22))
            ctx.fill(Path(ellipseIn: CGRect(x: m.x - 10, y: m.y - 10, width: 20, height: 20)), with: .color(Theme.gold))
            ctx.stroke(Path(ellipseIn: CGRect(x: m.x - 10, y: m.y - 10, width: 20, height: 20)), with: .color(.white.opacity(0.85)), lineWidth: 2)
        }
        .accessibilityHidden(true)
    }
}

/// Compact glass summary pinned while scrolling: next prayer, countdown, small Qibla indicator.
struct CompactPrayerBar: View {
    @Environment(Localization.self) private var l10n
    let snap: PrayerSnapshot
    let compass: CompassState
    var onExpand: () -> Void

    var body: some View {
        if let next = snap.next, let loc = snap.location {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(l10n.t(Format.prayerKey(next.event)) + "  " + Format.time(next.at, zone: loc.zone, locale: l10n.locale)).font(.headline)
                    Text(l10n.t("remaining_long", Format.remainingLong(PrayerCalculator.remaining(snap.now, next.at), locale: l10n.locale)))
                        .font(.subheadline).monospacedDigit().foregroundStyle(Theme.gold)
                }
                Spacer()
                if let b = snap.qiblaBearing { MiniQiblaIndicator(bearing: b, compass: compass).frame(width: 40, height: 40) }
                Button(action: onExpand) { Image(systemName: "chevron.up").font(.headline).frame(width: 44, height: 44) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(l10n.t("expand"))
            }
            .foregroundStyle(.white)
            .padding(.leading, 18).padding(.trailing, 6)
            .frame(minHeight: Theme.compactHeight)
            .glass(Capsule())
        }
    }
}

/// Live: arrow to the Qibla relative to the phone. No heading: north-up diagram (north tick) with the bearing.
struct MiniQiblaIndicator: View {
    @Environment(Localization.self) private var l10n
    let bearing: Double
    let compass: CompassState

    var body: some View {
        let angle: Double = {
            if case let .live(h, _, _) = compass { return Angles.relativeToQibla(qiblaBearingTrue: bearing, headingTrue: h) }
            return bearing
        }()
        let live: Bool = { if case .live = compass { return true } else { return false } }()
        ZStack {
            Circle().stroke(.white.opacity(0.6), lineWidth: 1.5)
            if !live { Circle().fill(.white).frame(width: 4, height: 4).offset(y: -16) }
            Image(systemName: "location.north.fill").font(.system(size: 15)).foregroundStyle(Theme.gold).rotationEffect(.degrees(angle))
        }
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityElement()
        .accessibilityLabel(l10n.t("qibla") + ", " + l10n.t("qibla_bearing", Format.degrees(bearing, locale: l10n.locale)))
    }
}
