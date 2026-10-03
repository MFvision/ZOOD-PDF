# 5. Status, test results and limitations

Snapshot: 2026-10-03, first complete offline flow. Not store-ready.

## 5.1 Feature status

Legend: **Done** = implemented and covered by automated tests or rendered screenshots;
**Built** = implemented and compiled, not exercised on a device; **Partial**; **Not started**.

| Area | Android | iOS | Evidence / notes |
|---|---|---|---|
| Exactly three tabs + gear for everything else | Done | Built | Android screenshots; iOS `TabView` with three `Tab`s |
| Seven languages, device default + persistent override, RTL (ar, ur) | Done | Built | 206 keys × 7 from one source; Android ar/ur/tr screenshots; iOS override via String Catalog bundles. Non-en/ar translations are drafts needing native review |
| City picker with IANA zone, offline | Done | Built | 13,090 cities; search in Latin and Arabic script tested (both) |
| Device location (foreground, at point of use), no default city | Done | Built | Android `LocationManager`; iOS Core Location. Not tested on hardware |
| Time zone for device fix (nearest city, confirmation when uncertain) | Done | Done | Tests in both cores |
| Prayer times (11 methods, Asr, high-latitude rule, offsets) | Done | Done | 23 golden cases vs independent NOAA reference: worst deviation 84 s (Adhan rounds to the minute), tolerance 120 s, both platforms run the same file |
| Date line, DST, midnight Isha, zero coordinates | Done | Done | Apia/Kiritimati, London/NY/Auckland DST, Oslo middle-of-night, (0,0) |
| Polar day/night: unavailable unless the user picks nearest-latitude (48.5°) | Done | Done | Tromsø fixtures; UI card + estimated badge |
| Umm al-Qura Ramadan Isha +30 min, Hijri (Umm al-Qura) with adjustment | Done | Done | Tests in both cores |
| Countdown from instants (DST-correct), next prayer skips sunrise, "Fajr ends at sunrise" | Done | Done | Tests in both cores |
| Header: home / expanded / compact sticky, arc = time progress, disc glow = alignment | Done | Built | Android screenshots (home, expanded, first launch); iOS compiles in CI |
| Qibla bearing + distance (great circle, true north) | Done | Done | 14 fixtures incl. near-Kaaba, antipode; cross-checked with Adhan |
| Live compass (true heading), shortest-path rotation, smoothing, hysteresis alignment + haptic, bearing-only fallback | Built | Built | Math unit-tested; sensor paths need physical devices (see 5.3) |
| Reminders (opt-in per prayer, bounded horizon, reboot/time-change rebuild) | Built | Built | Android 7 days of exact/inexact alarms; iOS ≤ 60 pending. Not tested on devices |
| Mosque packs: offline nearest/list, straight-line distance, dedupe, distinct empty states | Done | Done | Robolectric (Room) and GRDB tests: found / not-downloaded / no-records; ranking deterministic |
| Map/List toggle | Partial | Partial | "Map" is an offline direction-and-distance plot (no street tiles). Licensed offline vector tiles + MapLibre are next |
| Mosque details, call/website/directions hand-off, favorites surviving pack updates | Done | Built | Favorites survival tested on both data layers |
| Opening hours never shown as open | Done | Done | Status always unknown; raw tagged hours shown with source date |
| Search races (generation tokens) | Done | Done | Unit-tested; UIs drop stale results |
| Packs: manifest, SHA-256 verify, atomic install/rollback, remove/restore, import | Done | Done | Corrupt update keeps previous version (tested both). Android imports `.nmpack` zip; iOS imports a pack folder. No download server (resume designed, not built) |
| Ask AI: cited search over bundled Quran + Pickthall, common questions in 7 languages, follow-ups | Done | Done | 20 retrieval cases identical across Python reference, Room FTS4 and GRDB FTS5; rendered answers in en/ar |
| Source cards: reference, verbatim original, labelled translation, read-in-context offline, original link | Done | Built | Android screenshots |
| "Not found" instead of guessing; prompt-injection question returns nothing | Done | Done | Fixtures |
| Common answers labelled "awaiting scholar review" | Done | Done | All 8 are `unreviewed`; none may be relabelled without a named reviewer |
| On-device generation | Not started | Built | iOS 26 Foundation Models provider, gated on availability + language, output rejected unless every paragraph cites a supplied passage. Android: no model shipped (cited search only) |
| Cloud AI | — | — | Not implemented; off by design |
| Embeddings / vector search, OCR, PDF/EPUB import, IslamHouse ingestion | Not started | Not started | Next increments; licensing first (see 04) |
| Guided learning flows | Not started | Not started | |
| Reduced motion / transparency, contrast, large text | Partial | Built | Contrast checked by `tools/check_tokens.py` (35 checks). Large-text and screen-reader passes not yet run on devices |

## 5.2 Test results (this environment and CI)

| Suite | Where | Result |
|---|---|---|
| Python references (`gen_fixtures.py`, `reference_search.py --gen`) | Linux | 23 prayer, 14 Qibla, 12 normalization, 20 retrieval cases; 0 failures |
| Android `:core:test` | Linux (local) + CI | 25 tests, 0 failures |
| Android `:app:testDebugUnitTest` (Robolectric: Room/FTS4 install, rollback, retrieval parity, empty states, favorites; 10 screenshot tests) | Linux (local) + CI | 17 tests, 0 failures |
| Android `:app:assembleDebug` | Linux (local) | `app-debug.apk` 16 MB |
| `NearestMosqueKit` `swift test` (NMCore 13, NMData/GRDB FTS5 5) | Linux Swift 6.1 (local + CI) and macOS (CI) | 18 tests, 0 failures |
| iOS app `xcodebuild` (simulator, unsigned) | GitHub macOS runner | see 5.4 |
| Strings / fixtures / tokens drift | CI | pass |

Screenshots (Robolectric, rendered from the real database and calculations at 2026-10-03 05:30 SAST,
Cape Town, MWL) are produced by `./gradlew :app:recordRoborazziDebug` and uploaded by CI as an artifact.

## 5.3 Not verified here

* **No physical device or emulator testing** on either platform (this environment has no KVM and no
  Mac). Location fixes, compass accuracy, magnetic interference, haptics, notifications/alarms
  across reboot and Doze, Focus modes, performance, battery and memory are unmeasured.
* iOS UI has been compiled in CI but never run; Liquid Glass and Foundation Models paths are compiled
  only when the runner's Xcode includes the iOS 26 SDK.
* VoiceOver/TalkBack, Dynamic Type at accessibility sizes, Reduce Motion/Transparency: implemented,
  not audited with assistive technology.
* Translations other than English and Arabic are machine-assisted drafts.

## 5.4 iOS CI build

Recorded after the CI run completes (see the commit history of this file).

## 5.5 Known limitations and next increments

1. Street map with licensed offline vector tiles (MapLibre) and regional pack downloads with resume.
2. More mosque regions; measured coverage reports per region; congregation timetables as separate,
   dated data.
3. Book ingestion pipeline (PDF/EPUB/HTML, OCR review), licensed hadith and translations, embeddings,
   IslamHouse inventory once permissions exist.
4. On-device model for Android (LiteRT-LM or llama.cpp) after benchmarking memory, latency and
   Arabic grounding on real devices.
5. City names are stored in the language active when chosen; re-localize by city id.
6. Scholar review of the eight common answers and native review of translations.
7. Pickthall translation source for any commercial release (licensing gate).
