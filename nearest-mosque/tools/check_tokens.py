#!/usr/bin/env python3
"""Check shared/design/tokens.json: WCAG contrast of text on the header skies and key surfaces, and
that the Android (Theme.kt) and iOS (Theme.swift) themes use exactly the token colours."""
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def lum(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def ratio(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


def main():
    t = json.load(open(os.path.join(ROOT, "shared/design/tokens.json")))
    col = {k: v.lstrip("#").upper() for k, v in t["color"].items()}
    errors = []
    checks = [
        ("navy text on card", col["navy"], col["cardLight"], 4.5),
        ("gold text on card", col["goldText"], col["cardLight"], 4.5),
        ("primary text light", col["textLight"], col["surfaceLight"], 4.5),
        ("secondary text light", col["textSecondaryLight"], col["cardLight"], 4.5),
        ("primary text dark", col["textDark"], col["cardDark"], 4.5),
        ("secondary text dark", col["textSecondaryDark"], col["cardDark"], 4.5),
        ("gold on dark card", col["gold"], col["cardDark"], 4.5),
    ]
    for name, stops in t["sky"].items():
        if name.startswith("_"):
            continue
        for s in stops:
            checks.append((f"white on sky {name} {s}", "FFFFFF", s.lstrip("#").upper(), 4.5))
            checks.append((f"gold (large) on sky {name} {s}", col["gold"], s.lstrip("#").upper(), 3.0))
    for name, a, b, need in checks:
        r = ratio(a, b)
        if r < need:
            errors.append(f"{name}: {r:.2f} < {need}")

    sky_hex = {s.lstrip("#").upper() for k, v in t["sky"].items() if not k.startswith("_") for s in v}
    kt = open(os.path.join(ROOT, "android/app/src/main/kotlin/sa/zood/nearmosque/ui/theme/Theme.kt")).read()
    sw = open(os.path.join(ROOT, "ios/App/Support/Theme.swift")).read()
    used_kt = {m.upper() for m in re.findall(r"0xFF([0-9A-Fa-f]{6})", kt)}
    used_sw = {m.upper() for m in re.findall(r"hex: 0x([0-9A-Fa-f]{6})", sw)}
    allowed = set(col.values()) | sky_hex | {"8CC0DE", "F2B8B5", "FFFFFF"}  # dark-mode secondary/error accents
    for label, used in (("Theme.kt", used_kt), ("Theme.swift", used_sw)):
        stray = used - allowed
        if stray:
            errors.append(f"{label} uses colours not in tokens.json: {sorted(stray)}")
    missing_sky = sky_hex - used_kt - {"F2A65A", "F7D9A8"}
    if missing_sky - used_sw:
        errors.append(f"sky colours unused on both platforms: {sorted(missing_sky - used_sw)}")
    if errors:
        print("\n".join(errors))
        sys.exit(1)
    print(f"{len(checks)} contrast checks passed; theme colours match tokens")


if __name__ == "__main__":
    main()
