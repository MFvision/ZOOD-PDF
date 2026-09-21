import PDFKit
import SwiftUI
import WarraqCore

/// Protect: set a password on the document, or take it off. PDFKit writes
/// the protection (a whole rewrite, as the format needs; RC4 128-bit, its
/// writer's choice); every edit the core appends afterwards keeps it, and
/// the file asks for the password when it is opened again. Taking it off
/// is the core writing the document whole, unprotected.
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
                        Text(unusable ? "Use Latin letters, digits and symbols (up to 32): the PDF protection this device writes takes no others." : mismatch ? "The two passwords differ." : "Anyone opening the document will be asked for it. There is no way to recover a forgotten password.")
                            .foregroundStyle(unusable || mismatch ? .red : .secondary)
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
    private var unusable: Bool { !password.isEmpty && !Self.isUsable(password) }
    private var canSet: Bool { !password.isEmpty && password == confirmation && Self.isUsable(password) }

    /// PDFKit's writer protects with the standard handler's RC4, whose
    /// passwords are Latin-1 (PDFDocEncoding): letters, digits and
    /// symbols of the Latin script only. Anything else it silently drops.
    static func isUsable(_ password: String) -> Bool {
        !password.isEmpty && password.count <= 32 && password.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value <= 0xFF }
    }

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
        guard isUsable(password) else { throw CoreError.edit("the password must be Latin letters, digits and symbols") }
        guard let pdf = model.pdf else { throw CoreError.closed }
        let options: [PDFDocumentWriteOption: Any] = [
            .userPasswordOption: password,
            .ownerPasswordOption: password,
        ]
        guard let bytes = pdf.dataRepresentation(options: options) else {
            throw CoreError.io("PDFKit could not write the protected document")
        }
        // Never say a document is protected when it is not: the core must
        // refuse it without the password.
        if (try? await Core.open(bytes: bytes)) != nil {
            throw CoreError.edit("PDFKit wrote the document without protection")
        }
        try await model.replace(bytes: bytes, password: password, undoManager: undoManager)
    }

    /// The document written whole by the core without its protection: the
    /// core opened it with the password, so `pages.extract` of every page
    /// writes what it read — pages, marks, outline, information — as a
    /// new, unencrypted file. (PDFKit keeps the encryption on a plain
    /// rewrite of an unlocked document, so it is not asked.)
    static func removePassword(from model: DocumentModel, undoManager: UndoManager?) async throws {
        guard let core = await model.readyEngine() else { throw CoreError.closed }
        struct Args: Encodable { let pages: [Int] }
        let count = await core.pageCount
        let reply = try await core.call(op: "pages.extract", args: Args(pages: Array(0..<count)))
        guard let bytes = reply.blobs.first else { throw CoreError.badReply("pages.extract answered no file") }
        try await model.replace(bytes: bytes, password: nil, undoManager: undoManager)
    }
}
