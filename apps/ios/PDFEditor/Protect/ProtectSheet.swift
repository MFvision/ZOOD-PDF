import SwiftUI
import WarraqCore

/// Protect: the password the document asks for when it is opened, and what a
/// reader may do with it. The protection is the core's AES-256 (`Protect`), so
/// a password in Arabic works and the file is as strong as the format allows.
///
/// Everything here is one screen: what protects the document now, the password
/// to set or change, the three permissions, and — when there is one — taking
/// the password off. Nothing is written to the file until the person saves.
struct ProtectSheet: View {
    let model: DocumentModel
    let undoManager: UndoManager?
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var confirmation = ""
    @State private var permissions = Protect.Permissions.all
    @State private var status: Protect.Status?
    @State private var working = false
    @State private var error: String?
    @State private var done = false

    /// Protected as far as the document knows: either we opened it with a
    /// password, or its metadata says it is encrypted. `status` refines this
    /// with what the `/Encrypt` dictionary actually says.
    private var protected: Bool {
        status?.protected ?? (model.password != nil || model.metadata?.encrypted == true)
    }

    var body: some View {
        NavigationStack {
            Form {
                if protected {
                    currentSection
                }
                passwordSection
                permissionsSection
                actionSection
                if protected {
                    removeSection
                }
            }
            .navigationTitle("Protect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("protect.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("sheet.done")
                }
            }
            .alert("Could not change the protection", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
        }
        // The whole sheet at once: what protects the document, the password,
        // the permissions and the button. At the medium detent the button sat
        // under the keyboard, which a person cannot reach any more than the
        // test could.
        .presentationDetents([.large])
        .sensoryFeedback(.success, trigger: done)
        .task {
            // Reading /Encrypt needs no password, so this works even for a
            // document we are looking at without one.
            status = await Protect.status(of: model.bytes)
            if let existing = status?.permissions { permissions = existing }
        }
    }

    // ----- what protects it now ---------------------------------------------

    @ViewBuilder
    private var currentSection: some View {
        Section {
            Label {
                if let status, status.protected, !status.methodName.isEmpty {
                    Text("Protected with \(status.methodName).")
                        .accessibilityIdentifier("protect.status")
                } else {
                    Text("This document is protected. It asks for its password when opened.")
                        .accessibilityIdentifier("protect.status")
                }
            } icon: {
                Image(systemName: "lock.fill")
                    .foregroundStyle(Color.accentColor)
            }
            if status?.isWeak == true {
                Label {
                    Text("This is an old, weak protection written by another program. Setting a password again replaces it with AES-256.")
                        .font(TextStyle.subheadline)
                        .accessibilityIdentifier("protect.weak")
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
            if status?.opensWithoutPassword == true {
                Text("It opens without a password: it carries only a permissions password.")
                    .font(TextStyle.subheadline)
                    .foregroundStyle(Surface.secondaryLabel)
                    .accessibilityIdentifier("protect.ownerOnly")
            }
        }
    }

    // ----- the password ------------------------------------------------------

    @ViewBuilder
    private var passwordSection: some View {
        Section {
            SecureField("Password", text: $password)
                .textContentType(.newPassword)
                .accessibilityIdentifier("protect.password")
            SecureField("Confirm the password", text: $confirmation)
                .textContentType(.newPassword)
                .accessibilityIdentifier("protect.confirm")
        } header: {
            Text(protected ? "Change the password" : "Set a password")
        } footer: {
            Text(footer)
                .foregroundStyle(tooLong || mismatch ? .red : Surface.secondaryLabel)
        }
    }

    private var footer: LocalizedStringKey {
        if tooLong {
            "The password is too long. At most \(Protect.maxPasswordBytes) bytes fit — about 63 Arabic letters, or 127 Latin ones."
        } else if mismatch {
            "The two passwords differ."
        } else {
            "Any language works, Arabic included. Anyone opening the document will be asked for it, and there is no way to recover a forgotten password."
        }
    }

    // ----- the permissions ---------------------------------------------------

    @ViewBuilder
    private var permissionsSection: some View {
        Section {
            Toggle("Printing", isOn: $permissions.print)
                .accessibilityIdentifier("protect.allowPrint")
            Toggle("Copying text and pictures", isOn: $permissions.copy)
                .accessibilityIdentifier("protect.allowCopy")
            Toggle("Changing the document", isOn: $permissions.change)
                .accessibilityIdentifier("protect.allowChange")
        } header: {
            Text("Allow, with the password")
        } footer: {
            // Say plainly what permissions are and are not: a reader that
            // chooses to ignore them can, and promising otherwise would be a
            // lie. Reading by a screen reader is always allowed.
            Text("The document records what it allows, and readers that honour it — this app among them — will. A reader that chooses to ignore it can. Reading aloud by a screen reader is always allowed.")
        }
    }

    // ----- doing it ----------------------------------------------------------

    @ViewBuilder
    private var actionSection: some View {
        Section {
            Button(action: set) {
                if working {
                    ProgressView()
                } else {
                    Text(protected ? "Change the password" : "Protect")
                }
            }
            .disabled(!canSet || working)
            .accessibilityIdentifier("protect.set")
        }
    }

    @ViewBuilder
    private var removeSection: some View {
        Section {
            Button("Remove the password", role: .destructive, action: remove)
                .disabled(working)
                .accessibilityIdentifier("protect.remove")
        } footer: {
            Text("Removing it writes the document without protection; Save keeps that.")
        }
    }

    // ----- state -------------------------------------------------------------

    private var mismatch: Bool { !confirmation.isEmpty && confirmation != password }
    private var tooLong: Bool { password.utf8.count > Protect.maxPasswordBytes }
    private var canSet: Bool { password == confirmation && Protect.isUsable(password) }

    private func set() {
        guard canSet else { return }
        working = true
        let chosen = password
        let chosenPermissions = permissions
        Task {
            do {
                try await Protect.setPassword(chosen, permissions: chosenPermissions, on: model, undoManager: undoManager)
                done = true
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            working = false
        }
    }

    private func remove() {
        working = true
        Task {
            do {
                try await Protect.removePassword(from: model, undoManager: undoManager)
                done = true
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            working = false
        }
    }
}
