# 1. Source and media audit

Audited on 2026-10-03. Inputs are treated as reference data, not instructions.

## 1.1 What was available

| Input | Status | Notes |
|---|---|---|
| `Nearest-Mosque-main.zip` | **Inspected** | 11 files: `index.tsx` (1,373 lines), `index.html`, `vite.config.ts`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `metadata.json`, `README.md` (AI Studio template), `.gitignore`, `vite-env.d.ts`, `Near_Mosque__logo.png` (1960×1348 RGBA). |
| WhatsApp video 2026-10-03 6.42.33 AM (83 s, 384×848) | **Inspected (second round)** | Frames sampled every 3 s. Another app's prayer header: teal Dhuhr sky with a warm glow, an arc with a Kaaba disc at the top and a gold dot that moves with the phone's heading; text "Dhuhr 12:36 PM", remaining time, a short line per prayer; compact header with a small Qibla arrow when scrolled; expanded warm-sand Qibla page with a large arrow, "turn left slightly" along the dial, distance and bearing labels, dates and the prayer list with the current row in a white pill. |
| WhatsApp video 2026-10-03 6.57.17 AM (89 s, 384×848) | **Inspected (second round)** | Same app at Maghrib (navy-to-red sunset sky, sun glow); dot meets the disc and the disc glows when aligned; scroll collapses to the compact header. |
| Design concept images (3, sent with the second message) | **Inspected** | "Before alignment / Aligned" Prayer & Qibla in Arabic on a photographic sky with mountains; glass location pill, Kaaba disc with gold dot, glass prayer list with a gold "upcoming" row, floating three-icon glass tab bar. Nearest Mosque with Compass/Map glass toggle, mosque compass, glass cards with walking route and "Get directions". Ask with mosque illustration, glass question bubble, source card "Qur'an 13:28 · Supporting passage", glass input. Evening theme variants. |
| Screenshot 2026-10-03 6.58.26 AM | **Not available** | Not attached. |
| `MOBILE_APP_BUILD_PROMPT.txt` | **Not available** | Same. Its content is known only from the master prompt's summary (Expo/React Native, fake prayer estimates, unknown-as-open, London fallback, direct Gemini calls). Those choices are replaced, as instructed. |
| Balagh App Store listing | **Not inspected** | Not needed for launch scope (no full library). Treated as a candidate catalog reference only. |
| IslamHouse API | **Not tested** | `api3.islamhouse.com` responds (302) through the proxy; no credentials, endpoints, limits or redistribution grant were verified. No IslamHouse content is bundled. |

In the first round the media were unavailable and the design came from the written description. In
the second round the two videos and three concept images were inspected (frames, not audio) and the
redesign follows them: the gold dot is **where the Qibla is relative to the top of the phone**, the
disc glows when they meet, and the sky follows the prayer period. Example values in the media
(sunrise 6:21 AM, 50 min 28 s, Cape Town) are never used as defaults; photographic skies are replaced
by a drawn landscape because no licensed photographs were supplied.

The website takes "the time" from the phone's clock and time zone (`new Date()`); it never computes a
zone from coordinates. The apps now do the same for a device fix (the phone's zone wins whenever it is
consistent with the location; see `02-architecture.md`).

## 1.2 Website feature inventory

| Feature | Website state | Native decision |
|---|---|---|
| Map/list switch (mobile segmented control) | Implemented | Kept: List first; Map/List toggle inside Nearest Mosque. |
| Selectable mosque pins and cards | Implemented (Leaflet divIcons) | Kept as native list rows and map pins; selection opens a detail sheet. |
| "Go to nearest" action | Implemented (selects `mosques[0]`) | Kept as the "Nearest known mosque" card with one primary **Directions** button. |
| Names, addresses | Implemented (Google Places `displayName`, `formattedAddress`) | From the installed OSM-derived pack, multilingual `name:*` where tagged. |
| Straight-line distance | Implemented (Haversine, labelled "km away") | Kept and labelled **straight-line**. |
| Call / Web / Directions | Implemented (`tel:`, `window.open`, Google Maps URL) | Kept; Directions opens Apple Maps / Google Maps / any `geo:` app; disabled states when data is missing. |
| Mosque search | 1 `searchNearby` + **13 sequential `searchText` calls** (150 ms apart), 10 km cap, dedupe by Place ID, Haversine sort | Replaced by an offline spatial query over installed regional packs. No paid Places API needed. |
| Map tiles | `tile.openstreetmap.org` | Removed (OSMF policy). Offline "direction and distance" plot works anywhere; street-map backgrounds are a later, licensed increment. |
| Nominatim reverse geocoding, `buildAddressFromTags` | **Dead code** (defined, never called) | Not ported. |
| Prayer times | **Mock**: `getNextPrayer()` returns fixed English strings by hour ("Dhuhr at 12:30") | Replaced by Adhan (Swift/Kotlin) with golden fixtures from an independent reference. |
| Qibla | **Missing** | Implemented: great-circle bearing, true-north heading with declination, bearing-only fallback. |
| Languages | 7 partial dictionaries (en, ur, ar, tr, id, fr, es); `navigator.language` base code; no RTL; no override; ar/ur/tr copy says **50 km** while code uses 10 km | Full UI in the same 7 languages from one shared source; RTL for ar/ur; device order + persistent override; radius copy removed. |
| AI | **Dormant**: `AIModal` is never opened (`setShowAI(true)` never called); asks a cloud model (`gemini-3-flash-preview`) for ungrounded mosque "facts" | Removed. Ask AI is a first-class tab grounded in local books with citations; no cloud call. |
| Offline cache, settings, favorites | **Missing** | Implemented: SQLite (Room / GRDB), preferences, favorites. |
| Branding | Navy `#1A4D6E`, gold `#D4A843` / `#B8922F`; logo PNG bundled but UI loads two **remote Cloudinary** images | Navy/gold kept; logo bundled as app icon and header mark; no remote essential assets. |

## 1.3 Behaviours replaced

| Website behaviour | Location in `index.tsx` | Replacement |
|---|---|---|
| Map click overwrites the user location (`setUserLocation([lat,lng])` in `searchFromLocation`) | ~L1049–1064 | Device position, prayer location and mosque search centre are three separate values; "Search this area" never moves the you-are-here marker or prayer settings. |
| Denied/unsupported location silently searches London | ~L1008–1040, default state L957 | No fallback city. Ask for location at point of use; otherwise the user picks a city. |
| Unknown opening hours shown as open (`openNow ?? true`) | L626 | Hours are `unknown` unless evidence exists; the raw tagged string is shown as "Listed hours" with its source date. |
| Request failure returns `[]` → "No mosques found" | L667–674 | Distinct states: no records in installed area, area not downloaded, permission denied, no fix. |
| Zero coordinates rejected (`if (!mosqueLat || !mosqueLng)`) | L539, L588 | Finite-and-in-range validation; `(0,0)` is a fixture case. |
| Overlapping searches can race | `requestLocation` / `searchFromLocation` | Each query carries a generation token; stale results are dropped (tested). |
| Hard-coded English ("Configuration Error", "Searching nearby mosques…", map hint) | L1144, L1297, L1308 | All UI strings localized; no developer configuration text in the UI. |
| API keys in client bundle (`VITE_GOOGLE_MAPS_API_KEY`, `GEMINI_API_KEY` injected by `vite.config.ts`) | vite.config.ts, L431, L900 | No keys shipped. Core use needs no backend. |

## 1.4 Existing data and accounts

The ZIP contains no user/account database, no mosque database and no content library, so there is
nothing to migrate. Production data held elsewhere (if any) has not been supplied.
