import SwiftUI
import ZoodCore

/// "My details" for form autofill. Stored only on this device, in a file protected with Data
/// Protection "complete" (unreadable while the device is locked) and excluded from backups.
enum ProfileRepository {
    static var store: ProfileStore {
        ProfileStore(directory: URL.applicationSupportDirectory.appendingPathComponent("Profile", isDirectory: true))
    }
}

struct ProfileView: View {
    @Environment(\.locale) private var locale
    @State private var profile = ProfileRepository.store.load()
    @State private var saved = ProfileRepository.store.load()
    @State private var confirmClear = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                field("profile.nameArabic", text: $profile.fullNameArabic)
                    .environment(\.layoutDirection, .rightToLeft)
                field("profile.nameEnglish", text: $profile.fullNameEnglish)
                    .environment(\.layoutDirection, .leftToRight)
                    .textContentType(.name)
            } header: {
                Text("profile.section.name")
            }
            Section {
                field("profile.nationalID", text: $profile.nationalID)
                    .keyboardType(.numberPad)
                if !profile.nationalID.isEmpty && SaudiID.kind(profile.nationalID) == nil {
                    Label("profile.nationalID.check", systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
                field("profile.nationality", text: $profile.nationality)
                birthDate
            } header: {
                Text("profile.section.identity")
            }
            Section {
                field("profile.phone", text: $profile.phone)
                    .keyboardType(.phonePad).textContentType(.telephoneNumber)
                field("profile.email", text: $profile.email)
                    .keyboardType(.emailAddress).textContentType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                field("profile.address", text: $profile.address).textContentType(.fullStreetAddress)
                field("profile.city", text: $profile.city).textContentType(.addressCity)
                field("profile.postalCode", text: $profile.postalCode).textContentType(.postalCode)
            } header: {
                Text("profile.section.contact")
            }
            Section {
                field("profile.employer", text: $profile.employer).textContentType(.organizationName)
                field("profile.jobTitle", text: $profile.jobTitle).textContentType(.jobTitle)
            } header: {
                Text("profile.section.work")
            } footer: {
                Text("profile.footer")
            }
            Section {
                Button("profile.clear", role: .destructive) { confirmClear = true }
                    .disabled(saved.isEmpty && profile.isEmpty)
            }
            if let error { Text(verbatim: error).foregroundStyle(.red) }
        }
        .navigationTitle(Text("profile.title"))
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("common.save") {
                    do {
                        try ProfileRepository.store.save(profile)
                        saved = profile
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
                .disabled(profile == saved)
            }
        }
        .confirmationDialog(Text("profile.clear"), isPresented: $confirmClear, titleVisibility: .visible) {
            Button("profile.clear", role: .destructive) {
                try? ProfileRepository.store.clear()
                profile = UserProfile()
                saved = UserProfile()
            }
            Button("common.cancel", role: .cancel) {}
        } message: {
            Text("profile.clear.message")
        }
    }

    private func field(_ title: LocalizedStringKey, text: Binding<String>) -> some View {
        TextField(title, text: text)
    }

    /// Gregorian picker; the Hijri (Umm al-Qura) date is shown and derived, never typed twice.
    @ViewBuilder private var birthDate: some View {
        let has = Binding(
            get: { profile.birthDate != nil },
            set: { on in profile.dateOfBirth = on ? UserProfile.formatDate(profile.birthDate ?? Date(timeIntervalSince1970: 631_152_000)) : "" })
        Toggle("profile.dob", isOn: has)
        if let date = profile.birthDate {
            DatePicker(
                "profile.dob.gregorian",
                selection: Binding(get: { date }, set: { profile.dateOfBirth = UserProfile.formatDate($0) }),
                in: ...Date.now, displayedComponents: .date)
                .environment(\.calendar, Calendar(identifier: .gregorian))
                .environment(\.timeZone, TimeZone(identifier: "UTC")!)
            LabeledContent("profile.dob.hijri") {
                Text(verbatim: DateFormatting.hijri(date, locale: locale, timeZone: TimeZone(identifier: "UTC")!))
            }
        }
    }
}
