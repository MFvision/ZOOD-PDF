#!/usr/bin/env python3
"""Generate shared golden fixtures consumed by the Android (Kotlin) and iOS (Swift) test suites.

  python3 gen_fixtures.py   # writes ../shared/fixtures/{prayer-times,qibla}.json

prayer-times.json values come from reference_prayer.py (independent of Adhan). Both apps
must match every case within `toleranceSeconds`, which also implies iOS/Android parity
within twice that bound; in practice both use Adhan and agree to the minute.
"""
import json
import os
from datetime import date

import reference_prayer as ref

OUT = os.path.join(os.path.dirname(__file__), "..", "shared", "fixtures")

# id, lat, lng, zone, date, method, madhab, highLatitudeRule, note
PRAYER_CASES = [
    ("makkah-umm-al-qura", 21.4225, 39.8262, "Asia/Riyadh", "2026-10-03", "UMM_AL_QURA", "SHAFI", None, "Makkah, Umm al-Qura (Isha = Maghrib + 90 min)"),
    ("riyadh-umm-al-qura-winter", 24.6877, 46.7219, "Asia/Riyadh", "2026-12-21", "UMM_AL_QURA", "SHAFI", None, "Riyadh winter solstice"),
    ("cape-town-mwl", -33.9258, 18.4232, "Africa/Johannesburg", "2026-10-03", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "Southern hemisphere spring"),
    ("cape-town-mwl-june", -33.9258, 18.4232, "Africa/Johannesburg", "2026-06-21", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "Southern hemisphere winter"),
    ("cairo-egyptian", 30.0626, 31.2497, "Africa/Cairo", "2026-10-03", "EGYPTIAN", "SHAFI", None, "Egyptian General Authority"),
    ("karachi-hanafi", 24.8608, 67.0104, "Asia/Karachi", "2026-10-03", "KARACHI", "HANAFI", None, "Hanafi Asr (shadow factor 2)"),
    ("istanbul-turkey", 41.0082, 28.9784, "Europe/Istanbul", "2026-10-03", "TURKEY", "SHAFI", None, "Diyanet-style adjustments"),
    ("dubai", 25.2048, 55.2708, "Asia/Dubai", "2026-10-03", "DUBAI", "SHAFI", None, "Dubai adjustments"),
    ("jakarta-singapore", -6.2088, 106.8456, "Asia/Jakarta", "2026-10-03", "SINGAPORE", "SHAFI", None, "Equatorial, rounding up in Adhan"),
    ("london-mwl-before-dst", 51.5085, -0.1257, "Europe/London", "2026-03-28", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "Day before BST starts"),
    ("london-mwl-dst-start", 51.5085, -0.1257, "Europe/London", "2026-03-29", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "BST starts 01:00 UTC"),
    ("london-mwl-dst-end", 51.5085, -0.1257, "Europe/London", "2026-10-25", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "BST ends"),
    ("london-mwl-summer", 51.5085, -0.1257, "Europe/London", "2026-06-21", "MUSLIM_WORLD_LEAGUE", "SHAFI", "SEVENTH_OF_THE_NIGHT", "Twilight persists; seventh-of-night bound"),
    ("new-york-isna-dst-start", 40.7128, -74.0060, "America/New_York", "2026-03-08", "NORTH_AMERICA", "SHAFI", None, "US DST starts"),
    ("new-york-isna-dst-end", 40.7128, -74.0060, "America/New_York", "2026-11-01", "NORTH_AMERICA", "HANAFI", None, "US DST ends, Hanafi"),
    ("auckland-mwl-dst-end", -36.8485, 174.7633, "Pacific/Auckland", "2026-04-05", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "Southern DST ends"),
    ("oslo-mwl-midsummer-seventh", 59.9139, 10.7522, "Europe/Oslo", "2026-06-21", "MUSLIM_WORLD_LEAGUE", "SHAFI", "SEVENTH_OF_THE_NIGHT", "High latitude, seventh of the night"),
    ("oslo-mwl-midsummer-middle", 59.9139, 10.7522, "Europe/Oslo", "2026-06-21", "MUSLIM_WORLD_LEAGUE", "SHAFI", "MIDDLE_OF_THE_NIGHT", "High latitude, Isha after local midnight"),
    ("apia-date-line", -13.8333, -171.7667, "Pacific/Apia", "2026-10-03", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "UTC+13 west of 180°: local date differs from solar date"),
    ("kiritimati-date-line", 1.8721, -157.4278, "Pacific/Kiritimati", "2026-10-03", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "UTC+14 at 157°W"),
    ("equator-zero-zero", 0.0, 0.0, "Africa/Abidjan", "2026-10-03", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "Zero coordinates are valid"),
    ("tromso-polar-night", 69.6492, 18.9553, "Europe/Oslo", "2026-12-21", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "No sunrise: must be reported, never invented"),
    ("tromso-midnight-sun", 69.6492, 18.9553, "Europe/Oslo", "2026-06-21", "MUSLIM_WORLD_LEAGUE", "SHAFI", None, "No sunset: must be reported, never invented"),
]

QIBLA_CASES = [
    ("makkah-near-kaaba", 21.4230, 39.8250),
    ("riyadh", 24.6877, 46.7219),
    ("cape-town", -33.9258, 18.4232),
    ("cairo", 30.0626, 31.2497),
    ("london", 51.5085, -0.1257),
    ("new-york", 40.7128, -74.0060),
    ("jakarta", -6.2088, 106.8456),
    ("tokyo", 35.6762, 139.6503),
    ("auckland", -36.8485, 174.7633),
    ("sao-paulo", -23.5505, -46.6333),
    ("anchorage", 61.2181, -149.9003),
    ("zero-zero", 0.0, 0.0),
    ("south-pole-ish", -89.0, 0.0),
    ("antipode-of-kaaba", -21.4225241, -140.1738182 + 0.01),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    cases = []
    for cid, lat, lng, tz, d, method, madhab, rule, note in PRAYER_CASES:
        res = ref.compute(lat, lng, date.fromisoformat(d), tz, method, madhab, rule)
        case = {
            "id": cid, "note": note, "latitude": lat, "longitude": lng, "timeZone": tz, "date": d,
            "method": method, "madhab": madhab, "highLatitudeRule": rule,
        }
        if res is None:
            case["expected"] = None
        else:
            case["expected"] = {k: v.isoformat() for k, v in res.items()}
        cases.append(case)
    with open(os.path.join(OUT, "prayer-times.json"), "w", encoding="utf-8") as f:
        json.dump({
            "description": "Golden prayer times from tools/reference_prayer.py (NOAA solar algorithm, independent of Adhan). expected=null means the convention cannot produce ordinary times for that date; apps must report unavailable unless the user selected a documented fallback.",
            "toleranceSeconds": 120,
            "cases": cases,
        }, f, ensure_ascii=False, indent=2)
        f.write("\n")

    qcases = []
    for cid, lat, lng in QIBLA_CASES:
        qcases.append({
            "id": cid, "latitude": lat, "longitude": lng,
            "bearingDegrees": round(ref.qibla_bearing(lat, lng), 4),
            "distanceMeters": round(ref.distance_m(lat, lng, *ref.KAABA), 1),
        })
    with open(os.path.join(OUT, "qibla.json"), "w", encoding="utf-8") as f:
        json.dump({
            "description": "Great-circle initial bearing from true north to the Kaaba and haversine distance.",
            "kaaba": {"latitude": ref.KAABA[0], "longitude": ref.KAABA[1]},
            "toleranceDegrees": 0.05,
            "distanceToleranceMeters": 2000,
            "cases": qcases,
        }, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{len(cases)} prayer cases, {len(qcases)} qibla cases")


if __name__ == "__main__":
    main()
