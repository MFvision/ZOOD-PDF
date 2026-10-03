# Near Mosque — native iOS and Android

A native rebuild of the Nearest Mosque website with exactly three tabs:

* **Prayer & Qibla** — calculated prayer times (Adhan), countdown, Hijri date, true-north Qibla with a
  live compass when the phone has a reliable heading, reminders.
* **Nearest Mosque** — a mosque compass and a live street map (Apple Maps on iOS, OpenFreeMap +
  MapLibre on Android); downloaded regional packs work offline and, when online, live results (Apple
  Maps search / OpenStreetMap) fill in other areas; glass cards, walking routes on iOS, directions.
* **Ask AI** — "Ask anything about Islam": answers that quote the books on the phone, with verse
  references and the original text; common questions in seven languages; on-device writing on
  supported iPhones (iOS 26), cited search everywhere else. No cloud calls.

Design: Quiet Glass — a drawn sky for the current prayer period with Apple Liquid Glass on iOS 26
(material fallback on iOS 18–25) and matching drawn glass on Android; an animated six-page welcome
tour on first launch.

No account, no backend, no analytics. Works without a network from first launch; the live map and
live mosque results are the only network features and send only an approximate (≈1 km) location.

| Folder | What |
|---|---|
| `docs/` | `01-audit` (website and media audit), `02-architecture`, `03-offline-contract`, `04-data-and-licenses`, `05-status` (feature matrix, test results, limitations), `06-design` |
| `shared/` | UI strings (7 languages, one source), design tokens, golden fixtures, common questions, stopwords, brand source |
| `packs/` | Bundled data: cities (GeoNames), mosques for Cape Town / Cairo / London (OSM), Quran + Pickthall (Tanzil) |
| `tools/` | Pack builders, independent prayer/Qibla reference, retrieval reference, strings generator, token checker |
| `android/` | Kotlin + Jetpack Compose (`core` pure-Kotlin domain, `app`) |
| `ios/` | Swift + SwiftUI (`Packages/NearestMosqueKit` domain/storage, `App`, XcodeGen `project.yml`) |

## Build

**Android** (JDK 17+, Android SDK 36):

```bash
cd android
./gradlew :core:test :app:testDebugUnitTest   # 51 tests incl. Robolectric + screenshots
./gradlew :app:recordRoborazziDebug           # PNGs in app/build/screenshots
./gradlew :app:assembleDebug                  # app/build/outputs/apk/debug/app-debug.apk
```

**iOS** (Xcode 26 recommended for Liquid Glass and Foundation Models; Xcode 16 builds with fallbacks):

```bash
cd ios
(cd Packages/NearestMosqueKit && swift test)   # also runs on Linux with Swift 6.1
brew install xcodegen && xcodegen generate
open NearMosque.xcodeproj                      # scheme NearMosque, iOS 18+
```

**Shared** (Python 3.11+):

```bash
python3 tools/gen_strings.py          # after editing shared/i18n/strings.json
python3 tools/check_tokens.py         # contrast + theme parity
python3 tools/gen_fixtures.py && python3 tools/reference_search.py --gen
```

CI: `.github/workflows/nearest-mosque.yml` runs all of the above, builds the iOS app with Xcode 26,
launches it in the iOS Simulator and uploads screenshots (artifact `ios-simulator-screenshots`).

## Status

See [`docs/05-status.md`](docs/05-status.md) for what works, what was verified and how, and what is
not done. This is a first complete offline flow, not a store-ready release.
