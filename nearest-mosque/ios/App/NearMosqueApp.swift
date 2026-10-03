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
                .task { await model.start() }
        }
    }
}

enum AppTab: Hashable { case prayer, mosques, ask }

/// Exactly three destinations. Settings, downloads and sources sit behind the gear on each tab.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(Localization.self) private var l10n
    @State private var tab: AppTab = .prayer
    @State private var showSettings = false

    var body: some View {
        TabView(selection: $tab) {
            Tab(l10n.t("tab_prayer"), systemImage: "moon.stars", value: AppTab.prayer) {
                NavigationStack { PrayerView(showSettings: $showSettings) }
            }
            Tab(l10n.t("tab_mosques"), systemImage: "building.columns", value: AppTab.mosques) {
                NavigationStack { MosquesView(showSettings: $showSettings) }
            }
            Tab(l10n.t("tab_ask"), systemImage: "sparkles", value: AppTab.ask) {
                NavigationStack { AskView(showSettings: $showSettings) }
            }
        }
        .tint(Theme.navy)
        .modifier(TabBarMinimize())
        .sheet(isPresented: $showSettings) {
            SettingsView()
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
        Button { show = true } label: { Image(systemName: "gearshape") }
            .accessibilityLabel(l10n.t("settings"))
    }
}
