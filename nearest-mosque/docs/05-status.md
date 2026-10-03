# 5. Status, test results and limitations

Snapshot: 2026-10-03, second increment (Liquid Glass redesign, onboarding, live map and live results, phone time zone). Not store-ready.

## 5.1 Feature status

Legend: **Done** = implemented and covered by automated tests or rendered screenshots;
**Built** = implemented and compiled, not exercised on a device; **Partial**; **Not started**.

| Area | Android | iOS | Evidence / notes |
|---|---|---|---|
| Exactly three tabs + gear for everything else | Done | Done | Android screenshots; iOS 26 simulator screenshots (system Liquid Glass tab bar) |
| Quiet Glass design: sky per prayer period, glass surfaces, floating glass tab bar | Done | Done | iOS 26 simulator screenshots (real Liquid Glass); Android Robolectric screenshots (drawn glass) |
| Animated onboarding (6 pages, language + location setup, replay from Settings) | Done | Done | Screenshots of each page on both platforms; Reduce Motion shows still frames |
| Live street map | Built | Done | iOS: Apple Maps map rendered in the simulator with mosque pins. Android: MapLibre + OpenFreeMap; compiles and is wired, not rendered in tests (native GL) |
| Live mosque results merged with downloaded data | Done | Done | Parser/merge tested in both cores (shared Overpass fixture); iOS simulator showed Apple Maps results and a walking route; Android Overpass client not exercised against the live service here (blocked by this environment's proxy) |
| Mosque compass (bearing + distance per mosque, turns with heading) | Done | Done | Screenshots on both platforms (north-up; live heading needs a device) |
| Seven languages, device default + persistent override, RTL (ar, ur) | Done | Built | 206 keys × 7 from one source; Android ar/ur/tr screenshots; iOS override via String Catalog bundles. Non-en/ar translations are drafts needing native review |
| City picker with IANA zone, offline | Done | Built | 13,090 cities; search in Latin and Arabic script tested (both) |
| Device location (foreground, at point of use), no default city | Done | Built | Android `LocationManager`; iOS Core Location. Not tested on hardware |
| Time zone for device fix: phone's zone when consistent (like the website), city zone + confirmation only for a clear mismatch near a city | Done | Done | Tests in both cores (alias, at sea, traveller, no phone zone) |
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
| Android `:core:test` (adds online parser/merge and time-zone cases) | Linux (local) + CI | 28 tests, 0 failures |
| Android `:app:testDebugUnitTest` (Robolectric data layer + 16 screenshot tests incl. 6 onboarding) | Linux (local) + CI | 23 tests, 0 failures |
| Android `:app:assembleDebug` | Linux (local) | `app-debug.apk` 76 MB (MapLibre native libraries for all ABIs; a Play bundle splits per device) |
| `NearestMosqueKit` `swift test` (adds online parser/merge and time-zone cases) | Linux Swift 6.1 (local + CI) and macOS (CI) | 21 tests, 0 failures |
| iOS app `xcodebuild` and launch in the iOS 26 Simulator (iPhone, Xcode 26.3) | GitHub macOS runner | Builds, installs, launches; screenshots of onboarding, Prayer (en/ar), compass, Mosques (compass, live map), Ask (en/ar) |
| Strings / fixtures / tokens drift | CI | pass |

Screenshots (Robolectric, rendered from the real database and calculations at 2026-10-03 05:30 SAST,
Cape Town, MWL) are produced by `./gradlew :app:recordRoborazziDebug` and uploaded by CI as an artifact.

## 5.3 Not verified here

* **No physical device or emulator testing** on either platform (this environment has no KVM and no
  Mac). Location fixes, compass accuracy, magnetic interference, haptics, notifications/alarms
  across reboot and Doze, Focus modes, performance, battery and memory are unmeasured.
* iOS now runs in the iOS 26 Simulator in CI (screenshots reviewed), but not on a physical iPhone:
  real compass heading, haptics, notifications and Foundation Models answers are unobserved.
* Android's live map (MapLibre) and the Overpass request were not exercised here: Robolectric cannot
  render native GL, and this environment's proxy blocks the Overpass host.
* VoiceOver/TalkBack, Dynamic Type at accessibility sizes, Reduce Motion/Transparency: implemented,
  not audited with assistive technology.
* Translations other than English and Arabic are machine-assisted drafts.

## 5.4 CI evidence

Workflow `Nearest Mosque apps`, run 3 (commit `0aff6fc`): **all four jobs green**
(https://github.com/MFvision/ZOOD-PDF/actions/runs/37133699233).

| Job | Result |
|---|---|
| Shared strings, design tokens, fixture regeneration | pass (no drift) |
| Android: `:core:test`, `:app:testDebugUnitTest`, screenshots, `assembleDebug` | pass (ubuntu-24.04, JDK 21) |
| NearestMosqueKit on Linux (Swift 6.1) | 18/18 |
| iOS: package tests on macOS (CryptoKit path) | 18/18 |
| iOS: `xcodebuild` simulator build, **Xcode 26.3** (iOS 26 SDK) | `BUILD SUCCEEDED`; Liquid Glass and Foundation Models code paths were compiled |

The first two iOS builds failed on Apple-only issues (`Method` clashing with the Objective-C runtime
type, a missing public initializer, a CGFloat/Double ambiguity); each was fixed and re-verified.

The repository's pre-existing ZOOD PDF `CI` workflow is red on this branch in `core clippy` and
`desktop tests` (Rust). It was already red on the base commit `e071214` (run 17), and this work
touches no Rust or files those steps read.

## 5.5 Known limitations and next increments

1. Offline street-map packs (self-built vector tiles) and regional pack downloads with resume;
   Android walking routes (needs a routing service); optional Google Places with a restricted key.
2. More mosque regions; measured coverage reports per region; congregation timetables as separate,
   dated data.
3. Book ingestion pipeline (PDF/EPUB/HTML, OCR review), licensed hadith and translations, embeddings,
   IslamHouse inventory once permissions exist.
4. On-device model for Android (LiteRT-LM or llama.cpp) after benchmarking memory, latency and
   Arabic grounding on real devices.
5. City names are stored in the language active when chosen; re-localize by city id.
6. Scholar review of the eight common answers and native review of translations.
7. Pickthall translation source for any commercial release (licensing gate).
