import SwiftUI

@main
struct NearMosqueApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.l10n)
                .environment(\.locale, model.l10n.locale)
                .environment(\.layoutDirection, model.l10n.layoutDirection)
                // The app always sits on a sky, so glass and text use the dark appearance.
                .preferredColorScheme(.dark)
                .task { await model.start() }
        }
    }
}

enum AppTab: Hashable { case prayer, mosques, ask }

/// Exactly three destinations on a Liquid Glass tab bar. Settings, downloads and sources sit behind
/// the gear on each tab. First launch shows the animated tour.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @State private var tab: AppTab = Self.initialTab
    @State private var showSettings = false

    private static var initialTab: AppTab {
        #if DEBUG
        switch UserDefaults.standard.string(forKey: "demoTab") {
        case "mosques": return .mosques
        case "ask": return .ask
        default: return .prayer
        }
        #else
        return .prayer
        #endif
    }

    var body: some View {
        TabView(selection: $tab) {
            Tab(l10n.t("tab_prayer"), systemImage: "location.north.circle", value: AppTab.prayer) {
                NavigationStack { PrayerView(showSettings: $showSettings) }
            }
            Tab(l10n.t("tab_mosques"), image: "MosqueTab", value: AppTab.mosques) {
                NavigationStack { MosquesView(showSettings: $showSettings) }
            }
            Tab(l10n.t("tab_ask_short"), systemImage: "text.book.closed", value: AppTab.ask) {
                NavigationStack { AskView(showSettings: $showSettings) }
            }
        }
        .tint(Theme.gold)
        .modifier(TabBarMinimize())
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environment(\.locale, l10n.locale)
                .environment(\.layoutDirection, l10n.layoutDirection)
        }
        .fullScreenCover(isPresented: Binding(get: { model.ready && !model.settings.onboarded },
                                              set: { if !$0 { model.settings.onboarded = true } })) {
            OnboardingView()
                .environment(\.locale, l10n.locale)
                .environment(\.layoutDirection, l10n.layoutDirection)
        }
    }
}

/// iOS 26: the Liquid Glass tab bar minimizes while scrolling down.
private struct TabBarMinimize: ViewModifier {
    func body(content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) { content.tabBarMinimizeBehavior(.onScrollDown) } else { content }
        #else
        content
        #endif
    }
}

/// Gear button shown at the top trailing edge of each tab.
struct SettingsButton: View {
    @Binding var show: Bool
    @Environment(Localization.self) private var l10n
    var body: some View {
        GlassIconButton(systemImage: "gearshape", label: l10n.t("settings")) { show = true }
    }
}
