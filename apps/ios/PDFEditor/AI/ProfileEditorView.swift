import SwiftUI

/// The autofill profile: every detail optional, kept in the Keychain the
/// moment it is typed, deleted in one press. Shown from Settings.
struct ProfileEditorView: View {
    @State private var profile: Profile
    @State private var saveError: String?
    @State private var confirmingDelete = false
    private let store: ProfileStore

    init(store: ProfileStore = ProfileStore()) {
        self.store = store
        _profile = State(initialValue: store.load())
    }

    var body: some View {
        Form {
            Section {
                field("Name in Arabic", key: .nameArabic, content: .name)
                field("Name in English", key: .nameEnglish, content: .name)
                field("National ID or Iqama", key: .nationalID, content: .oneTimeCode, keyboard: .numberPad)
                field("Phone", key: .phone, content: .telephoneNumber, keyboard: .phonePad)
                field("Email", key: .email, content: .emailAddress, keyboard: .emailAddress)
                field("Address", key: .address, content: .fullStreetAddress)
                field("Employer", key: .employer, content: .organizationName)
                field("Date of birth", key: .dateOfBirth, content: nil)
                field("IBAN", key: .iban, content: nil)
            } header: {
                Text("Your details")
            } footer: {
                Text("Kept in this device's Keychain, protected by its passcode. Used only when you fill a form, and never sent anywhere.")
            }
            if !profile.isEmpty {
                Section {
                    Button("Delete my details", role: .destructive) {
                        confirmingDelete = true
                    }
                    .accessibilityIdentifier("profile.delete")
                }
            }
        }
        .navigationTitle("Autofill profile")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("profile.form")
        .onChange(of: profile) { _, changed in
            do {
                try store.save(changed)
            } catch {
                saveError = String(localized: "Could not keep your details in the Keychain.")
            }
        }
        .confirmationDialog("Delete your details from this device?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                profile = Profile()
            }
        }
        .alert("Could not save", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveError ?? "")
        }
    }

    private func field(_ title: LocalizedStringKey, key: ProfileKey, content: UITextContentType?, keyboard: UIKeyboardType = .default) -> some View {
        LabeledContent(title) {
            TextField(title, text: Binding(get: { profile[key] }, set: { profile[key] = $0 }))
                .multilineTextAlignment(.trailing)
                .textContentType(content)
                .keyboardType(keyboard)
                .autocorrectionDisabled()
                .accessibilityIdentifier("profile.\(key.rawValue)")
        }
    }
}
