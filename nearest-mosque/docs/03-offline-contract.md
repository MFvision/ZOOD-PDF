# 3. Offline contract

"Offline" (no data connection) and "GPS" (satellite positioning) are separate capabilities. The app
always opens, and is useful, with neither.

| Capability | Needs | Works with no network? | When unavailable |
|---|---|---|---|
| UI in 7 languages, RTL, settings, favorites, history | Bundled resources, local storage | **Yes, always** | — |
| City picker and time zone | Bundled GeoNames list (13,090 cities with IANA zones) | **Yes, always** | — |
| Prayer times, countdown, Hijri date | Location + date + zone + method (all local) | **Yes, always** | Polar day/night: shown as unavailable until the user picks the documented nearest-latitude rule. |
| Qibla bearing and distance | Location only | **Yes, always** | — |
| Current position | Location permission + GNSS/network fix | **Yes** (GNSS needs sky view, not data) | Manual city; position age and accuracy are shown. |
| Live Qibla compass | Magnetometer + accelerometer/gyro (Android rotation vector; iOS Core Location heading) | **Yes** | Clearly labelled north-up bearing diagram, never a fake live arrow. |
| Nearest mosques | An installed regional pack covering the search point | **Yes, after the pack is installed** | "This area isn't downloaded" with the list of installed areas. |
| Live mosque results (optional, on by default, disclosed in onboarding and Settings) | Internet; Apple Maps search (iOS) or OpenStreetMap Overpass (Android); only a centre rounded to 0.01° (~1 km) is sent | No | "You're offline. Showing downloaded mosques only." Downloaded records always win over online duplicates (60 m). |
| Mosque compass (direction and distance to each mosque) | Location + heading sensors | **Yes** | North-up when there is no live heading. |
| Live street map | Internet for map images: Apple Maps (iOS, MapKit), OpenFreeMap vector tiles (Android, MapLibre) | No | Pins and the list stay; the compass view needs no map. |
| Walking route and time (iOS) | Internet (Apple Maps directions) | No | Straight-line distance only. |
| Turn-by-turn navigation | External maps app + its road data | **Outside this app's guarantee** | The app opens Apple Maps / Google Maps / any `geo:` handler. |
| Call a mosque / open its website | Telephony / internet | No (website) | Buttons shown only when the record has the field. |
| Ask AI: cited search, common questions, reader | Installed book pack (starter pack bundled) | **Yes, always** | "I couldn't find this in your books" — never a guessed answer. |
| Ask AI: on-device writing | iOS 26+ Apple Intelligence model, available and ready, in a supported language | **Yes, when available** | Cited search (same citations), with a visible status line. Never routed to cloud. |
| Cloud AI | — | **Not implemented; off by default** | — |
| New regions/books, corrections, updates | Network download or file import | Import works offline | Existing data is kept on failure. |
| Reminders | Notification permission (Android 13+), exact-alarm access (Android 12+) | **Yes** | Bounded horizon (iOS: 64 pending notifications ≈ 10 days of 6 reminders; Android: 7 days, rescheduled on boot/app open). |

## First launch without network
1. App opens in the best supported device language (or the saved override) with the animated
   welcome tour; its last page sets language and location (both work offline).
2. Prayer & Qibla asks to **choose a city** or **use my location**; both work offline.
3. Times, countdown, Qibla bearing and (if sensors exist) the live compass work immediately.
4. Nearest Mosque works where a bundled pack covers the point (Cape Town, Cairo, London in this build);
   elsewhere it says the area isn't downloaded. With internet, live results fill in other areas.
5. Ask AI answers from the bundled Quran + Pickthall pack with verse citations and the common questions.

## Provisioning
Packs are JSON-lines datasets with a manifest (`shared/schemas/pack-manifest.schema.json`): id, kind,
version, license/attribution, coverage, record count, and a SHA-256 per file. Install = verify hashes,
then replace the pack's rows inside one SQLite transaction (atomic; on any failure the previous version
stays). Built-in packs are installed on first launch and can be removed or restored; additional packs
are imported from Files (Android: a `.nmpack` zip; iOS: the unpacked pack folder). Download-with-resume
is designed (Range requests into a temp file, hash-verified, then the same transactional install) but
not built: no download server exists yet.
