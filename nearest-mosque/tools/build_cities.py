#!/usr/bin/env python3
"""Build the bundled offline city list from GeoNames cities15000.txt (CC BY 4.0).

Usage: build_cities.py cities15000.txt --out ../packs/cities
Keeps capitals, first-order admin seats and places with population >= 50,000. Each row carries
an IANA time-zone ID so prayer times for a selected city never depend on the phone's zone.
Columns (tab-separated, UTF-8): id, name, asciiName, arabicScriptNames (| separated),
countryCode, lat, lng, timeZone, population.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re

ARABIC = re.compile(r"[؀-ۿ]")
KEEP_CODES = {"PPLC", "PPLA"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-pop", type=int, default=50000)
    a = ap.parse_args()

    rows = []
    with open(a.src, encoding="utf-8") as f:
        for line in f:
            c = line.rstrip("\n").split("\t")
            gid, name, ascii_name, alts = c[0], c[1], c[2], c[3]
            lat, lng, fcode, cc, pop, tz = c[4], c[5], c[7], c[8], int(c[14] or 0), c[17]
            if not tz or (pop < a.min_pop and fcode not in KEEP_CODES):
                continue
            arabic = []
            for alt in alts.split(","):
                alt = alt.strip()
                if alt and ARABIC.search(alt) and alt not in arabic:
                    arabic.append(alt)
                if len(arabic) == 3:
                    break
            rows.append((gid, name, ascii_name, "|".join(arabic), cc,
                         f"{float(lat):.5f}", f"{float(lng):.5f}", tz, str(pop)))
    rows.sort(key=lambda r: -int(r[8]))

    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "cities.tsv")
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write("\t".join(x.replace("\t", " ") for x in r) + "\n")
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    manifest = {
        "id": "cities.world",
        "kind": "cities",
        "schemaVersion": 1,
        "version": 1,
        "title": {"en": "World cities"},
        "recordCount": len(rows),
        "source": {
            "name": "GeoNames cities15000",
            "url": "https://download.geonames.org/export/dump/cities15000.zip",
            "builtAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "license": {
            "id": "CC-BY-4.0",
            "name": "Creative Commons Attribution 4.0",
            "url": "https://creativecommons.org/licenses/by/4.0/",
            "attribution": "City data © GeoNames (geonames.org)",
        },
        "files": [{"path": "cities.tsv", "bytes": os.path.getsize(path), "sha256": digest}],
    }
    with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{len(rows)} cities, {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
