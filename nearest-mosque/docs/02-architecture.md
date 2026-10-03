# 2. Architecture

## 2.1 Platforms and versions

| | iOS | Android |
|---|---|---|
| Language / UI | Swift 6, SwiftUI | Kotlin 2.4, Jetpack Compose (Material 3) |
| Minimum OS | **iOS 18.0** (same devices as iOS 17: iPhone XS/XR and later; modern Tab API, scroll geometry) | **Android 8.0, API 26** (java.time, adaptive icons) |
| Newer APIs gated | iOS 26: Liquid Glass (`glassEffect`, `GlassEffectContainer`, tab-bar minimize), Foundation Models | API 31+: exact alarms permission; API 33+: notification permission, per-app language |
| Devices | iPhone; adaptive iPad layout (size classes) | Phones; adaptive width classes for tablets |
| Storage | SQLite via **GRDB 7** (FTS5) | SQLite via **Room 2.8** (FTS4) |
| Preferences | `UserDefaults` | DataStore Preferences |
| Prayer engine | **adhan-swift 1.5.0** | **adhan2 0.0.7** (adhan-kotlin) |
| Location | Core Location (foreground, when-in-use) | `LocationManager` (no Play Services dependency; GNSS works offline) |
| Heading | `CLLocationManager` heading (`trueHeading`, `headingAccuracy`, `headingOrientation`) | `TYPE_ROTATION_VECTOR` (magnetometer-referenced fusion) + `GeomagneticField` declination; `GAME_ROTATION_VECTOR` is never used as a north reference |

No WebView anywhere. No account, analytics, or backend is required.

## 2.2 Shared, not duplicated

`shared/` and `packs/` are the single source for both apps:

* `shared/i18n/strings.json` → generated `Localizable.xcstrings` (String Catalog) and `values-*/strings.xml` (`tools/gen_strings.py`).
* `shared/design/tokens.json` → colours, radii, spacing, motion (mirrored in `Theme.swift` / `Theme.kt`; a test checks they match).
* `shared/fixtures/*.json` → prayer, Qibla, normalization and retrieval golden cases run by **both** test suites.
* `packs/` → cities, mosque regions, book pack; bundled into both apps unchanged.

Domain code is written twice (Swift and Kotlin) rather than shared through KMP: it is small, each
version wraps the platform's own Adhan port, and the shared fixtures enforce parity. Revisit if the
retrieval layer grows substantially.

## 2.3 Layers

```
UI (SwiftUI / Compose screens, ViewModels)
  │ reads state only from local storage and deterministic services
  ▼
Domain services (pure, injected clock)          Repositories (local DB is the source of truth)
  PrayerCalculator  QiblaCalculator               CityRepository     MosqueRepository
  HeadingMath       TimeZoneResolver              SourceRepository   SettingsStore
  TextNormalizer    Retriever  AnswerComposer     PackManager
  ▼
Platform adapters: LocationService, HeadingService, NotificationScheduler,
                   LocalInferenceProvider (Foundation Models on iOS 26 / none on Android yet),
                   ExternalMaps
```

* Clock, location, heading and storage are injected; tests use fixed clocks and fake sensors.
* All database and pack work runs off the main thread; long operations are cancellable.
* Countdown text is recomputed from scheduled instants and the current clock every second; nothing
  accumulates timer ticks, so sleep, clock changes and resume are self-correcting.

## 2.4 Location model (three separate values)

| Value | Source | Used for | Never changed by |
|---|---|---|---|
| `DevicePosition` (lat, lng, accuracy, timestamp) | GNSS/network fix | "You are here", default mosque search centre | map selection, city choice |
| `PrayerLocation` (name, lat, lng, IANA zone, source = city / device) | City picker or "Follow my location" | prayer times, Qibla | map selection |
| `SearchCenter` | device position, prayer city, or "Search this area" | mosque list ordering | — |

Time zone: a picked city carries its own IANA zone. For a device fix, `TimeZoneResolver` uses **the
phone's own zone** (set by the network, as the website relies on) whenever it is consistent with the
location: same offsets as the nearest bundled city, far from any city (sea, desert), or more than 30 km
from it (border band). Only when the phone is clearly on another zone than a city within 30 km (a
traveller with a manual clock) is the city's zone used, and the user is asked to confirm. The phone's
zone is never assumed for a remotely selected city. Tested in both cores.

## 2.5 Prayer calculation contract

* Inputs: coordinates, the location's local date, IANA zone, method, madhab (Asr), high-latitude rule,
  per-prayer minute offsets, polar rule, Ramadan Isha (+30 min for Umm al-Qura in Ramadan per the
  Umm al-Qura Hijri calendar).
* Output: `DaySchedule(date, fajr, sunrise, dhuhr, asr, maghrib, isha, status)` where status is
  `normal`, `estimated(nearestLatitude)` or `unavailable(reason)`. Sunrise is an event, not a prayer.
* Date-line handling: Adhan interprets the date on the solar day; for zones far from their solar
  offset (Apia, Kiritimati) the wrapper re-runs with an adjacent date until Dhuhr falls on the requested
  local date (fixture-tested).
* `nextPrayer(now)` skips sunrise; after Isha it uses tomorrow's Fajr. "Fajr ends at sunrise" is shown
  separately between Fajr and sunrise.
* A mosque's iqamah/Jumu'ah timetable is separate data (not in this increment) and is never inferred.

## 2.6 Qibla contract

`QiblaCalculator` gives the great-circle initial bearing from **true north** (Kaaba 21.4225241,
39.8261818) and distance. `HeadingMath`:

* `trueHeading = magneticHeading + declination` (Android, `GeomagneticField`); iOS uses
  `trueHeading` and falls back to bearing-only when it is negative (invalid).
* `relative = normalize180(qiblaBearing − trueHeading)`; the arrow rotates by the shortest path
  across 359°/0°.
* Smoothing on unit vectors (circular low-pass), not raw angles.
* "Aligned" enters at |relative| ≤ 5° and leaves at > 8° (hysteresis), only when accuracy is
  acceptable (≤ 20°); one light haptic on entry.
* Heading is sampled only while the Qibla view is visible.

## 2.7 Data schema (SQLite, version 1)

```
installed_pack(id PK, kind, version, schema_version, title_json, license_json, source_json,
               coverage_json, record_count, bytes, installed_at, builtin, avgdl)
mosque(source_id PK, pack_id, category, name, names_json, lat, lng, address, phone, website,
       opening_hours_raw, source_timestamp)          + index (lat, lng)
favorite(source_id PK, added_at)                    -- survives pack updates/removal
source_document(id PK, pack_id, json)
source_chunk(id PK, pack_id, seq, anchor, section_json, original_doc, original_lang, original_text,
             translations_json, url, search_text)
source_chunk_fts (FTS5 on iOS / FTS4 on Android, content = source_chunk.search_text)
common_question(id PK, pack_id, json)
conversation(id PK, created_at) / message(id PK, conversation_id, role, text, answer_json, created_at)
```

Opening status is computed as `unknown` (the raw OSM `opening_hours` string is displayed with its date
but not interpreted until a verified parser exists). Embeddings/vector index: not in this increment;
the schema leaves `source_chunk` keyed so a `chunk_vector(chunk_id, model_id, dim, vector BLOB)` table
can be added with its model version.

## 2.8 Ask AI pipeline

```
question ─▶ normalize (shared rules) ─▶ match common question (triggers in 7 languages)
         ─▶ FTS candidates ─▶ BM25 re-rank (+ expansion terms, + follow-up context)
         ─▶ evidence gate (score ≥ 3.0 and ≥ 50 % of content words, or ≥ 2 words)
         ─▶ AnswerComposer
              ├─ common question: reviewed/unreviewed summary + its citations + related passages
              ├─ passages: "Passages from your books" (exact quotes, translation labelled)
              ├─ on-device generation (iOS 26, available): written only from the passages,
              │    every sentence must cite [n] of a supplied passage or it is discarded
              └─ insufficient: "I couldn't find this in your books"
```

Retrieved text is untrusted: it is only ever placed in a delimited evidence block; tools, links and
file actions are never triggered by content. Prayer times, distances and bearings in answers come from
the deterministic services, not the model. Deleting a pack deletes its chunks, FTS rows and cached
answers.

## 2.9 Screens (exactly three tabs)

1. **Prayer & Qibla** — on the sky for the current prayer period: glass location pill and gear; the
   Qibla arc (brand disc at the top, gold dot = where the Qibla is relative to the top of the phone,
   disc glows when aligned; north-up with the bearing when there is no live heading) with the next
   prayer, time, remaining time and guidance inside; bearing and distance chips; glass schedule with
   the upcoming row in gold and reminder bells; dates and method card; compact glass bar when
   scrolled. Detail screens: city picker, calculation settings, full-screen compass.
2. **Nearest Mosque** — Compass | Map glass toggle: a mosque compass (each mosque at its bearing and
   distance, turning with the phone, "Mosque ahead") or the live street map with pins and "Search this
   area"; glass cards (nearest first, straight-line distance, walking route on iOS, Directions); detail
   sheet (call, website, directions, favorite for downloaded records, source/date, hours state);
   favorites filter. Downloaded data plus optional live results.
3. **Ask AI** — mosque skyline on the horizon, "Ask anything about Islam", glass common-question
   chips, glass question bubbles, answer and source cards, glass input, reader sheet.

First launch shows a six-page animated tour (welcome, prayer times, Qibla, nearest mosque, Ask, setup);
it can be replayed from Settings.

The gear button (top trailing on every tab) opens Settings: language, location, prayer calculation,
reminders, Downloads (installed packs, import, restore), Sources & licenses, Privacy, About.

## 2.10 Design direction

Three concepts share the same three-tab structure (see `06-design.md`); **Quiet Glass** is implemented,
with Daily Focus's high-contrast rows for the schedule and Learn Simply's large prompts in Ask AI.
