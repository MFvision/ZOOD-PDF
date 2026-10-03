#!/usr/bin/env python3
"""Build a regional mosque pack from an OpenStreetMap .osm.pbf extract.

Usage:
  build_mosque_pack.py <extract.osm.pbf> --id za-cape-town --name "Cape Town" \
      --source-url https://download.bbbike.org/osm/bbbike/CapeTown/ --out ../packs/mosques

Output: <out>/<id>/manifest.json and <out>/<id>/mosques.jsonl (one record per line).
The data is a derivative database of OpenStreetMap and is published under the ODbL 1.0;
the manifest carries the required attribution. Nothing is inferred: opening hours are kept
as the raw tagged string and the apps report them as "unknown" until a parser is verified.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
import sys

import osmium

NAME_LANGS = ["ar", "en", "ur", "tr", "id", "fr", "es"]
PRAYER_SPACE_VALUES = {"musalla", "prayer_room", "mussalla", "musholla", "mushola"}


def is_muslim_place(tags):
    if tags.get("religion") != "muslim":
        return False
    return tags.get("amenity") == "place_of_worship" or tags.get("building") == "mosque"


def category(tags):
    pow_type = (tags.get("place_of_worship") or tags.get("place_of_worship:type") or "").lower()
    if pow_type in PRAYER_SPACE_VALUES or tags.get("indoor") == "room":
        return "prayer_space"
    return "mosque"


def valid_coordinate(lat, lng):
    return (
        isinstance(lat, float) and isinstance(lng, float)
        and math.isfinite(lat) and math.isfinite(lng)
        and -90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0
    )


class Collector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.records = {}

    def _add(self, kind, osm_id, tags, lat, lng, version, timestamp):
        if not valid_coordinate(lat, lng):
            return
        t = {k: v for k, v in tags}
        names = {}
        if t.get("name"):
            names["default"] = t["name"]
        for lang in NAME_LANGS:
            if t.get(f"name:{lang}"):
                names[lang] = t[f"name:{lang}"]
        addr_parts = [
            " ".join(p for p in [t.get("addr:housenumber"), t.get("addr:street")] if p),
            t.get("addr:suburb"), t.get("addr:city"), t.get("addr:postcode"),
        ]
        address = t.get("addr:full") or ", ".join(p for p in addr_parts if p) or None
        rec = {
            "sourceId": f"osm:{kind}/{osm_id}",
            "category": category(t),
            "names": names,
            "lat": round(lat, 7),
            "lng": round(lng, 7),
            "address": address,
            "phone": t.get("phone") or t.get("contact:phone"),
            "website": t.get("website") or t.get("contact:website"),
            "openingHoursRaw": t.get("opening_hours"),
            "denomination": t.get("denomination"),
            "sourceVersion": version,
            "sourceTimestamp": timestamp,
        }
        self.records[rec["sourceId"]] = {k: v for k, v in rec.items() if v not in (None, {}, "")}

    def node(self, n):
        if is_muslim_place(n.tags):
            self._add("node", n.id, n.tags, n.location.lat, n.location.lon,
                      n.version, n.timestamp.strftime("%Y-%m-%dT%H:%M:%SZ"))

    def way(self, w):
        if not is_muslim_place(w.tags):
            return
        pts = [(nd.lat, nd.lon) for nd in w.nodes if nd.location.valid()]
        if not pts:
            return
        lat = sum(p[0] for p in pts) / len(pts)
        lng = sum(p[1] for p in pts) / len(pts)
        self._add("way", w.id, w.tags, lat, lng, w.version, w.timestamp.strftime("%Y-%m-%dT%H:%M:%SZ"))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pbf")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--name-ar")
    ap.add_argument("--source-url", required=True)
    ap.add_argument("--version", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    reader = osmium.io.Reader(a.pbf, osmium.osm.osm_entity_bits.NOTHING)
    header = reader.header()
    box = header.box()
    snapshot = header.get("osmosis_replication_timestamp") or header.get("timestamp")
    reader.close()

    c = Collector()
    c.apply_file(a.pbf, locations=True)
    # Ways that duplicate a tagged node at the same place are kept: both are distinct OSM
    # objects; the apps dedupe near-identical records at query time with a documented rule.
    records = sorted(c.records.values(), key=lambda r: r["sourceId"])
    if not records:
        sys.exit("no records found")

    pack_dir = os.path.join(a.out, a.id)
    os.makedirs(pack_dir, exist_ok=True)
    data_path = os.path.join(pack_dir, "mosques.jsonl")
    with open(data_path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")

    title = {"en": a.name}
    if a.name_ar:
        title["ar"] = a.name_ar
    manifest = {
        "id": f"mosques.{a.id}",
        "kind": "mosques",
        "schemaVersion": 1,
        "version": a.version,
        "title": title,
        "coverage": {
            "name": a.name,
            "bbox": {
                "minLat": box.bottom_left.lat, "minLng": box.bottom_left.lon,
                "maxLat": box.top_right.lat, "maxLng": box.top_right.lon,
            },
        },
        "recordCount": len(records),
        "categories": {
            "mosque": sum(1 for r in records if r["category"] == "mosque"),
            "prayer_space": sum(1 for r in records if r["category"] == "prayer_space"),
        },
        "source": {
            "name": "OpenStreetMap (extract via BBBike.org)",
            "url": a.source_url,
            "snapshot": snapshot,
            "builtAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "license": {
            "id": "ODbL-1.0",
            "name": "Open Database License 1.0",
            "url": "https://opendatacommons.org/licenses/odbl/1-0/",
            "attribution": "© OpenStreetMap contributors",
            "attributionUrl": "https://www.openstreetmap.org/copyright",
        },
        "files": [{"path": "mosques.jsonl", "bytes": os.path.getsize(data_path), "sha256": sha256(data_path)}],
    }
    with open(os.path.join(pack_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{a.id}: {len(records)} records ({manifest['categories']}), snapshot {snapshot}")


if __name__ == "__main__":
    main()
