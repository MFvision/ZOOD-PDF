import Foundation
import NMCore
import UserNotifications

/// Local prayer reminders. iOS allows 64 pending notifications per app, so a bounded horizon is
/// scheduled and rebuilt whenever the app opens or settings change. Standard notification sound
/// only (under 30 s); no background audio is kept alive.
enum Reminders {
    static let maxPending = 60

    static func authorized() async -> Bool {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        return s.authorizationStatus == .authorized || s.authorizationStatus == .provisional
    }

    static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
    }

    /// Returns the number of days covered.
    @discardableResult
    static func reschedule(location: PrayerLocation?, settings: PrayerSettings, enabled: Set<PrayerEvent>, l10n: Localization, now: Date = Date()) async -> Int {
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()
        guard let loc = location, !enabled.isEmpty, await authorized() else { return 0 }
        let calc = PrayerCalculator()
        let today = CivilDate.of(now, in: loc.zone)
        var count = 0, days = 0
        dayLoop: for d in 0..<14 {
            let s = calc.schedule(loc.location, date: today.adding(days: d), zone: loc.zone, settings: settings)
            for e in PrayerEvent.prayers where enabled.contains(e) {
                guard let at = s[e], at > now else { continue }
                if count >= maxPending { break dayLoop }
                let content = UNMutableNotificationContent()
                content.title = l10n.t("reminder_title", l10n.t(Format.prayerKey(e)))
                content.body = l10n.t("reminder_body", loc.name, Format.time(at, zone: loc.zone, locale: l10n.locale))
                content.sound = .default
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: at.timeIntervalSince(now), repeats: false)
                try? await center.add(UNNotificationRequest(identifier: "prayer-\(d)-\(e.rawValue)", content: content, trigger: trigger))
                count += 1
            }
            days = d + 1
        }
        return days
    }
}
