"""Pins the candidate Piper voices: the exact Hugging Face revision, each file's size and
SHA-256, and each voice's model card (where its training data and licence are named)."""

import hashlib
import json
import os
import urllib.request

REPO = "rhasspy/piper-voices"
VOICES = {
    "ar_JO-kareem-medium": "ar/ar_JO/kareem/medium",
    "ar_JO-kareem-low": "ar/ar_JO/kareem/low",
    "en_US-ljspeech-high": "en/en_US/ljspeech/high",
    "en_US-ljspeech-medium": "en/en_US/ljspeech/medium",
    "en_GB-cori-high": "en/en_GB/cori/high",
    "en_US-hfc_female-medium": "en/en_US/hfc_female/medium",
    "en_US-ryan-high": "en/en_US/ryan/high",
    "en_US-lessac-high": "en/en_US/lessac/high",
}

with urllib.request.urlopen(f"https://huggingface.co/api/models/{REPO}") as response:
    revision = json.load(response)["sha"]
print("revision", revision)

out = os.environ.get("LAB_OUT", "models-out")
os.makedirs(out, exist_ok=True)
pinned = {"repo": REPO, "revision": revision, "voices": {}}
for name, folder in VOICES.items():
    entry = {"files": []}
    for file in (f"{name}.onnx", f"{name}.onnx.json", "MODEL_CARD"):
        url = f"https://huggingface.co/{REPO}/resolve/{revision}/{folder}/{file}"
        try:
            with urllib.request.urlopen(url) as response:
                data = response.read()
        except Exception as error:
            print(name, file, "FAILED", error)
            continue
        if file == "MODEL_CARD":
            entry["model_card"] = data.decode("utf-8", "replace")
            continue
        entry["files"].append({"file": file, "url": url, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        if name == "ar_JO-kareem-medium":
            with open(os.path.join(out, file), "wb") as kept:
                kept.write(data)
    pinned["voices"][name] = entry
    print(json.dumps(entry, ensure_ascii=False, indent=1))

with open(os.path.join(out, "pinned.json"), "w", encoding="utf-8") as f:
    json.dump(pinned, f, ensure_ascii=False, indent=1)
