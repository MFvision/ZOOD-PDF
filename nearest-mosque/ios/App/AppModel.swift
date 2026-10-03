import Foundation
import NMCore
import NMData
import SwiftUI

/// The location prayer times are calculated for: separate from the device position and map centre.
struct PrayerLocation: Codable, Equatable {
    enum Source: String, Codable { case city, device }
    var name: String
    var latitude: Double
    var longitude: Double
    var zoneId: String
    var countryCode: String?
    var source: Source
    var zoneConfirmed = true

    var location: LatLng { LatLng(latitude, longitude) ?? Qibla.kaaba }
    var zone: TimeZone { TimeZone(identifier: zoneId) ?? .current }
}

/// Persistent settings (UserDefaults; nothing leaves the device).
struct StoredSettings: Codable, Equatable {
    var location: PrayerLocation?
    var followDevice = false
    var prayer = PrayerSettings()
    var methodChosenByUser = false
    var reminders: Set<PrayerEvent> = []
}

/// App-wide state and services. The UI reads computed values only from local storage and
/// deterministic services; nothing here performs network requests.
@MainActor
@Observable
final class AppModel {
    let l10n = Localization()
    let location = LocationService()
    let calculator = PrayerCalculator()
    private(set) var db: AppDatabase?
    private(set) var packs: PackManager?
    private(set) var mosques: MosqueRepository?
    private(set) var ask: AskRepository?
    private(set) var cities: CityIndex?
    private(set) var ready = false
    private(set) var storageError: String?

    var settings: StoredSettings {
        didSet { save() }
    }

    init() {
        if let data = UserDefaults.standard.data(forKey: "settings"), let s = try? JSONDecoder().decode(StoredSettings.self, from: data) {
            settings = s
        } else {
            settings = StoredSettings()
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(settings) { UserDefaults.standard.set(data, forKey: "settings") }
    }

    var packsRoot: URL? { Bundle.main.url(forResource: "packs", withExtension: nil) }

    /// Opens the database and installs built-in packs off the main thread on first launch.
    func start() async {
        guard !ready else { return }
        let root = packsRoot
        let stopData = Bundle.main.url(forResource: "stopwords", withExtension: "json").flatMap { try? Data(contentsOf: $0) } ?? Data()
        do {
            let opened: (AppDatabase, PackManager, CityIndex?) = try await Task.detached(priority: .userInitiated) {
                let db = try AppDatabase.onDisk()
                let packs = PackManager(db: db, bundledRoot: root)
                packs.ensureBuiltins()
                let tsv = root.flatMap { try? String(contentsOf: $0.appendingPathComponent("cities/cities.tsv"), encoding: .utf8) }
                return (db, packs, tsv.map(CityIndex.parse))
            }.value
            db = opened.0
            packs = opened.1
            cities = opened.2
            mosques = MosqueRepository(db: opened.0)
            ask = AskRepository(db: opened.0, stopwords: AskRepository.parseStopwords(stopData))
        } catch {
            storageError = error.localizedDescription
        }
        ready = true
        if settings.followDevice, location.isAuthorized { await useDeviceLocation(silent: true) }
        await rescheduleReminders()
    }

    // MARK: Prayer location

    func choose(city: City) {
        let name = city.displayName(l10n.language)
        settings.location = PrayerLocation(name: name, latitude: city.location.latitude, longitude: city.location.longitude,
                                           zoneId: city.zoneId, countryCode: city.countryCode, source: .city)
        settings.followDevice = false
        if !settings.methodChosenByUser { settings.prayer.method = PrayerCalculator.suggestedMethod(city.countryCode) }
        Task { await rescheduleReminders() }
    }

    enum LocateOutcome { case ok, denied, noFix }

    /// Uses a fresh fix (recent fix as fallback); never substitutes a default city.
    @discardableResult
    func useDeviceLocation(silent: Bool = false) async -> LocateOutcome {
        guard let fix = await location.currentPosition() else { return location.isDenied ? .denied : .noFix }
        let resolver = cities.map(TimeZoneResolver.init)
        let z = resolver?.resolve(fix.location, deviceZone: .current)
        let near = (z?.distanceMeters ?? .infinity) < 30_000 ? z?.nearestCity : nil
        settings.location = PrayerLocation(
            name: near?.displayName(l10n.language) ?? l10n.t("location_current"),
            latitude: fix.location.latitude, longitude: fix.location.longitude,
            zoneId: (z?.zone ?? .current).identifier, countryCode: z?.nearestCity?.countryCode, source: .device,
            zoneConfirmed: !(z?.needsConfirmation ?? true)
        )
        settings.followDevice = true
        if !settings.methodChosenByUser { settings.prayer.method = PrayerCalculator.suggestedMethod(z?.nearestCity?.countryCode) }
        await rescheduleReminders()
        return .ok
    }

    func setMethod(_ m: PrayerMethod) {
        settings.prayer.method = m
        settings.methodChosenByUser = true
        Task { await rescheduleReminders() }
    }

    func setReminder(_ e: PrayerEvent, _ on: Bool) async {
        if on, !(await Reminders.authorized()) { _ = await Reminders.requestAuthorization() }
        if on { settings.reminders.insert(e) } else { settings.reminders.remove(e) }
        await rescheduleReminders()
    }

    func rescheduleReminders() async {
        await Reminders.reschedule(location: settings.location, settings: settings.prayer, enabled: settings.reminders, l10n: l10n)
    }

    // MARK: Prayer schedule (cached per location/settings/date; countdown recomputed from instants)

    // Not observed: a cache filled during view evaluation must not trigger re-renders.
    @ObservationIgnored private var cacheKey: String?
    @ObservationIgnored private var cached: [DaySchedule] = []

    func days(now: Date) -> [DaySchedule] {
        guard let loc = settings.location else { return [] }
        let today = CivilDate.of(now, in: loc.zone)
        let key = "\(loc.latitude),\(loc.longitude),\(loc.zoneId),\(today),\(String(describing: settings.prayer))"
        if key != cacheKey {
            cached = (-1...1).map { calculator.schedule(loc.location, date: today.adding(days: $0), zone: loc.zone, settings: settings.prayer) }
            cacheKey = key
        }
        return cached
    }
}
