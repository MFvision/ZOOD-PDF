import SwiftUI

/// "More" / Tools tab: every tool available on this device, as pastel tiles.
struct ToolsGrid: View {
    let dismissOnPick: Bool
    @Environment(WindowRouter.self) private var router
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("more.subtitle").foregroundStyle(.secondary)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 14)], spacing: 14) {
                    ForEach(ToolKind.tools) { tool in
                        Button {
                            if dismissOnPick {
                                dismiss()
                                // Present the next sheet/importer after this one has gone.
                                Task {
                                    try? await Task.sleep(for: .milliseconds(400))
                                    router.start(tool)
                                }
                            } else {
                                router.start(tool)
                            }
                        } label: {
                            ActionCard(tool: tool)
                        }
                        .buttonStyle(PressableStyle())
                        .accessibilityIdentifier("tool.\(tool.rawValue)")
                    }
                }
            }
            .padding(16)
        }
        .background(AppBackdrop())
        .navigationTitle(Text("more.title"))
    }
}
