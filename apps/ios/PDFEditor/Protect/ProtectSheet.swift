import PDFKit
import SwiftUI
import WarraqCore

/// Protect: set a password on the document, or take it off. PDFKit writes
/// the protection (a whole rewrite, as the format needs); every edit the
/// core appends afterwards keeps it, and the file asks for the password
/// when it is opened again.
struct ProtectSheet: View {
    let model: DocumentModel
    let undoManager: UndoManager?
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var confirmation = ""
    @State private var working = false
    @State private var error: String?
    @State private var done = false

    private var protected: Bool { model.password != nil || model.metadata?.encrypted == true }

    var body: some View {
        NavigationStack {
            Form {
                if protected {
                    Section {
                        Label {
                            Text("This document is protected. It asks for its password when opened.")
                        } icon: {
                            Image(systemName: "lock.fill")
                                .foregroundStyle(Color.accentColor)
                        }
                        .accessibilityIdentifier("protect.status")
                        Button("Remove the password", role: .destructive, action: remove)
                            .disabled(working)
                            .accessibilityIdentifier("protect.remove")
                    } footer: {
                        Text("Removing it writes the document without protection; Save keeps that.")
                    }
                } else {
                    Section {
                        SecureField("Password", text: $password)
                            .textContentType(.newPassword)
                            .accessibilityIdentifier("protect.password")
                        SecureField("Confirm the password", text: $confirmation)
                            .textContentType(.newPassword)
                            .accessibilityIdentifier("protect.confirm")
                    } header: {
                        Text("Set a password")
                    } footer: {
                        Text(mismatch ? "The two passwords differ." : "Anyone opening the document will be asked for it. There is no way to recover a forgotten password.")
                            .foregroundStyle(mismatch ? .red : .secondary)
                    }
                    Section {
                        Button(action: set) {
                            if working {
                                ProgressView()
                            } else {
                                Text("Protect")
                            }
                        }
                        .disabled(!canSet || working)
                        .accessibilityIdentifier("protect.set")
                    }
                }
            }
            .navigationTitle("Protect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
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
        .presentationDetents([.medium, .large])
        .sensoryFeedback(.success, trigger: done)
    }

    private var mismatch: Bool { !confirmation.isEmpty && confirmation != password }
    private var canSet: Bool { !password.isEmpty && password == confirmation }

    private func set() {
        guard canSet else { return }
        working = true
        let chosen = password
        Task {
            do {
                try await Self.setPassword(chosen, on: model, undoManager: undoManager)
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
                try await Self.removePassword(from: model, undoManager: undoManager)
                done = true
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            working = false
        }
    }

    /// PDFKit rewrites the document encrypted (the format needs a whole
    /// write for that); the core then opens it with the password, and
    /// keeps the protection on every edit it appends.
    static func setPassword(_ password: String, on model: DocumentModel, undoManager: UndoManager?) async throws {
        guard let pdf = model.pdf else { throw CoreError.closed }
        let options: [PDFDocumentWriteOption: Any] = [
            .userPasswordOption: password,
            .ownerPasswordOption: password,
        ]
        guard let bytes = pdf.dataRepresentation(options: options) else {
            throw CoreError.io("PDFKit could not write the protected document")
        }
        try await model.replace(bytes: bytes, password: password, undoManager: undoManager)
    }

    /// The unlocked document written again without protection.
    static func removePassword(from model: DocumentModel, undoManager: UndoManager?) async throws {
        guard let pdf = model.pdf else { throw CoreError.closed }
        guard let bytes = pdf.dataRepresentation() else {
            throw CoreError.io("PDFKit could not write the document")
        }
        try await model.replace(bytes: bytes, password: nil, undoManager: undoManager)
    }
}
