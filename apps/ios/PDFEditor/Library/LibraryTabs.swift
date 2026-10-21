import SwiftUI

/// The iPhone's tab bar (Settings › Menu style › Tabs), laid out the way
/// most apps are: Home first, the create button in the middle, Me last; in
/// Arabic the bar runs right to left, so Home is on the right.
enum AppTab: String, CaseIterable, Identifiable {
    case home
    case files
    /// Not a screen: choosing it opens the create sheet.
    case create
    case tools
    case me

    var id: String { rawValue }
}

/// What the create button offers: the ways a PDF comes into the app.
enum CreateChoice: String, CaseIterable, Identifiable {
    case scan
    case pictures
    case open
    case combine

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .scan: "Scan paper"
        case .pictures: "Photos to PDF"
        case .open: "Open from Files"
        case .combine: "Combine files"
        }
    }

    var symbol: String {
        switch self {
        case .scan: "doc.viewfinder"
        case .pictures: "photo.on.rectangle.angled"
        case .open: "folder.badge.plus"
        case .combine: "doc.on.doc"
        }
    }
}

/// The create button's sheet: four large choices. The choice is made once
/// the sheet has gone (`LibraryShell`), since the scanner and the file
/// browser cannot come up while it is still leaving.
struct CreateSheet: View {
    let choose: (CreateChoice) -> Void
    @Environment(\.dismiss) private var dismiss

    private let columns = [GridItem(.flexible(), spacing: Space.x4), GridItem(.flexible(), spacing: Space.x4)]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.x5) {
            Text("Create")
                .themeFont(.title)
                .foregroundStyle(Surface.label)
            LazyVGrid(columns: columns, spacing: Space.x4) {
                ForEach(CreateChoice.allCases) { choice in
                    Button {
                        choose(choice)
                        dismiss()
                    } label: {
                        VStack(spacing: Space.x3) {
                            Image(systemName: choice.symbol)
                                .font(.system(size: 30, weight: .regular))
                            Text(choice.title)
                                .font(TextStyle.body.weight(.semibold))
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity, minHeight: 112)
                        .foregroundStyle(choice == .scan ? Color.white : Surface.label)
                        .background(choice == .scan ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Surface.groupedCell),
                                    in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("create.\(choice.rawValue)")
                }
            }
            Text("Nothing leaves this device.")
                .font(TextStyle.caption)
                .foregroundStyle(Surface.secondaryLabel)
                .frame(maxWidth: .infinity)
        }
        .padding(Space.x6)
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .themedGround()
    }
}

/// My files: every place the Library keeps documents, one row each.
struct FilesTab: View {
    let library: LibraryModel

    var body: some View {
        List {
            Section {
                row(.documents, count: library.documents.count)
                row(.recents, count: library.recents.count)
                row(.starred, count: library.starredItems.count)
                row(.tags, count: library.indexer?.stats.tags.count ?? 0)
                if let folder = library.chosenFolder {
                    NavigationLink(value: LibrarySection.folder) {
                        line(Text(verbatim: folder.name), symbol: LibrarySection.folder.symbol, count: library.folderFiles.count)
                    }
                    .accessibilityIdentifier("files.folder")
                }
            } footer: {
                Text("Nothing leaves this device.")
            }
        }
        .themedScrollBackground()
        .refreshable { library.refresh() }
        .accessibilityIdentifier("tab.files.list")
    }

    private func row(_ section: LibrarySection, count: Int) -> some View {
        NavigationLink(value: section) {
            line(Text(section.title), symbol: section.symbol, count: count)
        }
        .accessibilityIdentifier("files.\(section.rawValue)")
    }

    private func line(_ title: Text, symbol: String, count: Int) -> some View {
        LabeledContent {
            Text(count, format: .number).tabularNumbers()
        } label: {
            Label { title } icon: { Image(systemName: symbol) }
        }
    }
}

/// Tools: what the app does to files, and the phone remote for a computer.
struct ToolsTab: View {
    let run: (LibraryTool) -> Void
    let remote: () -> Void

    var body: some View {
        List {
            Section {
                ForEach(LibraryTool.allCases) { tool in
                    Button {
                        run(tool)
                    } label: {
                        Label(tool.title, systemImage: tool.symbol)
                    }
                    .foregroundStyle(Surface.label)
                    .accessibilityIdentifier("tools.\(tool.rawValue)")
                }
            }
            Section {
                Button(action: remote) {
                    Label("Phone remote", systemImage: "iphone.radiowaves.left.and.right")
                }
                .foregroundStyle(Surface.label)
                .accessibilityIdentifier("tools.remote")
            } header: {
                Text("Your computer")
            } footer: {
                Text("Present, use the phone as a trackpad, and send files to ZOOD PDF on your computer.")
            }
        }
        .themedScrollBackground()
    }
}

/// Me: the details forms are filled from, the menu and start choices, the
/// app icon, and every other setting a tap away (and at the top corner).
struct MeTab: View {
    let settings: () -> Void

    var body: some View {
        Form {
            StartSettingsSection()
            // On-device AI and My details for forms.
            AISettingsSection()
            Section {
                Button(action: settings) {
                    Label("All settings", systemImage: "gearshape")
                }
                .accessibilityIdentifier("me.settings")
            }
        }
        .themedScrollBackground()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Settings", systemImage: "gearshape", action: settings)
                    .accessibilityIdentifier("me.settings.corner")
            }
        }
    }
}
