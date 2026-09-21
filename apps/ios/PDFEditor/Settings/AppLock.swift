import LocalAuthentication
import Observation
import SwiftUI

/// The app lock: Face ID or Touch ID (the passcode as the fallback) before
/// the app shows anything, when it is turned on in Settings. Off by
/// default. Locks when the app leaves the foreground; unlocks with the
/// system's own prompt.
@MainActor @Observable
final class AppLock {
    enum State: Equatable {
        case unlocked
        case locked
        case failed(String)
    }

    private(set) var state: State = .unlocked
    private var checking = false

    var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: SettingsKey.appLock)
    }

    /// What this device can do: "Face ID", "Touch ID" or nothing.
    static var biometryName: String? {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else { return nil }
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return nil
        }
    }

    /// The policy to unlock with: biometrics where the device has them
    /// (the passcode is the system's own fallback on a device), else the
    /// passcode; nil where there is neither.
    static var policy: LAPolicy? {
        let context = LAContext()
        var error: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            return .deviceOwnerAuthenticationWithBiometrics
        }
        if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            return .deviceOwnerAuthentication
        }
        return nil
    }

    /// Whether the lock can be turned on: something to unlock with.
    static var canLock: Bool { policy != nil }

    func lock() {
        guard isEnabled else { return }
        state = .locked
    }

    /// Asks the system to unlock. Biometrics first, the passcode as the
    /// system's own fallback.
    func unlock() async {
        guard isEnabled, state != .unlocked, !checking else { return }
        checking = true
        defer { checking = false }
        let context = LAContext()
        context.localizedCancelTitle = String(localized: "Cancel")
        guard let policy = Self.policy else {
            // Nothing to unlock with any more (the passcode was removed): the
            // lock cannot hold, and says so rather than shutting the person out.
            state = .failed(String(localized: "Set up Face ID, Touch ID or a passcode on this device first."))
            UserDefaults.standard.set(false, forKey: SettingsKey.appLock)
            state = .unlocked
            return
        }
        do {
            let ok = try await context.evaluatePolicy(policy, localizedReason: String(localized: "Unlock to open your documents."))
            state = ok ? .unlocked : .failed(String(localized: "Not unlocked."))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

/// What is on screen while the app is locked: a blurred veil over the
/// content and one button.
struct LockScreen: View {
    let lock: AppLock

    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
            VStack(spacing: Space.x6) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 44, weight: .light))
                    .foregroundStyle(Surface.secondaryLabel)
                Text("Locked")
                    .font(TextStyle.title)
                if case let .failed(message) = lock.state {
                    Text(message)
                        .font(TextStyle.caption)
                        .foregroundStyle(Surface.secondaryLabel)
                        .multilineTextAlignment(.center)
                }
                Button {
                    Task { await lock.unlock() }
                } label: {
                    Label(String(localized: "Unlock"), systemImage: AppLock.biometryName == "Touch ID" ? "touchid" : "faceid")
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("lock.unlock")
            }
            .padding(Space.x8)
        }
        .accessibilityIdentifier("lock.screen")
        .task {
            await lock.unlock()
        }
    }
}
