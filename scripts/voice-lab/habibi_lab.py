"""Habibi-TTS, the MSA specialized model (F5-TTS, Apache-2.0), on the CPU at 16 steps."""

import os
import subprocess
from importlib.resources import files

from measure import cpu, record
from texts import ARABIC

cpu()
ref = str(files("habibi_tts").joinpath("assets/MSA.mp3"))
ref_text = "كان اللعيب حاضرًا في العديد من الأنشطة والفعاليات المرتبطة بكأس العالم، مما سمح للجماهير بالتفاعل معه والتقاط الصور التذكارية."

subprocess.run(["habibi-tts_infer-cli", "--help"], check=False)

for index, text in enumerate(ARABIC):
    def synth(path, text=text):
        subprocess.run(
            [
                "habibi-tts_infer-cli", "--model", "Specialized", "--dialect", "MSA",
                "--ref_audio", ref, "--ref_text", ref_text, "--gen_text", text,
                "--nfe_step", "16", "--device", "cpu",
                "--output_dir", os.path.dirname(os.path.abspath(path)), "--output_file", os.path.basename(path),
            ],
            check=True,
        )
    # Includes loading the model each time: the lab notes it, the app would load it once.
    record("habibi-msa-nfe16", f"ar{index + 1}", "ar", text, synth)
