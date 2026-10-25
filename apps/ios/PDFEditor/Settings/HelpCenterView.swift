import SwiftUI
import WarraqCore

/// Help & Support on the iPhone, after the desktop's: short guides for each
/// feature, ideas to try with Ask ZOOD, the tour again, and "Report a
/// problem", where you read everything that would be sent before it goes —
/// by your own e-mail, nothing in the background. Free, no account.
struct HelpCenterView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var touring = false

    static let email = "app@zood.sa"
    static var website: URL {
        let arabic = Locale.current.language.languageCode?.identifier == "ar"
        return URL(string: arabic ? "https://pdf.zoodrealty.com/help/" : "https://pdf.zoodrealty.com/en/help/")!
    }

    struct Guide: Identifiable {
        let id: String
        let symbol: String
        let title: LocalizedStringKey
        let steps: [LocalizedStringKey]
    }

    static let guides: [Guide] = [
        Guide(id: "scan", symbol: "doc.viewfinder", title: "Scan paper into a PDF", steps: [
            "Tap Scan in the Library. The camera opens straight away.",
            "Hold the iPhone over the page. ZOOD finds its edges and takes it when it is steady.",
            "Tap Save. The words are read on the iPhone so the PDF can be searched.",
        ]),
        Guide(id: "ai", symbol: "sparkles", title: "Summarize a PDF with Ask ZOOD", steps: [
            "Open the PDF and tap the sparkles button.",
            "The first time, ZOOD's model is set up once. After that it works with no internet.",
            "Tap Summarize, or ask your own question about the document.",
        ]),
        Guide(id: "deck", symbol: "rectangle.on.rectangle.angled", title: "Make a presentation", steps: [
            "Open Ask ZOOD from the Library, or the AI panel in a document.",
            "Write “make me a presentation about …”.",
            "ZOOD writes the slides on the iPhone and gives you a PowerPoint file to share.",
        ]),
        Guide(id: "cloud", symbol: "icloud", title: "Open from OneDrive or Google Drive", steps: [
            "Tap Cloud drives in the Library and sign in to your account.",
            "OneDrive shows your folders. For Google Drive, tap Pick files and choose the PDFs ZOOD may open.",
            "Edit and save as usual: ZOOD puts the file back on the drive. If it changed there meanwhile, yours is saved as a copy.",
        ]),
        Guide(id: "quick", symbol: "bolt", title: "Convert, split, sign in one tap", steps: [
            "Tap Quick tools in the Library and choose a file.",
            "Tap a tool: Word, Excel, PowerPoint, pictures, split, sign, watermark, unlock and more.",
            "Share the result, or keep it in My files.",
        ]),
        Guide(id: "sort", symbol: "wand.and.stars", title: "Sort files with ZOOD", steps: [
            "Tap Sort with ZOOD in the Library and choose files.",
            "Tap Suggest. ZOOD proposes merges, splits, better names and folders.",
            "Untick what you don't want and tap Apply. Undo puts everything back.",
        ]),
        Guide(id: "remote", symbol: "iphone.radiowaves.left.and.right", title: "Use the phone as a remote", steps: [
            "On the PC or Mac, open Phone remote in ZOOD PDF.",
            "On the iPhone, open Phone remote in the Library and scan the code.",
            "Move slides, use the trackpad, or send files both ways.",
        ]),
    ]

    static let ideas: [LocalizedStringKey] = [
        "“Summarize this contract in five points”",
        "“What is the total on this invoice?”",
        "“Make me a presentation about our new service”",
        "“Merge my scans”",
        "“Open the lease”",
        "“لخص هذا الملف”",
    ]

    var body: some View {
        NavigationStack {
            List {
                Section("Guides") {
                    ForEach(Self.guides) { guide in
                        NavigationLink {
                            GuideView(guide: guide)
                        } label: {
                            Label(guide.title, systemImage: guide.symbol)
                        }
                    }
                }
                Section {
                    ForEach(Self.ideas.indices, id: \.self) { k in
                        Text(Self.ideas[k]).foregroundStyle(Surface.secondaryLabel)
                    }
                } header: {
                    Text("Ideas to try with Ask ZOOD")
                }
                Section {
                    NavigationLink {
                        ReportProblemView()
                    } label: {
                        Label("Report a problem or suggest an idea", systemImage: "exclamationmark.bubble")
                    }
                    .accessibilityIdentifier("help.report")
                    Button("Take the tour again", systemImage: "play.circle") { touring = true }
                    Link(destination: Self.website) {
                        Label("More help on the website", systemImage: "safari")
                    }
                } footer: {
                    Text("Help is free and needs no account.")
                }
                Section("About") {
                    ZoodLogo(kind: .main, height: 36).frame(maxWidth: .infinity)
                    LabeledContent("Version", value: SettingsView.appVersion)
                    LabeledContent("Core", value: Core.version)
                    LabeledContent("Contact", value: Self.email)
                }
            }
            .themedScrollBackground()
            .navigationTitle("Help & Support")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .fullScreenCover(isPresented: $touring) {
                OnboardingView { touring = false }
            }
        }
    }
}

private struct GuideView: View {
    let guide: HelpCenterView.Guide

    var body: some View {
        List {
            ForEach(guide.steps.indices, id: \.self) { k in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(verbatim: "\(k + 1)")
                        .font(.headline)
                        .foregroundStyle(Color.accentColor)
                    Text(guide.steps[k])
                }
            }
        }
        .themedScrollBackground()
        .navigationTitle(guide.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// What you write, and the few facts about the app that help find the
/// problem. All of it is shown here; nothing goes until you send the e-mail.
private struct ReportProblemView: View {
    @Environment(\.openURL) private var openURL
    @State private var words = ""

    private var facts: String {
        let device = UIDevice.current
        return """
        ZOOD PDF \(SettingsView.appVersion), core \(Core.version)
        \(device.model), \(device.systemName) \(device.systemVersion)
        \(Locale.current.identifier)
        """
    }

    private var message: String { words.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n—\n" + facts }

    var body: some View {
        Form {
            Section {
                TextEditor(text: $words)
                    .frame(minHeight: 160)
                    .accessibilityIdentifier("report.words")
            } header: {
                Text("What happened, or what would help?")
            }
            Section {
                Text(verbatim: facts)
                    .font(.footnote.monospaced())
                    .foregroundStyle(Surface.secondaryLabel)
            } header: {
                Text("Also sent, so we can find the problem")
            } footer: {
                Text("No documents, names or files are included. You can read and change the e-mail before you send it.")
            }
            Section {
                Button("Send by e-mail", systemImage: "envelope") { send() }
                    .disabled(words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("report.send")
                ShareLink(item: message) {
                    Label("Share another way", systemImage: "square.and.arrow.up")
                }
                .disabled(words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .themedScrollBackground()
        .navigationTitle("Report a problem")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func send() {
        var parts = URLComponents()
        parts.scheme = "mailto"
        parts.path = HelpCenterView.email
        parts.queryItems = [
            URLQueryItem(name: "subject", value: "ZOOD PDF (iPhone): " + String(words.prefix(60))),
            URLQueryItem(name: "body", value: message),
        ]
        if let url = parts.url { openURL(url) }
    }
}
