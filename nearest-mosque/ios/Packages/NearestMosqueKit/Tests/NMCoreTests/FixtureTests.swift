import Foundation
import XCTest
@testable import NMCore

/// Locates nearest-mosque/ (holding shared/ and packs/) from this file's path.
enum Fixtures {
    static let root: URL = {
        var u = URL(fileURLWithPath: #filePath)
        while u.path != "/" {
            u.deleteLastPathComponent()
            if FileManager.default.fileExists(atPath: u.appendingPathComponent("shared/fixtures").path) { return u }
        }
        fatalError("shared/fixtures not found")
    }()

    static func json(_ path: String) -> [String: Any] {
        let data = try! Data(contentsOf: root.appendingPathComponent(path))
        return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    static func quranChunks() -> [SourceChunk] {
        let text = try! String(contentsOf: root.appendingPathComponent("packs/sources/quran-tanzil-pickthall/chunks.jsonl"), encoding: .utf8)
        let dec = JSONDecoder()
        return text.split(separator: "\n").map { try! dec.decode(SourceChunk.self, from: Data($0.utf8)) }
    }

    static func stopwords() -> [String: [String]] {
        json("shared/content/stopwords.json").filter { !$0.key.hasPrefix("_") }.mapValues { $0 as! [String] }
    }

    static func retriever() -> Retriever {
        let qdata = try! Data(contentsOf: root.appendingPathComponent("packs/sources/quran-tanzil-pickthall/common-questions.json"))
        let qs = try! JSONDecoder().decode(CommonQuestionsFile.self, from: qdata).questions
        return Retriever(store: InMemoryChunkStore(quranChunks()), commonQuestions: qs, stopwords: stopwords())
    }
}

final class PrayerFixtureTests: XCTestCase {
    let calc = PrayerCalculator()

    func testGoldenFixturesMatchIndependentReference() throws {
        let f = Fixtures.json("shared/fixtures/prayer-times.json")
        let tol = f["toleranceSeconds"] as! Double
        let iso = ISO8601DateFormatter()
        var failures: [String] = []
        for c in f["cases"] as! [[String: Any]] {
            let id = c["id"] as! String
            let loc = LatLng(c["latitude"] as! Double, c["longitude"] as! Double)!
            let zone = TimeZone(identifier: c["timeZone"] as! String)!
            let date = CivilDate(iso: c["date"] as! String)!
            var s = PrayerSettings(method: PrayerMethod(rawValue: c["method"] as! String)!, madhab: AsrMadhab(rawValue: c["madhab"] as! String)!)
            if let r = c["highLatitudeRule"] as? String { s.highLatitudeRule = HighLatRule(rawValue: r)! }
            let sch = calc.schedule(loc, date: date, zone: zone, settings: s)
            guard let expected = c["expected"] as? [String: String] else {
                if sch.status != .unavailable || !sch.times.isEmpty { failures.append("\(id): expected unavailable, got \(sch.status)") }
                continue
            }
            guard sch.status == .normal else { failures.append("\(id): \(sch.status)"); continue }
            for (k, v) in expected {
                let want = iso.date(from: v)!
                let got = sch[PrayerEvent(rawValue: k)!]!
                let diff = abs(got.timeIntervalSince(want))
                if diff > tol { failures.append("\(id) \(k): off by \(Int(diff))s") }
            }
            XCTAssertEqual(CivilDate.of(sch[.dhuhr]!, in: zone), date, id)
        }
        XCTAssert(failures.isEmpty, failures.joined(separator: "\n"))
    }

    func testPolarNightOnlyUsesExplicitFallback() {
        let tromso = LatLng(69.6492, 18.9553)!
        let zone = TimeZone(identifier: "Europe/Oslo")!
        let d = CivilDate(year: 2026, month: 12, day: 21)
        XCTAssertEqual(calc.schedule(tromso, date: d, zone: zone, settings: PrayerSettings()).status, .unavailable)
        let est = calc.schedule(tromso, date: d, zone: zone, settings: PrayerSettings(polarRule: .NEAREST_LATITUDE))
        XCTAssertEqual(est.status, .estimated(latitudeUsed: 48.5))
        XCTAssertEqual(est.times.count, 6)
    }

    func testNextPrayerSkipsSunriseAndRollsOverAfterIsha() {
        let makkah = LatLng(21.4225, 39.8262)!
        let zone = TimeZone(identifier: "Asia/Riyadh")!
        let s = PrayerSettings(method: .UMM_AL_QURA)
        let today = calc.schedule(makkah, date: CivilDate(year: 2026, month: 10, day: 3), zone: zone, settings: s)
        let afterFajr = today[.fajr]!.addingTimeInterval(60)
        XCTAssertEqual(calc.nextPrayer(makkah, now: afterFajr, zone: zone, settings: s)?.event, .dhuhr)
        XCTAssertEqual(calc.fajrEndsAt(today, now: afterFajr), today[.sunrise])
        let n = calc.nextPrayer(makkah, now: today[.isha]!.addingTimeInterval(60), zone: zone, settings: s)!
        XCTAssertEqual(n.event, .fajr)
        XCTAssertTrue(n.isTomorrow)
        XCTAssertEqual(n.periodStart, today[.isha])
    }

    func testRamadanIshaExtensionUmmAlQura() {
        let makkah = LatLng(21.4225, 39.8262)!
        let zone = TimeZone(identifier: "Asia/Riyadh")!
        let s = PrayerSettings(method: .UMM_AL_QURA)
        let ramadan = CivilDate(year: 2026, month: 3, day: 1)
        XCTAssertTrue(HijriCalendar.isRamadan(ramadan, adjustmentDays: 0))
        let r = calc.schedule(makkah, date: ramadan, zone: zone, settings: s)
        XCTAssertEqual(r[.isha]!.timeIntervalSince(r[.maghrib]!), 120 * 60, accuracy: 60)
        let normal = calc.schedule(makkah, date: CivilDate(year: 2026, month: 10, day: 3), zone: zone, settings: s)
        XCTAssertEqual(normal[.isha]!.timeIntervalSince(normal[.maghrib]!), 90 * 60, accuracy: 60)
    }

    func testDstCountdownFromInstants() {
        let london = LatLng(51.5085, -0.1257)!
        let zone = TimeZone(identifier: "Europe/London")!
        var cal = Calendar(identifier: .gregorian); cal.timeZone = zone
        let now = cal.date(from: DateComponents(year: 2026, month: 3, day: 28, hour: 23, minute: 30))!
        let next = calc.nextPrayer(london, now: now, zone: zone, settings: PrayerSettings())!
        XCTAssertEqual(next.event, .fajr)
        let minutes = PrayerCalculator.remaining(now, next.at) / 60
        XCTAssert((270...280).contains(minutes), "\(minutes)")
    }
}

final class QiblaAndTextTests: XCTestCase {
    func testQiblaFixtures() {
        let f = Fixtures.json("shared/fixtures/qibla.json")
        for c in f["cases"] as! [[String: Any]] {
            let p = LatLng(c["latitude"] as! Double, c["longitude"] as! Double)!
            XCTAssertEqual(Angles.normalize180(Qibla.bearing(from: p) - (c["bearingDegrees"] as! Double)), 0, accuracy: f["toleranceDegrees"] as! Double, c["id"] as! String)
            XCTAssertEqual(Qibla.distanceMeters(from: p), c["distanceMeters"] as! Double, accuracy: f["distanceToleranceMeters"] as! Double)
        }
    }

    func testAnglesSmootherAlignment() {
        XCTAssertEqual(Angles.relativeToQibla(qiblaBearingTrue: 2, headingTrue: 358), 4, accuracy: 1e-9)
        XCTAssertEqual(Angles.normalize180(-180), 180, accuracy: 1e-9)
        XCTAssertEqual(Angles.shortestTarget(current: 350, target: 10), 370, accuracy: 1e-9)
        XCTAssertEqual(Angles.trueHeading(magnetic: 1, declination: -3), 358, accuracy: 1e-9)
        var s = HeadingSmoother(alpha: 0.5)
        _ = s.update(358)
        for _ in 0..<10 { let h = s.update(2); XCTAssert(h > 350 || h < 10) }
        var a = AlignmentDetector()
        XCTAssertFalse(a.update(relativeDeg: 4, accuracyDeg: nil))
        XCTAssertTrue(a.update(relativeDeg: 4, accuracyDeg: 10))
        XCTAssertFalse(a.update(relativeDeg: 7, accuracyDeg: 10)); XCTAssertTrue(a.aligned)
        _ = a.update(relativeDeg: 9, accuracyDeg: 10); XCTAssertFalse(a.aligned)
    }

    func testNormalizationFixtures() {
        for c in Fixtures.json("shared/fixtures/normalization.json")["cases"] as! [[String: Any]] {
            XCTAssertEqual(TextNormalizer.tokens(c["input"] as! String), c["tokens"] as! [String], c["id"] as! String)
        }
    }

    func testRetrievalFixturesMatchReferenceExactly() {
        let r = Fixtures.retriever()
        var failures: [String] = []
        for c in Fixtures.json("shared/fixtures/retrieval.json")["cases"] as! [[String: Any]] {
            let res = r.retrieve(c["q"] as! String, context: c["context"] as? [String] ?? [])
            let ref = c["referenceResult"] as! [String: Any]
            let id = c["id"] as! String
            if res.kind.rawValue != ref["kind"] as! String { failures.append("\(id) kind \(res.kind)") }
            if res.commonQuestion?.id != ref["commonQuestionId"] as? String { failures.append("\(id) faq \(String(describing: res.commonQuestion?.id))") }
            if res.passages.map(\.chunkId) != ref["passages"] as! [String] { failures.append("\(id) passages \(res.passages.map(\.chunkId))") }
        }
        XCTAssert(failures.isEmpty, failures.joined(separator: "\n"))
    }

    func testGeneratedTextValidation() {
        XCTAssertTrue(AnswerComposer.validateGenerated("Wash the face [1].\nTayammum is allowed [1][2].", passageCount: 2))
        XCTAssertFalse(AnswerComposer.validateGenerated("Wash the face.", passageCount: 2))
        XCTAssertFalse(AnswerComposer.validateGenerated("Wash the face [3].", passageCount: 2))
    }
}

final class DataTests: XCTestCase {
    func testPacksVerifyAndTamperingIsDetected() throws {
        let packs = ["packs/cities", "packs/mosques/za-cape-town", "packs/mosques/eg-cairo", "packs/mosques/gb-london", "packs/sources/quran-tanzil-pickthall"]
        for p in packs {
            let dir = Fixtures.root.appendingPathComponent(p)
            let m = try PackVerifier.parseManifest(Data(contentsOf: dir.appendingPathComponent("manifest.json")))
            try PackVerifier.verify(m) { try? Data(contentsOf: dir.appendingPathComponent($0)) }
            XCTAssertEqual(Sha256.portableHex(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        }
        let dir = Fixtures.root.appendingPathComponent("packs/mosques/za-cape-town")
        let m = try PackVerifier.parseManifest(Data(contentsOf: dir.appendingPathComponent("manifest.json")))
        XCTAssertThrowsError(try PackVerifier.verify(m) { _ in Data("x".utf8) }) { XCTAssertEqual($0 as? PackError, .checksum("mosques.jsonl")) }
    }

    func testMosqueRankingAndZeroCoordinates() throws {
        XCTAssertNotNil(LatLng(0, 0))
        XCTAssertNil(LatLng(.nan, 0))
        XCTAssertNil(LatLng(91, 0))
        let a = Mosque(sourceId: "osm:node/1", packId: "p", category: .mosque, names: ["default": "Masjid Al-Noor"], location: LatLng(0, 0)!)
        let b = Mosque(sourceId: "osm:way/2", packId: "p", category: .mosque, names: ["default": "Masjid Al-Noor"], location: LatLng(0.00009, 0)!)
        let c = Mosque(sourceId: "osm:node/3", packId: "p", category: .mosque, names: ["default": "Other"], location: LatLng(0.00009, 0)!)
        XCTAssertEqual(MosqueRanking.rank(center: LatLng(0, 0)!, candidates: [b, c, a], radiusMeters: 1000).map(\.mosque.sourceId), ["osm:node/1", "osm:node/3"])
        let box = Geo.boundingBox(LatLng(-17.7, 179.9)!, radiusM: 20_000)
        XCTAssertTrue(box.crossesAntimeridian)
        XCTAssertTrue(box.contains(LatLng(-17.7, -179.95)!))
        let g = SearchGeneration(); let first = g.next(); let second = g.next()
        XCTAssertFalse(g.isCurrent(first)); XCTAssertTrue(g.isCurrent(second))
    }

    func testCitiesAndTimeZones() throws {
        let idx = CityIndex.parse(try String(contentsOf: Fixtures.root.appendingPathComponent("packs/cities/cities.tsv"), encoding: .utf8))
        XCTAssertEqual(idx.search("makk").first?.name, "Makkah")
        XCTAssertEqual(idx.search("مكة").first?.name, "Makkah")
        XCTAssertEqual(idx.search("İstanbul").first?.name, "Istanbul")
        let ct = idx.search("cape town").first!
        XCTAssertEqual(ct.displayName("ar"), "كيب تاون")
        XCTAssertEqual(ct.displayName("ur"), "کیپ ٹاؤن")
        let tz = TimeZoneResolver(idx)
        XCTAssertFalse(tz.resolve(LatLng(-33.95, 18.47)!, deviceZone: TimeZone(identifier: "Africa/Johannesburg")).needsConfirmation)
        XCTAssertEqual(tz.resolve(LatLng(-33.95, 18.47)!, deviceZone: TimeZone(identifier: "Africa/Maputo")).zone.identifier, "Africa/Maputo")
        let ocean = tz.resolve(LatLng(-40, -30)!, deviceZone: TimeZone(identifier: "UTC"))
        XCTAssertEqual(ocean.zone.secondsFromGMT(), 0)
        XCTAssertFalse(ocean.needsConfirmation)
        let traveller = tz.resolve(LatLng(-33.95, 18.47)!, deviceZone: TimeZone(identifier: "Europe/London"))
        XCTAssertEqual(traveller.zone.identifier, "Africa/Johannesburg")
        XCTAssertTrue(traveller.needsConfirmation)
        XCTAssertTrue(tz.resolve(LatLng(-40, -30)!, deviceZone: nil).needsConfirmation)
    }
}

final class OnlineMosquesTests: XCTestCase {
    private var sample: Data { try! Data(contentsOf: Fixtures.root.appendingPathComponent("shared/fixtures/overpass-sample.json")) }

    func testParsesOnlyValidMuslimPlaces() {
        let list = OnlineMosques.parseOverpass(sample)
        XCTAssertEqual(list.map(\.sourceId), ["osm:node/101", "osm:way/202", "osm:node/303", "osm:node/606"])
        XCTAssertEqual(list[0].displayName("en"), "Masjid Test One")
        XCTAssertEqual(list[0].displayName("ar"), "مسجد الاختبار")
        XCTAssertEqual(list[0].address, "12 Long Street, Cape Town")
        XCTAssertEqual(list[0].sourceTimestamp, "2026-10-01T12:00:00Z")
        XCTAssertEqual(list[2].category, .prayer_space)
        XCTAssertEqual(list[1].location.latitude, -33.925, accuracy: 1e-9)
        XCTAssertTrue(OnlineMosques.parseOverpass(Data("not json".utf8)).isEmpty)
    }

    func testQueryUsesRoundedCentreOnly() {
        let q = OnlineMosques.overpassQuery(center: LatLng(-33.92487, 18.42401)!, radiusMeters: 5_000)
        XCTAssertTrue(q.contains("(around:6600,-33.92,18.42)"), q)
        XCTAssertFalse(q.contains("33.924"))
        XCTAssertEqual(OnlineMosques.privacyRound(LatLng(0.001, -0.004)!).latitude, 0)
    }

    func testMergeKeepsDownloadedRecordsAndDropsNearbyDuplicates() {
        let center = LatLng(-33.92, 18.42)!
        let offline = Mosque(sourceId: "osm:node/1", packId: "mosques.za-cape-town", category: .mosque, names: ["default": "Offline"], location: LatLng(-33.9201, 18.4201)!)
        let merged = OnlineMosques.merge(center: center, offline: [RankedMosque(mosque: offline, distanceMeters: Geo.distanceMeters(center, offline.location))],
                                         online: OnlineMosques.parseOverpass(sample), radiusMeters: 5_000)
        let ids = merged.map(\.mosque.sourceId)
        XCTAssertEqual(ids.first, "osm:node/1")
        XCTAssertFalse(ids.contains("osm:node/101"))
        XCTAssertTrue(ids.contains("osm:way/202"))
        XCTAssertEqual(merged.map(\.distanceMeters), merged.map(\.distanceMeters).sorted())
        XCTAssertTrue(OnlineMosques.merge(center: LatLng(-33, 18)!, offline: [], online: OnlineMosques.parseOverpass(sample), radiusMeters: 100).isEmpty)
    }
}
