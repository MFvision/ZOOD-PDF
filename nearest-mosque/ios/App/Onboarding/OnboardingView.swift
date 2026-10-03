import NMCore
import SwiftUI

/// First-launch tour on the sky: five animated pages that show how each part works, then a setup page
/// for language and prayer location. Swipe or use the glass buttons; Skip finishes at any time.
/// Under Reduce Motion every illustration shows its final, still frame.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var page = min(5, max(0, UserDefaults.standard.integer(forKey: "demoOnboardingPage")))
    private let count = 6

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                if page < count - 1 {
                    Button(l10n.t("onb_skip")) { finish() }.glassButton()
                }
            }
            .frame(height: 48)
            .padding(.horizontal, 20)

            TabView(selection: $page) {
                OnboardingPage(title: l10n.t("onb_welcome_title"), message: l10n.t("onb_welcome_body")) { WelcomeArt() }.tag(0)
                OnboardingPage(title: l10n.t("onb_prayer_title"), message: l10n.t("onb_prayer_body")) { PrayerArt() }.tag(1)
                OnboardingPage(title: l10n.t("onb_qibla_title"), message: l10n.t("onb_qibla_body")) { QiblaArt() }.tag(2)
                OnboardingPage(title: l10n.t("onb_mosque_title"), message: l10n.t("onb_mosque_body")) { MosqueArt() }.tag(3)
                OnboardingPage(title: l10n.t("onb_ask_title"), message: l10n.t("onb_ask_body")) { AskArt() }.tag(4)
                SetupPage().tag(5)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            HStack {
                if page > 0 {
                    Button { withAnimation(Theme.spring) { page -= 1 } } label: {
                        Image(systemName: l10n.isRTL ? "chevron.right" : "chevron.left").frame(width: 24, height: 30)
                    }
                    .glassButton()
                    .accessibilityLabel(l10n.t("onb_back"))
                } else {
                    Color.clear.frame(width: 56, height: 44)
                }
                Spacer()
                PageDots(count: count, index: page)
                Spacer()
                Button {
                    if page == count - 1 { finish() } else { withAnimation(Theme.spring) { page += 1 } }
                } label: {
                    Text(l10n.t(page == count - 1 ? "onb_start" : "onb_next")).frame(minWidth: 72, minHeight: 30)
                }
                .prominentButton()
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
        .foregroundStyle(.white)
        .skyBackground(horizon: 0.8)
    }

    private func finish() {
        model.settings.onboarded = true
        dismiss()
    }
}

private struct PageDots: View {
    @Environment(Localization.self) private var l10n
    let count: Int
    let index: Int
    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { i in
                Capsule().fill(i == index ? Theme.gold : .white.opacity(0.4))
                    .frame(width: i == index ? 22 : 7, height: 7)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .glass(Capsule())
        .animation(Theme.spring, value: index)
        .accessibilityElement()
        .accessibilityLabel(l10n.t("onb_page_a11y", index + 1, count))
    }
}

private struct OnboardingPage<Art: View>: View {
    let title: String
    let message: String
    @ViewBuilder var art: Art

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                art.frame(height: 300).frame(maxWidth: 420)
                Text(title).font(.largeTitle.bold()).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
                Text(message).font(.title3).multilineTextAlignment(.center).foregroundStyle(.white.opacity(0.88))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 28)
            .padding(.top, 8)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
    }
}

/// Drives a looping illustration with a phase in 0…1; still at 1 under Reduce Motion.
private struct Loop<Content: View>: View {
    let period: Double
    let content: (Double) -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(period: Double, @ViewBuilder content: @escaping (Double) -> Content) {
        self.period = period; self.content = content
    }

    var body: some View {
        if reduceMotion {
            content(1)
        } else {
            TimelineView(.animation) { ctx in
                content(ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period)
            }
        }
    }
}

private func ease(_ x: Double) -> Double { let t = min(1, max(0, x)); return t * t * (3 - 2 * t) }

private struct WelcomeArt: View {
    var body: some View {
        Loop(period: 3.2) { p in
            ZStack {
                ForEach(0..<3, id: \.self) { i in
                    let k = (p + Double(i) / 3).truncatingRemainder(dividingBy: 1)
                    Circle().stroke(Theme.gold.opacity(0.6 * (1 - k)), lineWidth: 2)
                        .frame(width: 110 + 160 * k, height: 110 + 160 * k)
                }
                LogoDisc(size: 110, glow: true)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct PrayerArt: View {
    @Environment(Localization.self) private var l10n
    var body: some View {
        Loop(period: 6) { p in
            VStack(spacing: 14) {
                ZStack {
                    Circle().trim(from: 0.55, to: 0.95).stroke(.white.opacity(0.4), lineWidth: 2).frame(width: 220, height: 220).rotationEffect(.degrees(0))
                    let a = (-72 + 144 * ease(p)) * .pi / 180
                    Circle().fill(Theme.gold).frame(width: 18, height: 18)
                        .shadow(color: Theme.gold, radius: 10)
                        .offset(x: 110 * sin(a), y: -110 * cos(a))
                }
                .frame(height: 120)
                .offset(y: 40)
                VStack(spacing: 4) {
                    let events: [PrayerEvent] = [.fajr, .dhuhr, .asr, .maghrib, .isha]
                    let active = min(4, Int(p * 5))
                    ForEach(Array(events.enumerated()), id: \.offset) { i, e in
                        HStack {
                            Image(systemName: Theme.icon(e)).frame(width: 24)
                            Text(l10n.t(Format.prayerKey(e)))
                            Spacer()
                        }
                        .font(.subheadline.weight(i == active ? .semibold : .regular))
                        .foregroundStyle(i == active ? Theme.gold : .white.opacity(0.85))
                        .padding(.horizontal, 14).frame(height: 30)
                        .background(i == active ? Theme.gold.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                .padding(8)
                .frame(width: 240)
                .glassCard(padding: 4)
                .frame(width: 250)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct QiblaArt: View {
    var body: some View {
        Loop(period: 5) { p in
            let angle = p < 0.65 ? 75 * (1 - ease(p / 0.65)) : 0
            QiblaArc(angle: angle, mode: .live, aligned: p >= 0.65, springs: false) {
                Image(systemName: "iphone").font(.system(size: 64, weight: .thin))
                    .rotationEffect(.degrees(-angle * 0.4))
                    .offset(y: 30)
            }
            .frame(width: 280)
        }
        .accessibilityHidden(true)
    }
}

private struct MosqueArt: View {
    private let pins: [(x: CGFloat, y: CGFloat)] = [(0.72, 0.28), (0.25, 0.32), (0.78, 0.7), (0.3, 0.74), (0.55, 0.15)]
    var body: some View {
        Loop(period: 5) { p in
            GeometryReader { geo in
                let s = min(geo.size.width, geo.size.height)
                ZStack {
                    ForEach(1...3, id: \.self) { k in
                        Circle().stroke(.white.opacity(0.22), lineWidth: 1).frame(width: s * CGFloat(k) / 3, height: s * CGFloat(k) / 3)
                    }
                    Path { path in
                        path.move(to: CGPoint(x: s / 2, y: s / 2))
                        path.addLine(to: CGPoint(x: pins[0].x * s, y: pins[0].y * s))
                    }
                    .trim(from: 0, to: ease((p - 0.45) / 0.3))
                    .stroke(Theme.gold, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [6, 6]))
                    ForEach(Array(pins.enumerated()), id: \.offset) { i, pin in
                        let shown = ease((p - Double(i) * 0.07) / 0.15)
                        ZStack {
                            Circle().fill(i == 0 ? Theme.gold : Theme.navy).frame(width: 36, height: 36)
                            MosqueGlyph().fill(.white).frame(width: 20, height: 20)
                        }
                        .overlay(Circle().stroke(.white, lineWidth: 2))
                        .scaleEffect(shown * (i == 0 && p > 0.75 ? 1.2 : 1))
                        .position(x: pin.x * s, y: pin.y * s)
                    }
                    Circle().fill(Color(hex: 0x4F8EF7)).frame(width: 16, height: 16).overlay(Circle().stroke(.white, lineWidth: 3))
                        .position(x: s / 2, y: s / 2)
                }
                .frame(width: s, height: s)
                .glass(Circle())
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct AskArt: View {
    @Environment(Localization.self) private var l10n
    var body: some View {
        Loop(period: 6) { p in
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Spacer()
                    Text(l10n.t("onb_demo_question")).font(.subheadline)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .glass(RoundedRectangle(cornerRadius: 18, style: .continuous), tint: Theme.navy.opacity(0.5))
                }
                .opacity(ease(p / 0.15))
                .offset(y: 12 * (1 - ease(p / 0.15)))
                if p > 0.2 && p < 0.4 {
                    HStack(spacing: 6) {
                        ForEach(0..<3, id: \.self) { i in
                            Circle().fill(.white).frame(width: 7, height: 7)
                                .opacity(0.3 + 0.7 * abs(sin((p * 20 + Double(i)) * 1.2)))
                        }
                    }
                    .padding(12).glass(Capsule())
                }
                VStack(alignment: .leading, spacing: 6) {
                    Label("Qur’an 13:28", systemImage: "book.closed").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.gold)
                    Text(l10n.t("supporting_passage")).font(.caption).foregroundStyle(.white.opacity(0.7))
                    Text("أَلَا بِذِكْرِ اللَّهِ تَطْمَئِنُّ الْقُلُوبُ").font(.title3)
                        .environment(\.layoutDirection, .rightToLeft)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .glassCard()
                .opacity(ease((p - 0.4) / 0.15))
                .offset(y: 20 * (1 - ease((p - 0.4) / 0.15)))
            }
            .frame(width: 300)
        }
        .accessibilityHidden(true)
    }
}

/// Last page: language and prayer location, both changeable later in Settings.
private struct SetupPage: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @State private var showCity = false
    @State private var locating = false
    @State private var error: String?

    var body: some View {
        @Bindable var l10n = l10n
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(l10n.t("onb_setup_title")).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                Text(l10n.t("onb_setup_body")).font(.body).foregroundStyle(.white.opacity(0.88))
                Text(l10n.t("language")).font(.headline)
                FlowLayout(spacing: 8) {
                    ForEach(Localization.supported, id: \.self) { code in
                        let selected = l10n.language == code
                        Button { l10n.override = code } label: {
                            Text(Localization.nativeNames[code] ?? code).font(.subheadline.weight(selected ? .semibold : .regular))
                                .padding(.horizontal, 14).frame(minHeight: 44)
                                .foregroundStyle(selected ? Theme.navyNight : .white)
                                .background(selected ? Theme.gold : .clear, in: Capsule())
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .glass(Capsule())
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                Text(l10n.t("location_section")).font(.headline).padding(.top, 6)
                if let loc = model.settings.location {
                    Label(l10n.t("onb_location_set", loc.name), systemImage: "checkmark.circle.fill")
                        .foregroundStyle(Theme.gold).font(.body.weight(.semibold))
                }
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
                        Button { showCity = true } label: {
                            Label(l10n.t("search_city"), systemImage: "magnifyingglass").frame(maxWidth: .infinity, minHeight: 32)
                        }
                        .glassButton()
                    }
                }
                if let error { Text(error).font(.footnote).foregroundStyle(Color(hex: 0xF2B8B5)) }
                Text(l10n.t("online_search_body")).font(.footnote).foregroundStyle(.white.opacity(0.75))
            }
            .padding(.horizontal, 24)
            .padding(.top, 8)
        }
        .sheet(isPresented: $showCity) { CityPickerView() }
    }
}
