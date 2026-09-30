import SwiftUI

// The small component set every screen is built from: a press style that
// answers on touch-down, the toolbar's title block, a sheet, a grid cell
// and an empty state. Add to these before adding a one-off.

/// Feedback on press, not on release: the control shrinks the instant the
/// finger lands (no delay) and springs back when it lifts.
struct PressableStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(configuration.isPressed ? nil : Motion.travel(reduceMotion: reduceMotion), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableStyle {
    static var pressable: PressableStyle { PressableStyle() }
}

/// The toolbar's title block: the document's name and, under it, its
/// state — "Page 3 of 9", "Edited" — the one place these are shown.
struct ToolbarStatus: View {
    let title: Text
    let subtitle: Text?

    /// A name as it is (a file's).
    init(title: String, subtitle: Text?) {
        self.title = Text(title)
        self.subtitle = subtitle
    }

    /// A title from the String Catalog.
    init(title: Text, subtitle: Text?) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(spacing: 0) {
            title
                .font(TextStyle.headline)
                .lineLimit(1)
            if let subtitle {
                subtitle
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
                    .tabularNumbers()
                    .lineLimit(1)
                    .accessibilityIdentifier("document.status")
            }
        }
        // Two elements, the name and the state: VoiceOver reads them in
        // turn, and the state keeps its identifier whatever it says.
    }
}

/// A sheet with a title and a Done button, sized to its content on a
/// phone. What it shows is the caller's; the chrome is always the same.
struct AppSheet<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let content: Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                // The sheet's body takes the chosen theme's ground and its
                // rows the theme's material; on the system theme nothing
                // changes (Design/Themes.swift).
                .themedScrollBackground()
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                            .accessibilityIdentifier("sheet.done")
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// A document in the Library's grid: its first page on paper, its name
/// and a line about it. Presses answer at once; the whole cell is the
/// target.
struct DocumentGridCell: View {
    let name: String
    let detail: Text
    let thumbnail: UIImage?
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: Space.x3) {
                Depth.page(
                    ZStack {
                        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            .fill(Surface.paper)
                        if let thumbnail {
                            Image(uiImage: thumbnail)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                        } else {
                            Image(systemName: "doc.text")
                                .font(.system(size: 34, weight: .light))
                                .foregroundStyle(Surface.tertiaryLabel)
                        }
                    }
                    .aspectRatio(210 / 297, contentMode: .fit)
                )
                VStack(alignment: .leading, spacing: Space.x1) {
                    Text(name)
                        .font(TextStyle.callout)
                        .foregroundStyle(Surface.label)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    detail
                        .font(TextStyle.caption)
                        .foregroundStyle(Surface.secondaryLabel)
                        .tabularNumbers()
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(name))
        .accessibilityHint(Text("Opens the document"))
    }
}

/// What an empty section says, and the one thing to do about it.
struct EmptyState: View {
    let symbol: String
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    var actionTitle: LocalizedStringKey? = nil
    var action: (() -> Void)? = nil
    /// The action button's identifier, so a UI test can press it.
    var actionIdentifier: String? = nil

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(message)
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier(actionIdentifier ?? "empty.action")
            }
        }
    }
}

/// The app's name, isolated right-to-left inside an English sentence so it
/// reads as it does in Arabic: U+2067 … U+2069.
enum AppName {
    static let plain = "محرر PDF"
    static let isolated = "\u{2067}محرر PDF\u{2069}"
}
