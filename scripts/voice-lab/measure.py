"""Shared by the lab's engines: time a synthesis and write what it says."""

import json
import os
import subprocess
import sys
import time
import wave

OUT = os.environ.get("LAB_OUT", "lab-out")


def duration(path):
    with wave.open(path, "rb") as wav:
        return wav.getnframes() / float(wav.getframerate())


def record(engine, name, lang, text, synth):
    """Runs synth(path) to write a wav, then logs seconds taken and the real-time factor."""
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{engine}--{name}.wav")
    started = time.perf_counter()
    try:
        synth(path)
    except Exception as error:  # the lab reports a failing engine and goes on
        print(f"[{engine}] {name}: FAILED {error!r}", flush=True)
        line = {"engine": engine, "sample": name, "lang": lang, "error": repr(error)}
    else:
        took = time.perf_counter() - started
        length = duration(path)
        line = {
            "engine": engine,
            "sample": name,
            "lang": lang,
            "seconds": round(took, 2),
            "audio_seconds": round(length, 2),
            "rtf": round(took / length, 3) if length else None,
        }
        print(f"[{engine}] {name}: {took:.2f}s for {length:.2f}s of audio (RTF {line['rtf']})", flush=True)
        mp3 = path[:-4] + ".mp3"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-b:a", "96k", mp3], check=False)
        if os.path.exists(mp3):
            os.remove(path)
    with open(os.path.join(OUT, "results.jsonl"), "a", encoding="utf-8") as log:
        log.write(json.dumps(line, ensure_ascii=False) + "\n")


def cpu():
    print(f"python {sys.version.split()[0]}, cpus {os.cpu_count()}", flush=True)
