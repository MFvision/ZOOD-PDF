"""Piper (VITS, ONNX): the Arabic voice kareem with and without libtashkeel's diacritics."""

import subprocess
import sys
import wave

from piper import PiperVoice, SynthesisConfig
from piper.tashkeel import TashkeelDiacritizer

from arabic_g2p import phonemize

from measure import cpu, record
from texts import ARABIC, ENGLISH

cpu()
voices = ["ar_JO-kareem-medium", "ar_JO-kareem-low", "en_US-ryan-high", "en_GB-cori-high"]
subprocess.run([sys.executable, "-m", "piper.download_voices", "--download-dir", "voices", *voices], check=True)

for name in voices:
    voice = PiperVoice.load(f"voices/{name}.onnx")
    lang = "ar" if name.startswith("ar") else "en"
    texts = ARABIC if lang == "ar" else ENGLISH
    variants = [("", True), ("-no-tashkeel", False)] if lang == "ar" else [("", True)]
    for suffix, tashkeel in variants:
        voice.use_tashkeel = tashkeel
        for index, text in enumerate(texts):
            def synth(path, text=text, voice=voice):
                with wave.open(path, "wb") as out:
                    voice.synthesize_wav(text, out, syn_config=SynthesisConfig())
            record(f"piper-{name}{suffix}", f"{lang}{index + 1}", lang, text, synth)

# The same Arabic voice with no espeak-ng at all: libtashkeel's diacritics,
# then this lab's own rules (arabic_g2p.py) for the phonemes.
diacritize = TashkeelDiacritizer()
for name in ("ar_JO-kareem-medium", "ar_JO-kareem-low"):
    voice = PiperVoice.load(f"voices/{name}.onnx")
    for index, text in enumerate(ARABIC):
        phones = "".join(phonemize(diacritize(text)))
        print(f"[{name}-zood-g2p] {phones}", flush=True)

        def synth(path, phones=phones, voice=voice):
            with wave.open(path, "wb") as out:
                voice.synthesize_wav(f"[[ {phones} ]]", out, syn_config=SynthesisConfig())

        record(f"piper-{name}-zood-g2p", f"ar{index + 1}", "ar", text, synth)
