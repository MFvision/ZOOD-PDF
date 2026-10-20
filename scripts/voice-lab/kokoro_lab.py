"""Kokoro-82M (Apache-2.0) through kokoro-onnx: English only, it has no Arabic."""

import urllib.request

import soundfile as sf
from kokoro_onnx import Kokoro

from measure import cpu, record
from texts import ENGLISH

cpu()
base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
for name in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
    urllib.request.urlretrieve(base + name, name)
kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
kokoro.create("Hello.", voice="af_heart", speed=1.0, lang="en-us")

for voice in ("af_heart", "am_michael", "bf_emma"):
    for index, text in enumerate(ENGLISH):
        def synth(path, text=text, voice=voice):
            samples, rate = kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
            sf.write(path, samples, rate, subtype="PCM_16")
        record(f"kokoro-{voice}", f"en{index + 1}", "en", text, synth)
