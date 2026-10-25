import AuthenticationServices
import SwiftUI

/// OneDrive and Google Drive, as the desktop's Folders has them: sign in on
/// the provider's own page, browse and search, open a PDF (it is saved back
/// when you save it), or save a document of this iPhone's into a folder.
struct CloudView: View {
    /// Opens a fetched copy in the editor.
    let open: (URL) -> Void
    /// A document to save into a drive instead of opening one (Save to…).
    var saving: URL?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var center = CloudCenter.shared
    @State private var busy: CloudProvider?
    @State private var error: String?
    @State private var picked: [CloudEntry] = []

    var body: some View {
        NavigationStack {
            List {
                ForEach(CloudProvider.allCases) { provider in
                    providerSection(provider)
                }
                Section {
                    EmptyView()
                } footer: {
                    Text("You sign in on Microsoft's or Google's own page. ZOOD keeps a sign-in key on this iPhone only, and talks to the drive directly. For Google Drive, ZOOD sees only the files you pick or save from ZOOD.")
                }
            }
            .themedScrollBackground()
            .navigationTitle(saving == nil ? "Cloud drives" : "Save to a cloud drive")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("cloud.done")
                }
            }
            .navigationDestination(for: CloudPlace.self) { place in
                CloudFolderView(place: place, saving: saving, open: finish)
            }
            .alert("Cloud drive", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
        }
    }

    private func finish(_ url: URL?) {
        if let url { open(url) }
        dismiss()
    }

    @ViewBuilder
    private func providerSection(_ provider: CloudProvider) -> some View {
        Section {
            if !provider.isOffered {
                Label("Not in this build yet.", systemImage: "info.circle")
                    .foregroundStyle(Surface.secondaryLabel)
            } else if let email = center.accounts[provider] {
                NavigationLink(value: CloudPlace(provider: provider, folder: nil, title: provider.title)) {
                    Label {
                        VStack(alignment: .leading) {
                            Text(provider == .gdrive ? "Files ZOOD can open" : "All files")
                            Text(verbatim: email).font(TextStyle.caption).foregroundStyle(Surface.secondaryLabel)
                        }
                    } icon: {
                        Image(systemName: "folder")
                    }
                }
                .accessibilityIdentifier("cloud.\(provider.rawValue).browse")
                if provider == .gdrive {
                    Button {
                        Task { await pickInGoogle() }
                    } label: {
                        Label("Pick files in Google Drive…", systemImage: "hand.tap")
                    }
                    .disabled(busy != nil)
                    ForEach(picked) { entry in
                        CloudEntryRow(entry: entry, provider: .gdrive, saving: saving, open: finish)
                    }
                }
                Button("Sign out", role: .destructive) { center.signOut(provider) }
            } else {
                Button {
                    Task { await signIn(provider) }
                } label: {
                    HStack {
                        Label("Sign in to \(provider.title)", systemImage: provider.symbol)
                        Spacer()
                        if busy == provider { ProgressView() }
                    }
                }
                .disabled(busy != nil)
                .accessibilityIdentifier("cloud.\(provider.rawValue).signin")
            }
        } header: {
            Text(verbatim: provider.title)
        }
    }

    private func authenticate(_ url: URL) async throws -> URL {
        try await webAuthenticationSession.authenticate(
            using: url,
            callback: .customScheme(LoopbackListener.doneScheme),
            preferredBrowserSession: .shared,
            additionalHeaderFields: [:])
    }

    private func signIn(_ provider: CloudProvider, extra: [String: String] = [:]) async {
        busy = provider
        defer { busy = nil }
        do {
            let result = try await CloudAuth.signIn(provider, extra: extra, authenticate: authenticate)
            _ = result
            let email = (try? await CloudDrives.drive(provider).account()) ?? provider.title
            center.signedIn(provider, as: email)
            if provider == .gdrive, let ids = result.params["picked_file_ids"] {
                picked = try await GoogleDriveClient().entries(ids.split(separator: ",").map(String.init))
            }
        } catch CloudError.cancelled {
            // The person closed the sheet: nothing to say.
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Google's picker is part of its consent screen: each pick is a sign-in.
    private func pickInGoogle() async {
        await signIn(.gdrive, extra: CloudConfig.googlePicker)
    }
}

/// A folder of a drive (nil: its top).
struct CloudPlace: Hashable {
    let provider: CloudProvider
    let folder: String?
    let title: String
}

/// One folder's PDFs and folders, with search.
struct CloudFolderView: View {
    let place: CloudPlace
    let saving: URL?
    let open: (URL?) -> Void
    @State private var entries: [CloudEntry] = []
    @State private var next: String?
    @State private var loading = false
    @State private var query = ""
    @State private var error: String?
    @State private var center = CloudCenter.shared

    var body: some View {
        List {
            if let saving {
                Section {
                    Button {
                        Task {
                            do {
                                try await center.saveCopy(saving, to: place.provider, folder: place.folder)
                                open(nil)
                            } catch {
                                self.error = error.localizedDescription
                            }
                        }
                    } label: {
                        Label("Save \(saving.lastPathComponent) here", systemImage: "square.and.arrow.down")
                    }
                    .accessibilityIdentifier("cloud.saveHere")
                }
            }
            Section {
                ForEach(entries) { entry in
                    if entry.kind == .folder {
                        NavigationLink(value: CloudPlace(provider: place.provider, folder: entry.key, title: entry.name)) {
                            Label(entry.name, systemImage: "folder")
                        }
                    } else {
                        CloudEntryRow(entry: entry, provider: place.provider, saving: saving, open: open)
                    }
                }
                if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if next != nil {
                    Button("Show more") { Task { await load(more: true) } }
                } else if entries.isEmpty {
                    Text(query.isEmpty ? "No PDFs or folders here." : "Nothing found.")
                        .foregroundStyle(Surface.secondaryLabel)
                }
            }
            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                }
            }
        }
        .themedScrollBackground()
        .navigationTitle(place.title)
        .searchable(text: $query, prompt: Text("Search \(place.provider.title)"))
        .onSubmit(of: .search) { Task { await load() } }
        .onChange(of: query) { _, text in if text.isEmpty { Task { await load() } } }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load(more: Bool = false) async {
        loading = true
        defer { loading = false }
        let drive = CloudDrives.drive(place.provider)
        do {
            let listing = query.isEmpty
                ? try await drive.list(folder: place.folder, next: more ? next : nil)
                : try await drive.search(query, next: more ? next : nil)
            entries = more ? entries + listing.entries : listing.entries
            next = listing.next
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// A PDF in a drive: tapping fetches it and opens it in the editor.
struct CloudEntryRow: View {
    let entry: CloudEntry
    let provider: CloudProvider
    let saving: URL?
    let open: (URL?) -> Void
    @State private var fetching = false
    @State private var error: String?

    var body: some View {
        Button {
            guard saving == nil, !fetching else { return }
            fetching = true
            Task {
                defer { fetching = false }
                do {
                    open(try await CloudCenter.shared.fetch(entry, from: provider))
                } catch {
                    self.error = error.localizedDescription
                }
            }
        } label: {
            HStack {
                Label {
                    VStack(alignment: .leading) {
                        Text(verbatim: entry.name).lineLimit(2)
                        if let error {
                            Text(error).font(TextStyle.caption).foregroundStyle(.orange)
                        } else if let modified = entry.modified {
                            Text(modified, format: .dateTime.day().month().year())
                                .font(TextStyle.caption).foregroundStyle(Surface.secondaryLabel)
                        }
                    }
                } icon: {
                    Image(systemName: "doc.richtext")
                }
                Spacer()
                if fetching { ProgressView() }
            }
        }
        .foregroundStyle(saving == nil ? Surface.label : Surface.secondaryLabel)
        .accessibilityIdentifier("cloud.file")
    }
}

/// "Saved to OneDrive", for a moment, over the Library after a save went back.
struct CloudSaveBanner: View {
    @State private var center = CloudCenter.shared

    var body: some View {
        Group {
            switch center.status {
            case .idle:
                EmptyView()
            case let .saving(name):
                pill(Text("Saving to \(name)…"), symbol: "icloud.and.arrow.up", tint: Surface.label)
            case let .saved(message):
                pill(Text(message), symbol: "checkmark.icloud", tint: Surface.label)
                    .task {
                        try? await Task.sleep(for: .seconds(3))
                        center.clearStatus()
                    }
            case let .failed(message):
                pill(Text(message), symbol: "exclamationmark.icloud", tint: .orange)
                    .onTapGesture { center.clearStatus() }
                    .task {
                        try? await Task.sleep(for: .seconds(8))
                        center.clearStatus()
                    }
            }
        }
        .animation(Motion.travel, value: center.status)
    }

    private func pill(_ text: Text, symbol: String, tint: Color) -> some View {
        Label { text } icon: { Image(systemName: symbol) }
            .font(TextStyle.callout)
            .foregroundStyle(tint)
            .padding(.horizontal, Space.x5)
            .padding(.vertical, Space.x3)
            .background(.regularMaterial, in: Capsule())
            .padding(.top, Space.x3)
            .transition(.move(edge: .top).combined(with: .opacity))
            .accessibilityIdentifier("cloud.banner")
    }
}
