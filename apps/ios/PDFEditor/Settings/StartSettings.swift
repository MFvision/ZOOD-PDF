import SwiftUI
import UIKit

/// How the iPhone moves between the app's places: the tab bar most apps
/// have (Home, My files, the create button, Tools, Me), or the classic
/// single stack with Home at its root. The owner asked for both, chosen in
/// Settings. On iPad and an unfolded iPhone Duo the split view stays either way.
enum MenuStyle: String, CaseIterable, Identifiable {
    case tabs
    case classic

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .tabs: "Tabs"
        case .classic: "Classic"
        }
    }
}

/// Where the app opens (Settings › Open with), as some camera apps let you
/// open on the camera. Read once, when the app starts.
enum StartScreen: String, CaseIterable, Identifiable {
    /// The screen and the document the app was on: what it always did.
    case lastPlace
    case home
    case scanner
    case files
    case remote

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .lastPlace: "Where I left off"
        case .home: "Home"
        case .scanner: "The scanner"
        case .files: "My files"
        case .remote: "Phone remote"
        }
    }

    var symbol: String {
        switch self {
        case .lastPlace: "clock.arrow.circlepath"
        case .home: "house"
        case .scanner: "doc.viewfinder"
        case .files: "folder"
        case .remote: "iphone.radiowaves.left.and.right"
        }
    }
}

/// The app icons Settings offers: ZOOD's mark and label in the brand's
/// colours (scripts/icon/make_zood_icons.py draws every one). The names are
/// the asset catalog's alternate icon sets (project.yml lists them).
enum AppIconChoice: String, CaseIterable, Identifiable {
    case navy
    case paper
    case sky
    case black
    case bronze

    var id: String { rawValue }

    /// The alternate icon's name; nil is the app's own icon.
    var iconName: String? {
        switch self {
        case .navy: nil
        case .paper: "AppIcon-Paper"
        case .sky: "AppIcon-Sky"
        case .black: "AppIcon-Black"
        case .bronze: "AppIcon-Bronze"
        }
    }

    /// The small picture of it in the picker.
    var preview: String {
        switch self {
        case .navy: "AppIconPreviewNavy"
        case .paper: "AppIconPreviewPaper"
        case .sky: "AppIconPreviewSky"
        case .black: "AppIconPreviewBlack"
        case .bronze: "AppIconPreviewBronze"
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .navy: "Navy"
        case .paper: "Paper"
        case .sky: "Sky"
        case .black: "Black"
        case .bronze: "Bronze"
        }
    }

    init(iconName: String?) {
        self = Self.allCases.first { $0.iconName == iconName } ?? .navy
    }
}

/// Menu style, Open with and App icon: in Settings and on the Me tab.
struct StartSettingsSection: View {
    @AppStorage(SettingsKey.menuStyle) private var menuStyle: MenuStyle = .tabs
    @AppStorage(SettingsKey.startScreen) private var startScreen: StartScreen = .lastPlace
    @State private var icon = AppIconChoice(iconName: UIApplication.shared.alternateIconName)
    @State private var iconError = false

    var body: some View {
        Section {
            Picker("Menu style", selection: $menuStyle) {
                ForEach(MenuStyle.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("settings.menuStyle")
            Picker("Open with", selection: $startScreen) {
                ForEach(StartScreen.allCases) { item in
                    Label(item.title, systemImage: item.symbol).tag(item)
                }
            }
            .accessibilityIdentifier("settings.startScreen")
            if UIApplication.shared.supportsAlternateIcons {
                VStack(alignment: .leading, spacing: Space.x3) {
                    Text("App icon")
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Space.x4) {
                            ForEach(AppIconChoice.allCases) { choice in
                                iconButton(choice)
                            }
                        }
                        .padding(.vertical, Space.x2)
                    }
                }
                .accessibilityIdentifier("settings.appIcon")
            }
        } header: {
            Text("Menu and start")
        } footer: {
            Text("Tabs puts Home, My files, Create, Tools and Me along the bottom. Open with is the screen the app starts on.")
        }
        .sensoryFeedback(.selection, trigger: menuStyle)
        .sensoryFeedback(.selection, trigger: icon)
        .alert("Cannot change the icon", isPresented: $iconError) {
            Button("OK", role: .cancel) {}
        }
    }

    private func iconButton(_ choice: AppIconChoice) -> some View {
        Button {
            choose(choice)
        } label: {
            VStack(spacing: Space.x2) {
                Image(choice.preview)
                    .resizable()
                    .frame(width: 60, height: 60)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 17, style: .continuous)
                            .strokeBorder(icon == choice ? Color.accentColor : .clear, lineWidth: 2.5)
                            .padding(-4)
                    }
                Text(choice.title)
                    .font(TextStyle.caption)
                    .foregroundStyle(icon == choice ? Surface.label : Surface.secondaryLabel)
            }
            .padding(4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(choice.title))
        .accessibilityAddTraits(icon == choice ? .isSelected : [])
        .accessibilityIdentifier("settings.appIcon.\(choice.rawValue)")
    }

    private func choose(_ choice: AppIconChoice) {
        guard choice != icon else { return }
        let previous = icon
        icon = choice
        Task { @MainActor in
            do {
                try await UIApplication.shared.setAlternateIconName(choice.iconName)
            } catch {
                icon = previous
                iconError = true
            }
        }
    }
}
