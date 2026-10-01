import Foundation

/// What a UI test may set from the command line, in Debug builds only.
@MainActor
enum DebugLaunch {
    private static var seeded = false

    /// `-warraqProfileJSON '{"nameArabic": …}'` seeds the autofill profile
    /// (an empty string clears it), so a test need not type it. Release
    /// builds ignore the argument.
    static func seedProfile() {
        #if DEBUG
        guard !seeded, let json = UserDefaults.standard.string(forKey: "warraqProfileJSON") else { return }
        seeded = true
        let store = ProfileStore()
        if json.isEmpty {
            try? store.delete()
        } else if let profile = try? JSONDecoder().decode(Profile.self, from: Data(json.utf8)) {
            try? store.save(profile)
        }
        #endif
    }
}
