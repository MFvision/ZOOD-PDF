#!/usr/bin/env python3
"""Independent reference for prayer times and Qibla, used only to generate golden fixtures.

This deliberately does NOT use Adhan. Solar position follows the NOAA solar calculator
(Meeus-based); each event is refined iteratively at its own instant. Method conventions
(angles, intervals, minute adjustments, high-latitude portions) are the published method
parameters, which the apps also use through Adhan. The apps must agree with these values
within the tolerance recorded in the fixture file.
"""
import math
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

KAABA = (21.4225241, 39.8261818)
EARTH_RADIUS_M = 6371008.8

METHODS = {
    "MUSLIM_WORLD_LEAGUE": dict(fajr=18.0, isha=17.0, adj=dict(dhuhr=1)),
    "EGYPTIAN": dict(fajr=19.5, isha=17.5, adj=dict(dhuhr=1)),
    "KARACHI": dict(fajr=18.0, isha=18.0, adj=dict(dhuhr=1)),
    "UMM_AL_QURA": dict(fajr=18.5, interval=90, adj={}),
    "DUBAI": dict(fajr=18.2, isha=18.2, adj=dict(sunrise=-3, dhuhr=3, asr=3, maghrib=3)),
    "NORTH_AMERICA": dict(fajr=15.0, isha=15.0, adj=dict(dhuhr=1)),
    "KUWAIT": dict(fajr=18.0, isha=17.5, adj={}),
    "QATAR": dict(fajr=18.0, interval=90, adj={}),
    "SINGAPORE": dict(fajr=20.0, isha=18.0, adj=dict(dhuhr=1)),
    "TURKEY": dict(fajr=18.0, isha=17.0, adj=dict(sunrise=-7, dhuhr=5, asr=4, maghrib=7)),
}


def julian_day(dt_utc):
    return dt_utc.timestamp() / 86400.0 + 2440587.5


def solar(dt_utc):
    """Return (declination_deg, equation_of_time_minutes) at a UTC instant (NOAA)."""
    jc = (julian_day(dt_utc) - 2451545.0) / 36525.0
    l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360
    m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    mr = math.radians(m)
    c = (math.sin(mr) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
         + math.sin(2 * mr) * (0.019993 - 0.000101 * jc) + math.sin(3 * mr) * 0.000289)
    true_long = l0 + c
    omega = 125.04 - 1934.136 * jc
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    mean_obl = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60
    obl = mean_obl + 0.00256 * math.cos(math.radians(omega))
    decl = math.degrees(math.asin(math.sin(math.radians(obl)) * math.sin(math.radians(app_long))))
    y = math.tan(math.radians(obl / 2)) ** 2
    l0r = math.radians(l0)
    eot = 4 * math.degrees(
        y * math.sin(2 * l0r) - 2 * e * math.sin(mr) + 4 * e * y * math.sin(mr) * math.cos(2 * l0r)
        - 0.5 * y * y * math.sin(4 * l0r) - 1.25 * e * e * math.sin(2 * mr))
    return decl, eot


def transit(lng, utc_day):
    """Solar noon (UTC) on a given UTC calendar day."""
    t = datetime(utc_day.year, utc_day.month, utc_day.day, 12, tzinfo=timezone.utc)
    for _ in range(4):
        _, eot = solar(t)
        minutes = 720 - 4 * lng - eot
        t = datetime(utc_day.year, utc_day.month, utc_day.day, tzinfo=timezone.utc) + timedelta(minutes=minutes)
    return t


def local_transit(lat, lng, local_date, tz):
    """The solar noon whose local calendar date is local_date (handles date-line zones)."""
    for offset in (0, -1, 1, -2, 2):
        t = transit(lng, local_date + timedelta(days=offset))
        if t.astimezone(tz).date() == local_date:
            return t
    raise ValueError("no transit")


def hour_angle_event(lat, lng, noon, altitude_fn, after_noon):
    """Instant when the sun reaches altitude (deg) before/after noon; None if never.

    Declination and equation of time are re-evaluated at the event instant itself.
    """
    base = datetime(noon.year, noon.month, noon.day, tzinfo=timezone.utc)
    t = noon
    for _ in range(6):
        decl, eot = solar(t)
        alt = altitude_fn(decl)
        cos_h = ((math.sin(math.radians(alt)) - math.sin(math.radians(lat)) * math.sin(math.radians(decl)))
                 / (math.cos(math.radians(lat)) * math.cos(math.radians(decl))))
        if cos_h < -1 or cos_h > 1:
            return None
        h = math.degrees(math.acos(cos_h))
        t = base + timedelta(minutes=720 - 4 * lng - eot + (4 * h if after_noon else -4 * h))
    return t


def compute(lat, lng, local_date, tz_name, method, madhab="SHAFI", high_lat_rule=None):
    """Return dict of aware local datetimes (seconds precision) or None if not computable."""
    tz = ZoneInfo(tz_name)
    p = METHODS[method]
    noon = local_transit(lat, lng, local_date, tz)
    tomorrow_noon = local_transit(lat, lng, local_date + timedelta(days=1), tz)
    sunrise = hour_angle_event(lat, lng, noon, lambda d: -50 / 60, False)
    sunset = hour_angle_event(lat, lng, noon, lambda d: -50 / 60, True)
    next_sunrise = hour_angle_event(lat, lng, tomorrow_noon, lambda d: -50 / 60, False)
    if sunrise is None or sunset is None or next_sunrise is None:
        return None
    shadow = 2 if madhab == "HANAFI" else 1

    def asr_alt(decl):
        return math.degrees(math.atan(1 / (shadow + math.tan(math.radians(abs(lat - decl))))))

    asr = hour_angle_event(lat, lng, noon, asr_alt, True)
    night = (next_sunrise - sunset).total_seconds()
    rule = high_lat_rule or ("SEVENTH_OF_THE_NIGHT" if lat > 48 else "MIDDLE_OF_THE_NIGHT")
    if rule == "SEVENTH_OF_THE_NIGHT":
        pf = pi = 1 / 7
    elif rule == "MIDDLE_OF_THE_NIGHT":
        pf = pi = 1 / 2
    else:
        pf, pi = p["fajr"] / 60, p.get("isha", 0) / 60
    fajr = hour_angle_event(lat, lng, noon, lambda d: -p["fajr"], False)
    safe_fajr = sunrise - timedelta(seconds=pf * night)
    if fajr is None or fajr < safe_fajr or fajr >= sunrise:
        fajr = safe_fajr
    if "interval" in p:
        isha = sunset + timedelta(minutes=p["interval"])
    else:
        isha = hour_angle_event(lat, lng, noon, lambda d: -p["isha"], True)
        safe_isha = sunset + timedelta(seconds=pi * night)
        if isha is None or isha <= sunset or isha > safe_isha:
            isha = safe_isha
    out = dict(fajr=fajr, sunrise=sunrise, dhuhr=noon, asr=asr, maghrib=sunset, isha=isha)
    if any(v is None for v in out.values()):
        return None
    adj = p["adj"]
    return {k: (v + timedelta(minutes=adj.get(k, 0))).astimezone(tz).replace(microsecond=0)
            for k, v in out.items()}


def qibla_bearing(lat, lng):
    phi1, phi2 = math.radians(lat), math.radians(KAABA[0])
    dl = math.radians(KAABA[1] - lng)
    y = math.sin(dl) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def distance_m(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))
