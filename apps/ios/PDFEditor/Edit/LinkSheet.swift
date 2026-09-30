import SwiftUI
import WarraqCore

/// Where a link goes: an address, or a page of this document. The core takes
/// only http, https and mailto, at most 4096 bytes, and nothing that hides
/// itself — bidi controls and other invisible characters — so an address it
/// refuses is said to be refused here rather than written and forgotten.
struct LinkSheet: View {
    let edit: EditModel
    /// The area that was drawn, or the picked link's own.
    let draft: DraftLink
    /// The link being re-pointed, when there is one; nil for a new one.
    let existing: PageLink?
    @Environment(\.dismiss) private var dismiss
    @State private var goesToPage = false
    @State private var address = ""
    @State private var page = 1
    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Goes to", selection: $goesToPage) {
                        Text("An address").tag(false)
                        Text("A page").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("link.kind")
                }
                if goesToPage {
                    Section("A page") {
                        LabeledContent("Page") {
                            Stepper(value: $page, in: 1...max(edit.model.pageCount, 1)) {
                                Text(page, format: .number).tabularNumbers()
                            }
                            .accessibilityIdentifier("link.page")
                        }
                    }
                } else {
                    Section("An address") {
                        TextField("https://", text: $address)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .accessibilityIdentifier("link.address")
                    } footer: {
                        Text("Web addresses and e-mail addresses only (http, https, mailto).")
                    }
                }
            }
            .navigationTitle(existing == nil ? "Add a link" : "Where the link goes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        edit.draftLink = nil
                        dismiss()
                    }
                    .accessibilityIdentifier("link.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button(existing == nil ? "Add" : "Save", action: save)
                            .disabled(!goesToPage && address.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier("link.save")
                    }
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear {
            if let existing {
                goesToPage = existing.to.page != nil
                address = existing.to.uri ?? ""
                page = (existing.to.page ?? 0) + 1
            }
        }
    }

    private func save() {
        let to = goesToPage
            ? LinkTo(uri: nil, page: page - 1)
            : LinkTo(uri: address.trimmingCharacters(in: .whitespaces), page: nil)
        working = true
        Task {
            if let existing {
                await edit.update(existing, onPage: draft.page, rect: draft.rect, to: to)
            } else {
                await edit.addLink(rect: draft.rect, to: to, onPage: draft.page)
            }
            working = false
            edit.draftLink = nil
            dismiss()
        }
    }
}
