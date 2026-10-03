#!/usr/bin/env python3
"""Build the starter book pack: Quran Arabic (Tanzil, verbatim) + Pickthall English translation.

Usage:
  build_quran_pack.py --arabic quran-simple.txt --translation en.pickthall.txt \
      --metadata quran-data.xml --questions ../shared/content/common-questions.json \
      --out ../packs/sources/quran-tanzil-pickthall

Inputs are the files downloaded from tanzil.net (see docs/04-data-and-licenses.md for URLs).
The Arabic text is copied verbatim (Tanzil terms forbid changes); the apps derive a separate
normalized search field at install time and never alter displayed quotations. One chunk per
verse; the citation anchor is "surah:ayah" and never changes between pack versions.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import xml.etree.ElementTree as ET


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def read_verses(path):
    verses, notice = {}, []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            m = re.match(r"^(\d+)\|(\d+)\|(.*)$", line)
            if m:
                verses[(int(m.group(1)), int(m.group(2)))] = m.group(3)
            elif line.startswith("#"):
                notice.append(line)
    return verses, "\n".join(notice).strip() + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arabic", required=True)
    ap.add_argument("--translation", required=True)
    ap.add_argument("--metadata", required=True)
    ap.add_argument("--questions", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--retrieved", default=dt.date.today().isoformat())
    a = ap.parse_args()

    ar, ar_notice = read_verses(a.arabic)
    en, en_notice = read_verses(a.translation)
    if len(ar) != 6236 or set(ar) != set(en):
        raise SystemExit(f"verse sets differ or incomplete: ar={len(ar)} en={len(en)}")
    if "CHANGING IT IS NOT ALLOWED" not in ar_notice:
        raise SystemExit("Tanzil copyright block missing from Arabic input")

    suras = {}
    for s in ET.parse(a.metadata).getroot().iter("sura"):
        suras[int(s.get("index"))] = {
            "ar": s.get("name"), "translit": s.get("tname"), "en": s.get("ename"), "ayas": int(s.get("ayas")),
        }

    os.makedirs(a.out, exist_ok=True)
    chunks_path = os.path.join(a.out, "chunks.jsonl")
    with open(chunks_path, "w", encoding="utf-8") as f:
        for seq, (s, v) in enumerate(sorted(ar), start=1):
            rec = {
                "id": f"quran:{s}:{v}",
                "seq": seq,
                "anchor": f"{s}:{v}",
                "section": {"surah": s, "ayah": v, "nameAr": suras[s]["ar"], "nameTranslit": suras[s]["translit"], "nameEn": suras[s]["en"]},
                "original": {"docId": "quran-ar-tanzil-simple", "lang": "ar", "text": ar[(s, v)]},
                "translations": [{"docId": "quran-en-pickthall", "lang": "en", "text": en[(s, v)]}],
                "url": f"https://tanzil.net/#{s}:{v}",
            }
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")

    with open(os.path.join(a.out, "LICENSE-tanzil-quran-text.txt"), "w", encoding="utf-8") as f:
        f.write(ar_notice)
    with open(os.path.join(a.out, "NOTICE-pickthall.txt"), "w", encoding="utf-8") as f:
        f.write(en_notice)
        f.write("\nThe Meaning of the Glorious Koran, M. M. Pickthall (London, 1930). The translator died in 1936;\n"
                "the work is in the public domain in life+70 jurisdictions and in the United States (published 1930).\n"
                "This digitization comes from tanzil.net, whose translation terms allow non-commercial use; see\n"
                "docs/04-data-and-licenses.md before any commercial distribution.\n")

    documents = [
        {
            "id": "quran-ar-tanzil-simple",
            "kind": "scripture",
            "title": {"en": "The Holy Quran (Arabic text)", "ar": "القرآن الكريم"},
            "edition": "Tanzil Quran Text (Simple), version 1.1",
            "publisher": "Tanzil Project",
            "language": "ar",
            "url": "https://tanzil.net/",
            "license": {"id": "CC-BY-3.0-verbatim", "name": "Tanzil terms: CC BY 3.0, verbatim copies only",
                        "url": "https://tanzil.net/docs/text_license", "attribution": "Quran text: Tanzil Project (tanzil.net)"},
            "retrievedAt": a.retrieved,
            "sourceSha256": sha256_file(a.arabic),
            "citation": "verse",
            "textType": "selectable",
        },
        {
            "id": "quran-en-pickthall",
            "kind": "translation",
            "title": {"en": "The Meaning of the Glorious Koran", "ar": "ترجمة معاني القرآن (بكثال)"},
            "translator": "Mohammed Marmaduke William Pickthall",
            "year": 1930,
            "edition": "Tanzil en.pickthall (last updated 2010-09-04)",
            "publisher": "Tanzil Project (digitization)",
            "language": "en",
            "translationOf": "quran-ar-tanzil-simple",
            "url": "https://tanzil.net/trans/en.pickthall",
            "license": {"id": "PD-work+Tanzil-noncommercial", "name": "Public-domain translation; Tanzil digitization for non-commercial use",
                        "url": "https://tanzil.net/trans/", "attribution": "Translation: M. M. Pickthall (1930), via tanzil.net"},
            "retrievedAt": a.retrieved,
            "sourceSha256": sha256_file(a.translation),
            "citation": "verse",
            "textType": "selectable",
        },
    ]
    with open(os.path.join(a.out, "documents.json"), "w", encoding="utf-8") as f:
        json.dump(documents, f, ensure_ascii=False, indent=2)
        f.write("\n")

    shutil.copyfile(a.questions, os.path.join(a.out, "common-questions.json"))
    questions = json.load(open(a.questions, encoding="utf-8"))
    ids = {f"quran:{s}:{v}" for (s, v) in ar}
    for q in questions["questions"]:
        missing = [c for c in q["citations"] if c not in ids]
        if missing:
            raise SystemExit(f"common question {q['id']} cites missing anchors {missing}")

    files = []
    for name in ["chunks.jsonl", "documents.json", "common-questions.json",
                 "LICENSE-tanzil-quran-text.txt", "NOTICE-pickthall.txt"]:
        p = os.path.join(a.out, name)
        files.append({"path": name, "bytes": os.path.getsize(p), "sha256": sha256_file(p)})
    manifest = {
        "id": "sources.quran-tanzil-pickthall",
        "kind": "sources",
        "schemaVersion": 1,
        "version": 1,
        "title": {"en": "Quran with English translation (Pickthall)", "ar": "القرآن الكريم مع ترجمة إنجليزية (بكثال)"},
        "languages": ["ar", "en"],
        "recordCount": len(ar),
        "source": {"name": "Tanzil Project", "url": "https://tanzil.net/",
                   "builtAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
        "license": {"id": "mixed", "name": "See documents.json", "url": "https://tanzil.net/docs/text_license",
                    "attribution": "Quran text: Tanzil Project (tanzil.net). Translation: M. M. Pickthall (1930)."},
        "files": files,
    }
    with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{len(ar)} verses, {len(questions['questions'])} common questions -> {a.out}")


if __name__ == "__main__":
    main()
