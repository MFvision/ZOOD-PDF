"""SILMA TTS v1 (F5-TTS, 150M, Apache-2.0): Arabic and English on the CPU, at 16 and 8 steps."""

import os
from importlib.resources import files

import torch

from measure import cpu, record
from texts import ARABIC, ENGLISH

cpu()
torch.set_num_threads(os.cpu_count() or 4)
from silma_tts.api import SilmaTTS  # noqa: E402

tts = SilmaTTS(device="cpu")
ref = str(files("silma_tts").joinpath("infer/ref_audio_samples/ar.ref.24k.wav"))
ref_text = "ويدقق النظر في القرآن الكريم وسائر الكتب السماوية ويتبع مسالك الرسل العظام عليهم الصلاة والسلام."

# The first call warms the model up; it is not counted.
tts.infer(ref_file=ref, ref_text=ref_text, gen_text="مرحبا.", seed=1)

for steps in (16, 8):
    for lang, texts in (("ar", ARABIC), ("en", ENGLISH)):
        for index, text in enumerate(texts):
            def synth(path, text=text, steps=steps):
                tts.infer(ref_file=ref, ref_text=ref_text, gen_text=text, nfe_step=steps, file_wave=path, seed=7)
            record(f"silma-nfe{steps}", f"{lang}{index + 1}", lang, text, synth)
