import SwiftUI
import UniformTypeIdentifiers
import WarraqCore

/// Signatures: what the file's digital signatures come to, and the
/// certificates this device trusts when it decides that.
///
/// Every word here is the core's answer put into sentences. A signature that
/// is intact but whose signer nobody vouches for is never called valid, a time
/// is only an authority's when an authority trusted for timestamps stamped it,
/// and the name a signature gives itself is shown as the claim it is.
struct SignaturesSheet: View {
    let model: DocumentModel
    let undoManager: UndoManager?
    var identities = SigningIdentities()

    @Environment(\.dismiss) private var dismiss
    @State private var report: Signatures.Report?
    @State private var checking = true
    @State private var failed = false
    @State private var trusted: [SigningIdentities.Trusted] = []
    @State private var importingCertificate = false
    @State private var error: String?
    @State private var showingSign = false

    var body: some View {
        NavigationStack {
            List {
                if checking {
                    HStack(spacing: Space.x4) {
                        ProgressView()
                        Text("Checking the signatures…")
                            .foregroundStyle(Surface.secondaryLabel)
                    }
                    .accessibilityIdentifier("signatures.checking")
                } else if failed {
                    Label("The signatures in this file could not be checked.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("signatures.failed")
                } else if report?.signatures.isEmpty ?? true {
                    Text("This file has no digital signatures.")
                        .foregroundStyle(Surface.secondaryLabel)
                        .accessibilityIdentifier("signatures.none")
                }

                ForEach(report?.signatures ?? []) { signature in
                    Section {
                        SignatureCard(signature: signature, onTrust: trust)
                    }
                }

                if let report, !report.emptyFields.isEmpty {
                    Section {
                        Text("Empty signature fields: \(report.emptyFields.map(Signatures.isolate).formatted(.list(type: .and)))")
                            .font(TextStyle.subheadline)
                            .accessibilityIdentifier("signatures.emptyFields")
                    }
                }

                if let dss = report?.dss, !dss.isEmpty {
                    Section {
                        Text("Validation data in the file: \(dss.certs) certificates, \(dss.ocsps) status answers, \(dss.crls) revocation lists.")
                            .font(TextStyle.subheadline)
                            .foregroundStyle(Surface.secondaryLabel)
                    }
                }

                signSection
                trustSection
                networkNote
            }
            .navigationTitle("Signatures")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("sheet.done")
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Check again", systemImage: "arrow.clockwise") { Task { await check() } }
                        .accessibilityIdentifier("signatures.recheck")
                        .disabled(checking)
                }
            }
            .alert("Could not do that", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
            .fileImporter(
                isPresented: $importingCertificate,
                allowedContentTypes: Self.certificateTypes,
                allowsMultipleSelection: false,
                onCompletion: importCertificate
            )
            .sheet(isPresented: $showingSign) {
                SignSheet(model: model, undoManager: undoManager, identities: identities) {
                    Task { await check() }
                }
            }
        }
        .presentationDetents([.large])
        .task {
            trusted = identities.trusted()
            await check()
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var signSection: some View {
        Section {
            Button("Sign this document…", systemImage: "signature") { showingSign = true }
                .accessibilityIdentifier("signatures.sign")
                .disabled(!model.isReady || report?.certified == 1)
        } footer: {
            if report?.certified == 1 {
                Text("This document is certified so that no changes are allowed, so it cannot be signed again.")
                    .accessibilityIdentifier("signatures.certifiedLocked")
            } else {
                Text("The file is signed as it stands, with every change made so far. Anything changed afterwards is added after the signature and listed when it is checked.")
            }
        }
    }

    @ViewBuilder
    private var trustSection: some View {
        Section {
            if trusted.isEmpty {
                Text("None yet, so no signer's identity is verified.")
                    .foregroundStyle(Surface.secondaryLabel)
                    .accessibilityIdentifier("signatures.trusted.none")
            }
            ForEach(trusted) { certificate in
                HStack {
                    Text(certificate.name)
                        .lineLimit(2)
                    Spacer()
                    Button("Stop trusting \(Signatures.isolate(certificate.name))", systemImage: "trash") {
                        forget(certificate)
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.red)
                }
            }
            Button("Trust a certificate from a file…", systemImage: "plus") { importingCertificate = true }
                .accessibilityIdentifier("signatures.trust.add")
        } header: {
            Text("Certificates you trust")
        } footer: {
            Text("Trust is kept on this device only. Trust a certificate only if you know it vouches for who signs documents — for example your organization's or your country's certification authority.")
        }
    }

    @ViewBuilder
    private var networkNote: some View {
        Section {
            Text("Nothing is fetched while checking: revocation is only what the file itself carries, and no timestamp server is asked. A trusted timestamp and fresh revocation data need the network, and are added by the desktop app.")
                .font(TextStyle.subheadline)
                .foregroundStyle(Surface.secondaryLabel)
                .accessibilityIdentifier("signatures.networkNote")
        }
    }

    // MARK: - Doing

    private static let certificateTypes: [UTType] = [
        UTType(filenameExtension: "cer") ?? .data,
        UTType(filenameExtension: "crt") ?? .data,
        UTType(filenameExtension: "der") ?? .data,
        UTType(filenameExtension: "pem") ?? .data,
        UTType(filenameExtension: "p7b") ?? .data,
        UTType(filenameExtension: "p7c") ?? .data,
        .x509Certificate,
    ]

    private func check() async {
        checking = true
        failed = false
        let bytes = model.bytes
        guard Signatures.mightBeSigned(bytes) else {
            report = Signatures.Report()
            checking = false
            return
        }
        do {
            report = try await Signatures.verify(bytes: bytes, password: model.password, trusted: trusted)
        } catch {
            // Never leave a stale answer on the screen as if it were this
            // file's: say plainly that it could not be checked.
            report = nil
            failed = true
        }
        checking = false
    }

    private func trust(_ signature: Signatures.Signature) {
        guard let der = signature.trustCandidateDER else { return }
        // What trusting would trust: the signer's own certificate when it is
        // not for signing documents at all, else the top of its path.
        let forItself = signature.problems.contains { $0 == "eku" || $0 == "eku:web" || $0.hasPrefix("ekuCa:") }
        let name = (forItself ? signature.signer?.name : signature.chain?.certs.last?.name) ?? signature.signedBy
        do {
            try identities.trust([SigningIdentities.Trusted(name: name, der: der)])
            trusted = identities.trusted()
            Task { await check() }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func forget(_ certificate: SigningIdentities.Trusted) {
        do {
            try identities.forgetTrusted(certificate.der)
            trusted = identities.trusted()
            Task { await check() }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func importCertificate(_ result: Result<[URL], any Error>) {
        guard case .success(let urls) = result, let url = urls.first else {
            if case .failure(let failure) = result { error = failure.localizedDescription }
            return
        }
        Task {
            do {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let found = try await SigningIdentities.certificates(in: try Data(contentsOf: url))
                guard !found.isEmpty else {
                    error = String(localized: "No certificate was found in that file.")
                    return
                }
                try identities.trust(found)
                trusted = identities.trusted()
                await check()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// One signature, said in full: what it came to and why, who signed, when, and
/// what changed afterwards. The checks are inside, each worded so that a
/// failed one is never read aloud as a passed one.
private struct SignatureCard: View {
    let signature: Signatures.Signature
    let onTrust: (Signatures.Signature) -> Void
    @State private var showingDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.x4) {
            Label {
                Text(signature.status.text)
                    .font(TextStyle.headline)
            } icon: {
                Image(systemName: signature.status.symbol)
                    .foregroundStyle(signature.status.tint)
            }
            .accessibilityIdentifier("signature.status")

            if let why = signature.why {
                Text(why)
                    .font(TextStyle.subheadline)
                    .foregroundStyle(Surface.secondaryLabel)
            }

            LabeledContent("Signed by") {
                Text(signature.signedBy.isEmpty ? String(localized: "Unknown signer") : signature.signedBy)
                    .multilineTextAlignment(.trailing)
            }
            .accessibilityIdentifier("signature.signer")

            if let claimed = signature.claimedName, claimed != signature.signedBy {
                Text("The signature calls its signer \(Signatures.isolate(claimed)) — the signer's own claim, not verified.")
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
            }

            Text(signature.kindText)
                .font(TextStyle.subheadline)
                .foregroundStyle(Surface.secondaryLabel)

            timeLine

            if let reason = signature.reason, !reason.isEmpty {
                LabeledContent("Reason", value: reason)
            }
            if let location = signature.location, !location.isEmpty {
                LabeledContent("Place", value: location)
            }

            if !signature.changes.isEmpty {
                VStack(alignment: .leading, spacing: Space.x2) {
                    Text("Changed after this signature")
                        .font(TextStyle.subheadline)
                    ForEach(Array(signature.changes.enumerated()), id: \.offset) { _, change in
                        // Two sentences side by side rather than one built by
                        // hand: each is translated whole, and Arabic puts them
                        // in its own order.
                        HStack(alignment: .firstTextBaseline, spacing: Space.x2) {
                            Text(change.text)
                            Text(change.allowed ? "— permitted by this signature" : "— not permitted")
                        }
                        .font(TextStyle.caption)
                        .foregroundStyle(change.allowed ? Surface.secondaryLabel : .red)
                    }
                }
                .accessibilityIdentifier("signature.changes")
            }

            if signature.status == .untrusted, signature.trustCandidateDER != nil {
                Button("Trust \(Signatures.isolate(trustName))", systemImage: "checkmark.seal") { onTrust(signature) }
                    .accessibilityIdentifier("signature.trust")
            }

            DisclosureGroup("Details", isExpanded: $showingDetails) {
                details
            }
            .accessibilityIdentifier("signature.details")
        }
        .padding(.vertical, Space.x2)
    }

    /// The certificate the Trust button would trust, named so the person knows
    /// what they would be vouching for.
    private var trustName: String {
        let forItself = signature.problems.contains { $0 == "eku" || $0 == "eku:web" || $0.hasPrefix("ekuCa:") }
        return (forItself ? signature.signer?.name : signature.chain?.certs.last?.name) ?? signature.signedBy
    }

    @ViewBuilder
    private var timeLine: some View {
        if let stamped = signature.stampedTime {
            Text("Timestamped \(date(stamped.time)) by \(Signatures.isolate(stamped.authority))")
                .font(TextStyle.subheadline)
                .accessibilityIdentifier("signature.time")
        } else if let claimed = signature.claimedTime {
            Text("Signed \(date(claimed)) — by the signer's own clock")
                .font(TextStyle.subheadline)
                .accessibilityIdentifier("signature.time")
        }
        if let timestamp = signature.timestamp, timestamp.valid, !timestamp.trusted {
            Text("Its timestamp is from \(Signatures.isolate(timestamp.authority)), an authority you do not trust: its time is not relied on.")
                .font(TextStyle.caption)
                .foregroundStyle(Surface.secondaryLabel)
        }
    }

    @ViewBuilder
    private var details: some View {
        VStack(alignment: .leading, spacing: Space.x3) {
            check(signature.integrity.byteRangeOk, byteRangeText)
            check(signature.integrity.digestOk,
                  signature.integrity.digestOk
                      ? "The file matches what was signed"
                      : "The file does not match what was signed")
            check(signature.integrity.signatureOk,
                  signature.integrity.signatureOk
                      ? "The signature verifies (\(algorithm))"
                      : "The signature does not verify (\(algorithm))")
            check(signature.chain?.trust.state == "trusted" && signature.chain?.purposeOk == true,
                  signature.chain?.trust.text ?? "Who signed is not established")
            check(signature.chain?.validAtTime ?? false,
                  (signature.chain?.validAtTime ?? false)
                      ? "The certificates were valid at the time checked"
                      : "A certificate was not valid at the time checked")
            if let timestamp = signature.timestamp {
                check(timestamp.valid && timestamp.trusted, timestampText(timestamp))
            }
            check(signature.revocation.status == "good", signature.revocation.text)
            Text(signature.integrity.coversWholeFile
                ? "Nothing was added to the file after this signature."
                : "The file was updated after this signature; the changes are listed above.")
                .font(TextStyle.caption)
                .foregroundStyle(Surface.secondaryLabel)

            if let certs = signature.chain?.certs, !certs.isEmpty {
                Text("Certificate chain")
                    .font(TextStyle.subheadline)
                ForEach(Array(certs.enumerated()), id: \.offset) { _, certificate in
                    VStack(alignment: .leading, spacing: Space.x1) {
                        Text(certificate.name).font(TextStyle.caption).bold()
                        Text("Issued by \(Signatures.isolate(certificate.issuer)) · valid until \(certificate.notAfter)")
                            .font(TextStyle.caption)
                            .foregroundStyle(Surface.secondaryLabel)
                    }
                }
            }
        }
        .padding(.top, Space.x2)
    }

    private var algorithm: String {
        signature.integrity.algorithm.isEmpty ? "—" : signature.integrity.algorithm
    }

    private var byteRangeText: LocalizedStringKey {
        if signature.integrity.byteRangeOk {
            "The signature covers the file it belongs to"
        } else if signature.hasProblem("notInRevision") {
            "The signature does not cover the revision it belongs to"
        } else {
            "The range of the file the signature covers is not right"
        }
    }

    private func timestampText(_ timestamp: Signatures.Timestamp) -> LocalizedStringKey {
        if !timestamp.valid {
            "Its timestamp does not verify: \(Signatures.isolate(timestamp.authority))"
        } else if timestamp.trusted {
            "Timestamp verified: \(Signatures.isolate(timestamp.authority))"
        } else {
            "The timestamp verifies, but \(Signatures.isolate(timestamp.authority)) is not an authority you trust"
        }
    }

    /// One check. Its words say whether it passed — a failed check is never
    /// read aloud as a passed one; the mark and the colour only repeat it.
    @ViewBuilder
    private func check(_ ok: Bool, _ label: LocalizedStringKey) -> some View {
        Label {
            Text(label).font(TextStyle.caption)
        } icon: {
            Image(systemName: ok ? "checkmark" : "xmark")
                .foregroundStyle(ok ? .green : .red)
                .accessibilityHidden(true)
        }
    }

    /// An ISO time as the person's locale writes it; an unreadable one is
    /// printed as it stands rather than guessed at.
    private func date(_ iso: String) -> String {
        guard let parsed = ISO8601DateFormatter().date(from: iso) else { return iso }
        return parsed.formatted(date: .abbreviated, time: .shortened)
    }
}
