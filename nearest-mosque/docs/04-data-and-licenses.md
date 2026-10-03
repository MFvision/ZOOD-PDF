# 4. Data, sources and licenses

Nothing below grants redistribution beyond what each license states. Items marked **release gate**
must be resolved before a store release.

## 4.1 Bundled packs

| Pack | Content | Source and retrieval | License | Status |
|---|---|---|---|---|
| `cities.world` | 13,090 places (capitals, admin seats, population ≥ 50,000) with IANA zone, Arabic-script names | GeoNames `cities15000.zip`, retrieved 2026-10-03 | CC BY 4.0, attribution "City data © GeoNames" | OK (attribution shown in Settings → Sources and licenses) |
| `mosques.za-cape-town` | 69 records | OpenStreetMap via BBBike extract (snapshot 2026-09-25) | ODbL 1.0, "© OpenStreetMap contributors" | OK; derivative database must stay ODbL and be offered on request |
| `mosques.eg-cairo` | 519 records | same | ODbL 1.0 | OK |
| `mosques.gb-london` | 255 records (254 mosques, 1 prayer space) | same | ODbL 1.0 | OK |
| `sources.quran-tanzil-pickthall` | 6,236 verses, one chunk per verse, anchor `surah:ayah` | Tanzil Quran Text (Simple) v1.1 + `en.pickthall`, retrieved 2026-10-03; SHA-256 of both inputs recorded in `documents.json` | Arabic: Tanzil terms (CC BY 3.0, verbatim only, notice + link required). Translation: public-domain work (M. M. Pickthall, 1930; d. 1936) **digitized by Tanzil, whose translation terms say non-commercial use only** | Arabic OK. **Release gate:** for any commercial distribution, re-source Pickthall from a public-domain digitization or get Tanzil's permission. |

Coverage is measured, not claimed: each mosque pack records its bbox and count. OSM coverage of
mosques varies (Cape Town's 69 records are certainly fewer than the mosques that exist); the app says
"nearest **known** mosque" and "the data may be incomplete".

Tanzil's copyright block is kept verbatim in `LICENSE-tanzil-quran-text.txt` inside the pack and the
displayed Arabic is never altered; the normalized search field is derived at install time and never
shown.

## 4.2 Candidate sources not bundled

| Source | Why not yet | What is needed |
|---|---|---|
| IslamHouse / Balagh catalog | API reachable but not tested; no credentials, limits, stable-ID or redistribution terms verified; Balagh's curation not inspected | Written permission per item/collection for offline redistribution, indexing and embedding; then `tools/build_*_pack.py` style ingestion with an inventory report (discovered / downloadable / indexed / failed / unsupported) |
| Hadith collections (Arabic and translations) | Digital editions carry their own terms | A licensed edition with stable numbering |
| Other Quran translations (ur, tr, id, fr, es) on Tanzil | Tanzil marks them non-commercial; translators/publishers hold rights | Permission from each translator/publisher |
| Offline street-map tiles | Live maps now ship (below); offline map packs need a licensed or self-built extract | A self-hosted vector tile extract (Protomaps/OpenMapTiles build) with style, glyphs and sprites for MapLibre |
| Google Places (the website's mosque source) | Needs a billed API key; shipping an unrestricted key in an app is unsafe, and Places content must be shown on a Google map with caching limits | A key restricted to the app's package/bundle ID and signing certificate, a server proxy if usage must be controlled, Google Maps SDK for display |
| Time-zone boundaries | Not needed for city selection; nearest-city + confirmation covers arbitrary points | `timezone-boundary-builder` (ODbL) pack if exact boundaries are wanted |

## 4.2b Online services used (live map and live results)

| Service | Platform | Terms that matter | What is sent |
|---|---|---|---|
| Apple Maps (MapKit map, MKLocalSearch, MKDirections walking routes) | iOS | Free with the Apple Developer Program; results shown on Apple's map; Apple attribution is drawn by MapKit | Map area being viewed; search region centred on a 0.01° rounded point; route endpoints when a walking route is requested |
| OpenFreeMap (`tiles.openfreemap.org`, "dark" style) | Android | Free, no key, no usage limits stated; attribution "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" shown in the app | Tile requests for the area being viewed |
| OpenStreetMap Overpass API (`overpass-api.de`) | Android | Public instance for light use; heavy production traffic should use a self-hosted or commercial instance; data ODbL | One query per search: a 0.01° rounded centre and a radius |

None of these receive an account, device ID, prayer settings or questions. Online search can be
switched off in Settings; the map images are only loaded when the Map view is open.

## 4.3 Software dependencies

| Dependency | Version | License | Platform |
|---|---|---|---|
| adhan2 (Adhan Kotlin) | 0.0.7 | MIT | Android |
| adhan-swift | 1.5.0 | MIT | iOS |
| GRDB.swift | 7.11.1 | MIT | iOS |
| Jetpack Compose BOM | 2025.12.01 | Apache-2.0 | Android |
| AndroidX Room | 2.8.4 | Apache-2.0 | Android |
| AndroidX DataStore, AppCompat, Activity, Lifecycle, Core | see `android/gradle/libs.versions.toml` | Apache-2.0 | Android |
| kotlinx-serialization / coroutines | 1.9.0 / 1.10.2 | Apache-2.0 | Android |
| Robolectric, Roborazzi (tests only) | 4.16.1 / 1.52.0 | MIT / Apache-2.0 | Android tests |
| pyosmium (tools only) | 4.3.1 | BSD-2-Clause | pack building |
| MapLibre Native Android | 13.0.2 | BSD-2-Clause | Android (live map) |
| MapKit | system | Apple SDK | iOS (live map, search, routes) |

No analytics, crash reporting or ads are included. The only network code is the live map and live
mosque search described in 4.2b.

## 4.4 Brand assets

`shared/brand/near-mosque-logo-source.png` is the logo from the website ZIP; the app icon and header
mark are crops of it (`shared/brand/`). No remote images are used.

## 4.5 Rebuilding packs

```bash
pip install osmium
python3 tools/build_cities.py cities15000.txt --out packs/cities
python3 tools/build_mosque_pack.py CapeTown.osm.pbf --id za-cape-town --name "Cape Town" \
    --source-url https://download.bbbike.org/osm/bbbike/CapeTown/ --out packs/mosques
python3 tools/build_quran_pack.py --arabic quran-simple.txt --translation en.pickthall.txt \
    --metadata quran-data.xml --questions shared/content/common-questions.json \
    --out packs/sources/quran-tanzil-pickthall
python3 tools/gen_fixtures.py && python3 tools/reference_search.py --gen   # fixtures
python3 tools/gen_strings.py                                                # iOS + Android strings
```

Inputs: `https://download.geonames.org/export/dump/cities15000.zip`,
`https://download.bbbike.org/osm/bbbike/<City>/<City>.osm.pbf`,
`https://tanzil.net/pub/download/index.php?quranType=simple&outType=txt-2&agree=true&marks=true&sajdah=true&tatweel=true`,
`https://tanzil.net/trans/en.pickthall`, `https://tanzil.net/res/text/metadata/quran-data.xml`.
A pack for import is the pack folder (manifest + files); Android also accepts it zipped as `.nmpack`.
