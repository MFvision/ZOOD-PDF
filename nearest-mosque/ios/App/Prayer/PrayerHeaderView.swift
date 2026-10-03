import NMCore
import SwiftUI
import UIKit

/// Expanded / home header: atmospheric sky, translucent arc whose gold marker is the elapsed fraction
/// of the current prayer period, and (expanded) the central logo disc that glows only when the phone
/// faces the Qibla. Reversible via scrolling and the explicit chevron.
struct PrayerHeaderView: View {
    @Environment(Localization.self) private var l10n
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let snap: PrayerSnapshot
    let expanded: Bool
    let collapse: CGFloat
    let aligned: Bool
    var onToggle: () -> Void
    var onSettings: () -> Void

    var body: some View {
        let next = snap.next
        let zone = snap.location?.zone ?? .current
        let name = next.map { l10n.t(Format.prayerKey($0.event)) }
        let time = next.map { Format.time($0.at, zone: zone, locale: l10n.locale) }
        let remaining = next.map { Format.countdown(PrayerCalculator.remaining(snap.now, $0.at), locale: l10n.locale) }
        ZStack(alignment: .top) {
            LinearGradient(colors: Theme.sky(snap.current), startPoint: .top, endPoint: .bottom)
            ProgressArc(progress: snap.progress, rtl: l10n.isRTL, glow: aligned ? 1 : 0.35)
                .animation(reduceMotion ? nil : .spring(response: 0.8), value: snap.progress)
            VStack(spacing: 4) {
                HStack {
                    Button(action: onToggle) { Image(systemName: expanded ? "chevron.up" : "chevron.down").frame(width: 44, height: 44) }
                        .accessibilityLabel(l10n.t(expanded ? "collapse" : "expand"))
                    Spacer()
                    Button(action: onSettings) { Image(systemName: "gearshape").frame(width: 44, height: 44) }
                        .accessibilityLabel(l10n.t("settings"))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                Spacer(minLength: 0)
                VStack(spacing: 4) {
                    if let name, let time, let remaining {
                        Text(l10n.t("next_prayer")).font(.subheadline).foregroundStyle(.white.opacity(0.85))
                        Text(name).font(.system(size: 44, weight: .semibold)).foregroundStyle(.white).minimumScaleFactor(0.6).lineLimit(1)
                        Text(time).font(.title2).foregroundStyle(.white)
                        Text(l10n.t("countdown_in", remaining)).font(.headline).monospacedDigit().foregroundStyle(Theme.gold)
                            .contentTransition(reduceMotion ? .identity : .numericText(countsDown: true))
                    } else {
                        Image("LogoMark").resizable().scaledToFit().frame(width: 72, height: 72)
                        Text(l10n.t("app_name")).font(.title.weight(.semibold)).foregroundStyle(.white)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityAddTraits(.isHeader)
                .accessibilityLabel(name.map { l10n.t("countdown_a11y", $0, time ?? "", remaining ?? "") } ?? l10n.t("app_name"))
                if expanded, next != nil {
                    Image("LogoMark").resizable().scaledToFit().frame(width: 58, height: 58)
                        .frame(width: 84, height: 84)
                        .background(.white.opacity(aligned ? 0.43 : 0.2), in: Circle())
                        .shadow(color: Theme.gold.opacity(aligned ? 0.6 : 0), radius: 18)
                        .padding(.top, 16)
                        .transition(.scale.combined(with: .opacity))
                        .accessibilityHidden(true)
                }
                Spacer(minLength: 12)
            }
            .padding(.top, topInset)
        }
        .frame(height: (expanded ? Theme.expandedHeader : Theme.homeHeader) + topInset)
        .opacity(1 - collapse * 0.6)
    }

    private var topInset: CGFloat {
        (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.windows.first?.safeAreaInsets.top ?? 44
    }
}

/// The arc and its gold time-progress marker. Geometry is drawn, not mirrored by layout; in RTL the
/// progress runs right-to-left to match reading direction.
struct ProgressArc: View, Animatable {
    var progress: Double
    let rtl: Bool
    let glow: Double
    var animatableData: Double { get { progress } set { progress = newValue } }

    var body: some View {
        Canvas { ctx, size in
            let r = min(size.width * 0.42, size.height * 0.62)
            let c = CGPoint(x: size.width / 2, y: size.height * 0.70)
            func point(_ deg: Double) -> CGPoint { CGPoint(x: c.x + r * cos(deg * .pi / 180), y: c.y + r * sin(deg * .pi / 180)) }
            var base = Path(); base.addArc(center: c, radius: r, startAngle: .degrees(200), endAngle: .degrees(340), clockwise: false)
            ctx.stroke(base, with: .color(.white.opacity(0.22)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
            let sweep = 140 * progress
            let start = rtl ? 340 - sweep : 200
            var done = Path(); done.addArc(center: c, radius: r, startAngle: .degrees(start), endAngle: .degrees(start + sweep), clockwise: false)
            ctx.stroke(done, with: .color(Theme.gold.opacity(0.85)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
            let m = point(rtl ? 340 - sweep : 200 + sweep)
            ctx.fill(Path(ellipseIn: CGRect(x: m.x - 18, y: m.y - 18, width: 36, height: 36)),
                     with: .radialGradient(Gradient(colors: [Theme.gold.opacity(0.55), .clear]), center: m, startRadius: 0, endRadius: 18))
            ctx.fill(Path(ellipseIn: CGRect(x: m.x - 6, y: m.y - 6, width: 12, height: 12)), with: .color(Theme.gold))
            ctx.fill(Path(ellipseIn: CGRect(x: c.x - r * 0.55, y: c.y - r * 0.55, width: r * 1.1, height: r * 1.1)),
                     with: .radialGradient(Gradient(colors: [.white.opacity(0.3 * glow), .clear]), center: c, startRadius: 0, endRadius: r * 0.55))
        }
        .accessibilityHidden(true)
    }
}

/// Compact sticky summary while scrolling: event, countdown and a small direction indicator.
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
                    Text(l10n.t("countdown_in", Format.countdown(PrayerCalculator.remaining(snap.now, next.at), locale: l10n.locale)))
                        .font(.subheadline).monospacedDigit().foregroundStyle(Theme.gold)
                }
                Spacer()
                if let b = snap.qiblaBearing { MiniQiblaIndicator(bearing: b, compass: compass).frame(width: 40, height: 40) }
                Button(action: onExpand) { Image(systemName: "chevron.down").frame(width: 44, height: 44) }
                    .accessibilityLabel(l10n.t("expand"))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .frame(maxWidth: .infinity, minHeight: Theme.compactHeader - 16)
            .background(LinearGradient(colors: Theme.sky(snap.current), startPoint: .leading, endPoint: .trailing).ignoresSafeArea(edges: .top))
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
            Circle().fill(.white.opacity(0.16))
            Circle().stroke(.white.opacity(0.5), lineWidth: 1)
            if !live { Circle().fill(.white).frame(width: 4, height: 4).offset(y: -16) }
            Capsule().fill(Theme.gold).frame(width: 3, height: 15).offset(y: -7.5).rotationEffect(.degrees(angle))
        }
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityElement()
        .accessibilityLabel(l10n.t("qibla") + ", " + l10n.t("qibla_bearing", Format.degrees(bearing, locale: l10n.locale)))
    }
}
