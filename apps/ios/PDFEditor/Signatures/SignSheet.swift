import SwiftUI
import UniformTypeIdentifiers
import WarraqCore

/// Sign: a PAdES signature made with a certificate file the person imported.
///
/// The signing itself is the core's (`signatures.sign`), the same code the
/// desktop runs, so a signature made on a phone verifies everywhere. The
/// private key never leaves this device and never reaches the network: the
/// core builds the signature in memory and answers the signed file.
///
/// What is not here, and why, is in `docs/STATUS.md`: smart cards (iOS has no
/// PKCS#11), trusted timestamps and fresh revocation data (both need the
/// network, and are the desktop's). Nothing is shown for them.
struct SignSheet: View {
    let model: DocumentModel
    let undoManager: UndoManager?
    var identities = SigningIdentities()
    var onSigned: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var stored: [SigningIdentities.Entry] = []
    @State private var chosen: SigningIdentities.Entry?
    @State private var password = ""
    @State private var identity: Signing.Identity?
    @State private var opening = false
    @State private var importing = false

    @State private var visible = true
    @State private var page = 0
    @State private var position = Signing.Position.bottomStart
    @State private var reason = ""
    @State private var location = ""
    @State private var contact = ""
    @State private var certify: Int?
    @State private var lockFields = false
    @State private var pss = false

    @State private var working = false
    @State private var error: String?
    @State private var signed = false

    var body: some View {
        NavigationStack {
            Form {
                identitySection
                if identity != nil {
                    placementSection
                    detailsSection
                    optionsSection
                }
                privacySection
            }
            .navigationTitle("Sign")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("sign.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button("Sign", action: sign)
                            .disabled(identity == nil)
                            .accessibilityIdentifier("sign.sign")
                    }
                }
            }
            .alert("Could not sign", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
            .fileImporter(
                isPresented: $importing,
                allowedContentTypes: Self.identityTypes,
                allowsMultipleSelection: false,
                onCompletion: importIdentity
            )
        }
        .presentationDetents([.large])
        .sensoryFeedback(.success, trigger: signed)
        .task { stored = identities.identities() }
    }

    // MARK: - Choosing the identity

    @ViewBuilder
    private var identitySection: some View {
        Section {
            if stored.isEmpty {
                Text("No certificate has been imported on this device yet.")
                    .foregroundStyle(Surface.secondaryLabel)
                    .accessibilityIdentifier("sign.noIdentity")
            } else {
                Picker("Certificate", selection: $chosen) {
                    ForEach(stored) { entry in
                        Text(entry.name).tag(Optional(entry))
                    }
                }
                .accessibilityIdentifier("sign.identity")
                .onChange(of: chosen) { _, _ in identity = nil }
            }
            Button("Import a certificate file…", systemImage: "square.and.arrow.down") { importing = true }
                .accessibilityIdentifier("sign.import")
            if chosen != nil {
                SecureField("The certificate's password", text: $password)
                    .textContentType(.password)
                    .accessibilityIdentifier("sign.password")
                    .onChange(of: password) { _, _ in identity = nil }
                Button(action: open) {
                    if opening {
                        ProgressView()
                    } else {
                        Text("Open the certificate")
                    }
                }
                .disabled(opening || password.isEmpty)
                .accessibilityIdentifier("sign.open")
                if let entry = chosen {
                    Button("Remove this certificate from the device", role: .destructive) { forget(entry) }
                        .accessibilityIdentifier("sign.forget")
                }
            }
            if let identity {
                VStack(alignment: .leading, spacing: Space.x2) {
                    Text(identity.name).font(TextStyle.headline)
                    Text("Issued by \(Signatures.isolate(identity.issuer))")
                        .font(TextStyle.caption)
                        .foregroundStyle(Surface.secondaryLabel)
                    Text("\(identity.key) · valid until \(identity.notAfter)")
                        .font(TextStyle.caption)
                        .foregroundStyle(Surface.secondaryLabel)
                    if !identity.validNow {
                        Text("This certificate is not valid today. A signature made with it will not check out.")
                            .font(TextStyle.caption)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("sign.notValidNow")
                    }
                    if !identity.canSign {
                        Text("This certificate is not allowed to sign.")
                            .font(TextStyle.caption)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("sign.cannotSign")
                    }
                }
                .accessibilityIdentifier("sign.identityCard")
            }
        } header: {
            Text("Sign with")
        } footer: {
            Text("A certificate file (.p12 or .pfx) is kept in this device's Keychain, not in a file the Files app can reach. Its password is never kept: it is typed each time.")
        }
    }

    // MARK: - Where it goes

    @ViewBuilder
    private var placementSection: some View {
        Section {
            Toggle("Show the signature on the page", isOn: $visible)
                .accessibilityIdentifier("sign.visible")
            if visible {
                Picker("Page", selection: $page) {
                    ForEach(0..<max(model.pageCount, 1), id: \.self) { index in
                        Text("Page \(index + 1)").tag(index)
                    }
                }
                .accessibilityIdentifier("sign.page")
                Picker("Corner", selection: $position) {
                    ForEach(Signing.Position.allCases, id: \.self) { corner in
                        Text(corner.text).tag(corner)
                    }
                }
                .accessibilityIdentifier("sign.position")
            }
        } header: {
            Text("Where")
        } footer: {
            Text("A signature that is not shown still signs the file; it just draws nothing on the page.")
        }
    }

    @ViewBuilder
    private var detailsSection: some View {
        Section("Reason and place") {
            TextField("Reason", text: $reason)
                .accessibilityIdentifier("sign.reason")
            TextField("Place", text: $location)
                .accessibilityIdentifier("sign.location")
            TextField("Contact", text: $contact)
                .accessibilityIdentifier("sign.contact")
        }
    }

    @ViewBuilder
    private var optionsSection: some View {
        Section {
            Picker("Kind", selection: $certify) {
                Text("Approval signature").tag(Int?.none)
                Text("Certification: filling forms and signing allowed").tag(Int?.some(2))
                Text("Certification: forms, signing and comments allowed").tag(Int?.some(3))
                Text("Certification: no changes allowed").tag(Int?.some(1))
            }
            .accessibilityIdentifier("sign.kind")
            Toggle("Lock the form fields once signed", isOn: $lockFields)
                .accessibilityIdentifier("sign.lock")
            if identity?.rsa == true {
                Toggle("Use RSA-PSS padding", isOn: $pss)
                    .accessibilityIdentifier("sign.pss")
            }
        } header: {
            Text("Options")
        } footer: {
            Text("Only the first signature in a file can certify it.")
        }
    }

    @ViewBuilder
    private var privacySection: some View {
        Section {
            Text("Signing happens on this device. Nothing is sent anywhere: no timestamp server and no certificate authority is asked, so the signature carries the time of this device's own clock.")
                .font(TextStyle.subheadline)
                .foregroundStyle(Surface.secondaryLabel)
                .accessibilityIdentifier("sign.privacy")
        }
    }

    // MARK: - Doing

    private static let identityTypes: [UTType] = [
        UTType(filenameExtension: "p12") ?? .data,
        UTType(filenameExtension: "pfx") ?? .data,
        .pkcs12,
    ]

    private func open() {
        guard let entry = chosen, let bytes = identities.bytes(of: entry) else {
            error = String(localized: "That certificate is no longer on this device.")
            return
        }
        opening = true
        let typed = password
        Task {
            do {
                identity = try await Signing.identity(in: bytes, password: typed)
                pss = false
            } catch {
                self.error = Signing.message(for: error)
            }
            opening = false
        }
    }

    private func sign() {
        guard let entry = chosen, let bytes = identities.bytes(of: entry) else { return }
        working = true
        let request = Signing.Request(
            p12: bytes,
            p12Password: password,
            visible: visible,
            page: page,
            position: position,
            signerName: identity?.name ?? "",
            reason: reason.trimmingCharacters(in: .whitespacesAndNewlines),
            location: location.trimmingCharacters(in: .whitespacesAndNewlines),
            contact: contact.trimmingCharacters(in: .whitespacesAndNewlines),
            certify: certify,
            lockFields: lockFields,
            pss: pss
        )
        Task {
            do {
                try await Signing.sign(request, on: model, undoManager: undoManager)
                signed = true
                onSigned()
                dismiss()
            } catch {
                self.error = Signing.message(for: error)
            }
            working = false
        }
    }

    private func forget(_ entry: SigningIdentities.Entry) {
        do {
            try identities.forgetIdentity(entry)
            stored = identities.identities()
            chosen = stored.first
            identity = nil
            password = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func importIdentity(_ result: Result<[URL], any Error>) {
        guard case .success(let urls) = result, let url = urls.first else {
            if case .failure(let failure) = result { error = failure.localizedDescription }
            return
        }
        do {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let entry = try identities.importIdentity(try Data(contentsOf: url), name: url.lastPathComponent)
            stored = identities.identities()
            chosen = entry
            identity = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
