import SwiftUI
import ZoodEngine

/// Protect through the engine: AES-256 open password + permissions (`protect.set`), or remove
/// protection (`protect.remove`). Both are whole rewrites by design; the recents picture of a
/// protected file is dropped.
struct ProtectSheet: View {
    @Bindable var session: DocumentSession
    @Environment(\.dismiss) private var dismiss
    @State private var user = ""
    @State private var confirm = ""
    @State private var owner = ""
    @State private var perms = Permissions()
    @State private var removeOwner = ""

    private var mismatch: Bool { !confirm.isEmpty && user != confirm }
    private var canApply: Bool { !user.isEmpty && user == confirm && user.count >= 4 }

    var body: some View {
        NavigationStack {
            Form {
                if session.isProtected {
                    Section {
                        Label("protect.current \(session.info?.encryption?.method ?? "AES")", systemImage: "lock.fill")
                        if session.info?.passwordMatched != "owner" {
                            SecureField("protect.ownerPassword", text: $removeOwner)
                        }
                        Button("protect.remove", role: .destructive) {
                            Task {
                                if await session.removeProtection(ownerPassword: removeOwner.isEmpty ? nil : removeOwner) {
                                    session.toast = Toast(message: String(localized: "protect.removed"))
                                    dismiss()
                                }
                            }
                        }
                    } footer: {
                        Text("protect.remove.footer")
                    }
                }
                Section {
                    SecureField("protect.userPassword", text: $user)
                        .textContentType(.newPassword)
                        .accessibilityIdentifier("protect.user")
                    SecureField("protect.confirmPassword", text: $confirm)
                        .textContentType(.newPassword)
                        .accessibilityIdentifier("protect.confirm")
                    if mismatch {
                        Text("protect.mismatch").foregroundStyle(.red).font(.footnote)
                    }
                } header: {
                    Text("protect.open.header")
                } footer: {
                    Text("protect.open.footer")
                }
                Section {
                    SecureField("protect.ownerPasswordOptional", text: $owner)
                    Toggle("protect.perm.print", isOn: $perms.print)
                    Toggle("protect.perm.copy", isOn: $perms.copy)
                    Toggle("protect.perm.modify", isOn: $perms.modify)
                    Toggle("protect.perm.annotate", isOn: $perms.annotate)
                    Toggle("protect.perm.fillForms", isOn: $perms.fillForms)
                } header: {
                    Text("protect.perms.header")
                } footer: {
                    Text("protect.perms.footer")
                }
            }
            .navigationTitle(Text(ToolKind.protect.title))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("common.cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("protect.apply") {
                        Task {
                            var p = perms
                            p.printHighQuality = perms.print
                            if await session.protect(user: user, owner: owner, permissions: p) {
                                session.toast = Toast(message: String(localized: "protect.applied"))
                                dismiss()
                            }
                        }
                    }
                    .disabled(!canApply || session.isBusy)
                    .accessibilityIdentifier("protect.apply")
                }
            }
        }
    }
}
