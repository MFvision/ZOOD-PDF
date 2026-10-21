"""Scores each sample by how much of it Whisper understands (character error rate)."""

import glob
import json
import os
import re
import sys

import jiwer
from faster_whisper import WhisperModel

sys.path.insert(0, os.path.dirname(__file__))
from texts import ARABIC, ENGLISH  # noqa: E402

root = sys.argv[1]
model = WhisperModel("large-v3", device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
DIACRITICS = re.compile("[ً-ْٰـ]")


def plain(text, lang):
    text = DIACRITICS.sub("", text).lower()
    if lang == "ar":
        text = re.sub("[إأآ]", "ا", text).replace("ة", "ه").replace("ى", "ي")
    return " ".join(re.sub(r"[^\w\s]", " ", text).split()) or "-"


rows = []
for path in sorted(glob.glob(os.path.join(root, "**", "*.mp3"), recursive=True)):
    name = os.path.basename(path)[:-4]
    engine, sample = name.rsplit("--", 1)
    lang = sample[:2]
    expected = (ARABIC if lang == "ar" else ENGLISH)[int(sample[2:]) - 1]
    segments, _ = model.transcribe(path, language=lang, beam_size=5)
    heard = " ".join(segment.text for segment in segments).strip()
    cer = jiwer.cer(plain(expected, lang), plain(heard, lang))
    row = {"engine": engine, "sample": sample, "cer": round(cer, 3), "heard": heard}
    rows.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)

with open(os.path.join(root, "scores.jsonl"), "w", encoding="utf-8") as out:
    for row in rows:
        out.write(json.dumps(row, ensure_ascii=False) + "\n")

print("\nmean character error rate by engine (lower is clearer):")
by = {}
for row in rows:
    by.setdefault(row["engine"], []).append(row["cer"])
for engine, values in sorted(by.items(), key=lambda item: sum(item[1]) / len(item[1])):
    print(f"  {engine:45s} {sum(values) / len(values):.3f}  ({len(values)} samples)")
