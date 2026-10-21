import SwiftUI

/// The welcome tour: six screens on the first run, saying what the app does
/// and where the main things are, with the language and the look chosen on
/// the way (the tour changes as they are picked). Skippable from the first
/// screen, shown once (the answer is kept in the app's own defaults), and
/// openable again from Settings. Every line of it is about something the app
/// does today — there is nothing here to look forward to. It moves as the
/// desktop's tour does: the logo breathes, each screen's symbol comes alive
/// and its points rise in one after another; Reduce Motion keeps it still.
struct OnboardingView: View {
    /// Called when the person has finished or skipped it.
    let onFinish: () -> Void
    @State private var page = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection

    /// The screens, in order.
    static let screens: [OnboardingScreen] = [
        OnboardingScreen(
            symbol: nil,
            title: "Welcome to \(AppName.isolated)",
            message: "Open a PDF from Files or from your own library and read it as it was written — Arabic in its own order, right to left, page by page.",
            points: [
                OnboardingPoint(symbol: "text.alignright", text: "Arabic read and searched properly, tashkeel and all"),
                OnboardingPoint(symbol: "lock.shield", text: "No account, and nothing ever leaves this device"),
            ]
        ),
        OnboardingScreen(
            symbol: "paintpalette",
            title: "Make it yours",
            message: "Choose the language and the look. The tour changes as you pick, and Settings has them again.",
            points: [],
            extra: .look
        ),
        OnboardingScreen(
            symbol: "doc.viewfinder",
            title: "Scan paper into a PDF",
            message: "Scan opens the camera straight away. Point it at the page: the edges are found, the page is straightened and the paper cleaned, and the words on it are read so the PDF can be searched.",
            points: [
                OnboardingPoint(symbol: "crop", text: "Corners found for you, or dragged by hand"),
                OnboardingPoint(symbol: "text.magnifyingglass", text: "Arabic and English read on the device itself"),
                OnboardingPoint(symbol: "person.text.rectangle", text: "Cards, passports, whiteboards and open books"),
            ]
        ),
        OnboardingScreen(
            symbol: "hand.draw",
            title: "Mark it up, and sign it",
            message: "Highlight, underline, strike through, draw, and leave notes. Draw your signature once with a finger or the Pencil and place it on any page afterwards.",
            points: [
                OnboardingPoint(symbol: "highlighter", text: "Highlights, shapes, arrows and text boxes"),
                OnboardingPoint(symbol: "signature", text: "Your signature, kept on this device only"),
            ]
        ),
        OnboardingScreen(
            symbol: "square.grid.2x2",
            title: "Organize, export, protect",
            message: "Reorder, rotate, crop and delete pages, or combine files into one. Export to Word, plain text, pictures or PDF/A, and set a password on what should have one.",
            points: [
                OnboardingPoint(symbol: "books.vertical", text: "A library you can search across every document"),
                OnboardingPoint(symbol: "lock", text: "A password on the file, and Face ID on the app"),
            ]
        ),
        OnboardingScreen(
            symbol: "iphone.radiowaves.left.and.right",
            title: "Your phone as a remote",
            message: "On a Windows PC or a Mac with \(AppName.isolated), open Phone remote there, then scan its code from Phone remote in your Library.",
            points: [
                OnboardingPoint(symbol: "rectangle.on.rectangle", text: "Move through slides while you present"),
                OnboardingPoint(symbol: "arrow.up.arrow.down", text: "Send files and signatures both ways"),
                OnboardingPoint(symbol: "wifi", text: "The phone and the computer on the same Wi-Fi"),
            ]
        ),
    ]

    private var isLast: Bool { page >= Self.screens.count - 1 }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TabView(selection: $page) {
                    ForEach(Array(Self.screens.enumerated()), id: \.offset) { index, screen in
                        OnboardingPage(screen: screen, isCurrent: index == page)
                            .tag(index)
                            .accessibilityIdentifier("onboarding.page.\(index)")
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .always))
                .indexViewStyle(.page(backgroundDisplayMode: .always))
                // Two buttons rather than one whose identifier changes under
                // it: the last screen's is a different control, and a test
                // finding it by name should not depend on SwiftUI reusing a
                // view it has already made.
                if isLast {
                    button("Start", identifier: "onboarding.done", action: onFinish)
                } else {
                    button("Next", identifier: "onboarding.next") {
                        withAnimation(Motion.travel(reduceMotion: reduceMotion)) { page += 1 }
                    }
                }
            }
            .themedGround(systemColour: Surface.grouped)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Skip", action: onFinish)
                        .accessibilityIdentifier("onboarding.skip")
                }
            }
        }
        .accessibilityIdentifier("onboarding")
        .sensoryFeedback(.selection, trigger: page)
    }

    /// The one wide button along the bottom.
    private func button(_ title: LocalizedStringKey, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .themeFont(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.x2)
        }
        .buttonStyle(.themedProminent)
        .controlSize(.large)
        .padding(.horizontal, Space.x7)
        .padding(.top, Space.x5)
        .padding(.bottom, Space.x8)
        .accessibilityIdentifier(identifier)
    }
}

/// One screen of the tour.
struct OnboardingScreen {
    /// The SF Symbol over the screen; nil for the first, which carries the
    /// logo instead.
    let symbol: String?
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    let points: [OnboardingPoint]
    /// Controls on the screen itself, under its paragraph.
    var extra: OnboardingExtra = .none
}

/// What a screen holds besides its words.
enum OnboardingExtra {
    case none
    /// The language, light or dark, and the theme, as Settings has them.
    case look
}

/// A line under a screen's paragraph: a symbol and a few words.
struct OnboardingPoint: Identifiable {
    let symbol: String
    let text: LocalizedStringKey

    var id: String { symbol }
}

private struct OnboardingPage: View {
    let screen: OnboardingScreen
    /// Whether this is the screen showing: its points rise in as it comes.
    let isCurrent: Bool
    @Environment(\.appTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(SettingsKey.language) private var language: AppLanguage = .system
    @AppStorage(SettingsKey.appearance) private var appearance: AppAppearance = .system
    @AppStorage(SettingsKey.theme) private var chosenTheme: AppTheme = .standard

    /// Points are shown once their screen is; without motion, always.
    private var shown: Bool { isCurrent || reduceMotion }

    var body: some View {
        ScrollView {
            VStack(spacing: Space.x7) {
                header
                VStack(spacing: Space.x4) {
                    Text(screen.title)
                        .themeFont(.largeTitle)
                        .foregroundStyle(Surface.label)
                        .multilineTextAlignment(.center)
                    Text(screen.message)
                        .themeFont(.body)
                        .foregroundStyle(Surface.secondaryLabel)
                        .multilineTextAlignment(.center)
                }
                if screen.extra == .look {
                    lookChoices
                }
                if !screen.points.isEmpty {
                    VStack(alignment: .leading, spacing: Space.x5) {
                        ForEach(Array(screen.points.enumerated()), id: \.element.id) { index, point in
                            Label {
                                Text(point.text)
                                    .themeFont(.callout)
                                    .foregroundStyle(Surface.label)
                                    .fixedSize(horizontal: false, vertical: true)
                            } icon: {
                                Image(systemName: point.symbol)
                                    .font(.title3.weight(theme == .zood ? .light : .regular))
                                    .foregroundStyle(.tint)
                                    .frame(width: 30)
                            }
                            .opacity(shown ? 1 : 0)
                            .offset(y: shown ? 0 : 12)
                            .animation(reduceMotion ? nil : Motion.flick.delay(0.15 + Double(index) * 0.09), value: shown)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Space.x6)
                    .background(Surface.groupedCell, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                }
                Spacer(minLength: Space.x9)
            }
            .padding(.horizontal, Space.x7)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .accessibilityElement(children: .contain)
    }

    /// The first screen carries ZOOD's logo — the app is ZOOD's — with the
    /// brand's three-line element over it on ZOOD's own theme; the others
    /// carry the symbol of what they are about, in a thin line.
    @ViewBuilder
    private var header: some View {
        if let symbol = screen.symbol {
            Image(systemName: symbol)
                .font(.system(size: 72, weight: theme == .zood ? .ultraLight : .light))
                .foregroundStyle(.tint)
                // A bounce as the screen comes, then a slow breath while it stays.
                .symbolEffect(.bounce, value: isCurrent)
                .symbolEffect(.breathe, isActive: isCurrent && !reduceMotion)
                .padding(.top, Space.x9)
                .accessibilityHidden(true)
        } else {
            VStack(spacing: 0) {
                if theme == .zood {
                    ZoodPattern(kind: .lines)
                        .frame(width: 64, height: 88)
                        .clipped()
                        .mask(LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom))
                }
                ZoodLogo(kind: .vertical, height: 132)
                    .modifier(Breathing(active: !reduceMotion))
                    .accessibilityIdentifier("onboarding.logo")
            }
            .padding(.top, theme == .zood ? Space.x4 : Space.x8)
        }
    }
}

private extension OnboardingPage {
    /// The language, light or dark, and the theme: chosen here, the tour
    /// itself changes at once, as the whole app does.
    var lookChoices: some View {
        VStack(alignment: .leading, spacing: Space.x6) {
            Picker("Language", selection: $language) {
                ForEach(AppLanguage.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("onboarding.language")
            Picker("Appearance", selection: $appearance) {
                ForEach(AppAppearance.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("onboarding.appearance")
            Picker("Theme", selection: $chosenTheme) {
                ForEach(AppTheme.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("onboarding.theme")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.x6)
        .background(Surface.groupedCell, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .opacity(shown ? 1 : 0)
        .offset(y: shown ? 0 : 12)
        .animation(reduceMotion ? nil : Motion.flick.delay(0.15), value: shown)
    }
}

/// ZOOD's logo breathing slowly, round and round, while the first screen shows.
private struct Breathing: ViewModifier {
    let active: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if active {
            content.phaseAnimator([false, true]) { view, out in
                view
                    .scaleEffect(out ? 1.03 : 1)
                    .opacity(out ? 1 : 0.9)
            } animation: { _ in
                .easeInOut(duration: 2.4)
            }
        } else {
            content
        }
    }
}

extension SettingsKey {
    /// Whether the welcome tour has been finished or skipped on this device.
    static let onboardingSeen = "onboardingSeen"
}

/// When the welcome tour is shown. A Debug build leaves it out unless a UI test
/// asks for it (`-warraqOnboarding show` to start it over, `keep` to let the
/// kept answer decide): every other UI test launches into the Library, and a
/// tour over the top of it would be the first thing each of them found.
enum Onboarding {
    static func shouldShow(seen: Bool) -> Bool {
        #if DEBUG
        switch UserDefaults.standard.string(forKey: "warraqOnboarding") {
        case "show": return true
        case "keep": return !seen
        default: return false
        }
        #else
        return !seen
        #endif
    }
}
