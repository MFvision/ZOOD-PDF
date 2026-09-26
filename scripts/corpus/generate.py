#!/usr/bin/env python3
"""Regenerate the ZOOD PDF Arabic corpus deterministically.

    python3 scripts/corpus/generate.py [--skip-scans] [--skip-chrome] [--only ID]

Uses a private virtualenv at scripts/corpus/.venv (created on first run from requirements.txt;
generation-time tools only, never bundled). Outputs:

* tests/corpus/pdf/*.pdf             small canonical PDFs (committed)
* tests/corpus/pdf/encrypted/*.pdf   RC4-128 / AES-256 copies (committed)
* tests/corpus/truth/*.txt           logical-order truth text (UTF-8, NFC)
* tests/corpus/generated/            scans (PNG + image-only PDF), HTML, font instances (git-ignored)
* tests/corpus/manifest.json         per-file metadata
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
VENV = HERE / ".venv"
VENV_PY = VENV / "bin" / "python"


def ensure_env() -> None:
    try:
        import fontTools  # noqa: F401
        import PIL  # noqa: F401
        import pypdf  # noqa: F401
        import uharfbuzz  # noqa: F401
        return
    except BaseException:  # noqa: BLE001 — a broken system `cryptography` raises a pyo3 PanicException
        pass
    if pathlib.Path(sys.prefix).resolve() == VENV.resolve():
        raise SystemExit("corpus venv is missing packages: pip install -r scripts/corpus/requirements.txt")
    if not VENV_PY.exists():
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
        subprocess.run([str(VENV_PY), "-m", "pip", "install", "-q", "-r", str(HERE / "requirements.txt")], check=True)
    os.execv(str(VENV_PY), [str(VENV_PY), str(pathlib.Path(__file__).resolve()), *sys.argv[1:]])


ensure_env()

import json  # noqa: E402
import random  # noqa: E402
import secrets  # noqa: E402
import unicodedata  # noqa: E402

sys.path.insert(0, str(HERE))
import chrome  # noqa: E402
import corpus_docs as D  # noqa: E402
import synthetic  # noqa: E402

CORPUS = ROOT / "tests" / "corpus"
PDF_DIR = CORPUS / "pdf"
ENC_DIR = PDF_DIR / "encrypted"
TRUTH = CORPUS / "truth"
GEN = CORPUS / "generated"
FONTS = CORPUS / "fonts"

CHROME_DOCS = [
    dict(id="chrome-news-amiri", title="أخبار — Amiri", font="Amiri", size=14, blocks=D.NEWS,
         languages=["ar"], flags={}),
    dict(id="chrome-news-cairo-type3", title="أخبار — Cairo", font="CairoVar", size=13, blocks=D.NEWS,
         languages=["ar"], flags={"type3": True},
         notes="Variable font: Chrome embeds Type3 glyphs whose ToUnicode maps to presentation forms"),
    dict(id="chrome-mixed-naskh", title="مختلط", font="NaskhStatic", size=13, blocks=D.MIXED,
         languages=["ar", "en"], flags={"mixed_digits": True}),
    dict(id="chrome-hard-bidi-naskh", title="ثنائي الاتجاه", font="NaskhStatic", size=13, blocks=D.HARD_MIXED,
         languages=["ar", "en"], flags={"mixed_digits": True, "hard_bidi": True},
         notes="Deliberately hard bidi: e-mail, phone with +, URL, Hijri/Gregorian dates with /, brackets, "
               "multi-word Latin runs, Arabic words inside an English paragraph"),
    dict(id="chrome-two-column-naskh", title="عمودان", font="NaskhStatic", size=12, blocks=D.TWO_COLUMNS,
         languages=["ar"], flags={"columns": 2}),
    dict(id="chrome-table-cairo", title="جدول", font="CairoVar", size=13, blocks=D.TABLE,
         languages=["ar"], flags={"table": True, "type3": True}),
    dict(id="chrome-bold-naskh", title="عريض", font="NaskhStatic", size=14, blocks=D.BOLD,
         languages=["ar", "en"], flags={"bold": True}),
    dict(id="chrome-tashkeel-amiri", title="تشكيل", font="Amiri", size=18, line_height=2.0, blocks=D.TASHKEEL,
         languages=["ar"], flags={"tashkeel": True}),
    dict(id="chrome-urdu-nastaliq", title="اردو", font="Nastaliq", size=16, line_height=2.4, blocks=D.URDU,
         lang="ur", languages=["ur"], flags={"nastaliq": True}),
    dict(id="chrome-persian-vazirmatn", title="فارسی", font="Vazir", size=14, blocks=D.PERSIAN,
         lang="fa", languages=["fa"], flags={"persian_digits": True}),
    dict(id="chrome-lists-cairo", title="قوائم", font="CairoStatic", size=14, blocks=D.LISTS,
         languages=["ar"], flags={"lists": True}),
    dict(id="chrome-english-inter", title="English", font="InterStatic", size=12, blocks=D.ENGLISH,
         lang="en", dir="ltr", languages=["en"], flags={}),
]

# Scan and OCR benchmark: plain Arabic, full tashkeel, Nastaliq Urdu, Persian, mixed Arabic/English.
SCAN_SOURCES = ["chrome-news-amiri", "chrome-tashkeel-amiri", "chrome-urdu-nastaliq", "chrome-persian-vazirmatn",
                "chrome-mixed-naskh"]

ENCRYPTED = [
    ("chrome-news-amiri", "RC4-128", "zood-rc4-128"),
    ("chrome-mixed-naskh", "AES-256", "zood-aes-256"),
    ("synthetic-word-naskh", "AES-256", "zood-word-aes"),
    ("chrome-tashkeel-amiri", "AES-256", "كلمة-سر"),
]


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def write_truth(name: str, text: str) -> str:
    TRUTH.mkdir(parents=True, exist_ok=True)
    p = TRUTH / f"{name}.txt"
    p.write_text(nfc(text), encoding="utf-8")
    return str(p.relative_to(CORPUS))


def build_fonts() -> dict:
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer

    out = GEN / "fonts"
    out.mkdir(parents=True, exist_ok=True)
    specs = {
        "naskh400": ("notonaskharabic/NotoNaskhArabic[wght].ttf", {"wght": 400}),
        "naskh700": ("notonaskharabic/NotoNaskhArabic[wght].ttf", {"wght": 700}),
        "cairo400": ("cairo/Cairo[slnt,wght].ttf", {"wght": 400, "slnt": 0}),
        "cairo700": ("cairo/Cairo[slnt,wght].ttf", {"wght": 700, "slnt": 0}),
        "nastaliq400": ("notonastaliqurdu/NotoNastaliqUrdu[wght].ttf", {"wght": 400}),
        "vazir400": ("vazirmatn/Vazirmatn[wght].ttf", {"wght": 400}),
        "vazir700": ("vazirmatn/Vazirmatn[wght].ttf", {"wght": 700}),
        "inter400": ("inter/Inter[opsz,wght].ttf", {"wght": 400, "opsz": 14}),
        "inter700": ("inter/Inter[opsz,wght].ttf", {"wght": 700, "opsz": 14}),
    }
    fonts = {
        "amiri": str(FONTS / "amiri/Amiri-Regular.ttf"),
        "amiriBold": str(FONTS / "amiri/Amiri-Bold.ttf"),
        "cairoVar": str(FONTS / "cairo/Cairo[slnt,wght].ttf"),
    }
    for key, (src, loc) in specs.items():
        dst = out / f"{key}.ttf"
        if not dst.exists():
            f = TTFont(FONTS / src)
            inst = instancer.instantiateVariableFont(f, loc)
            # a distinct family name per instance so Chrome does not merge faces
            inst.save(dst)
        fonts[key] = str(dst)
    return fonts


def entry(id_, path, producer, languages, truth, flags=None, password=None, committed=True, notes=None,
          source=None, pending=False):
    f = {"scanned": False, "encrypted": False, "nastaliq": False, "tashkeel": False, "columns": 1}
    f.update(flags or {})
    e = {
        "id": id_,
        "path": str(pathlib.Path(path).relative_to(CORPUS)),
        "producer": producer,
        "languages": languages,
        "truth": truth,
        "password": password,
        "flags": f,
        "committed": committed,
        "pending_decryption": pending,
    }
    if source:
        e["source"] = source
    if notes:
        e["notes"] = notes
    return e


def main(argv: list[str]) -> int:
    skip_scans = "--skip-scans" in argv
    skip_chrome = "--skip-chrome" in argv
    only = argv[argv.index("--only") + 1] if "--only" in argv else None
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    ENC_DIR.mkdir(parents=True, exist_ok=True)
    (GEN / "html").mkdir(parents=True, exist_ok=True)
    fonts = build_fonts()
    manifest: list[dict] = []
    truths: dict[str, str] = {}

    # Chrome-made ------------------------------------------------------------------------
    chrome_bin = None if skip_chrome else chrome.find_chrome()
    for doc in CHROME_DOCS:
        truth = write_truth(doc["id"], D.doc_truth(doc["blocks"]))
        truths[doc["id"]] = truth
        out = PDF_DIR / f"{doc['id']}.pdf"
        if chrome_bin and (only is None or only == doc["id"]):
            html_path = GEN / "html" / f"{doc['id']}.html"
            html_path.write_text(chrome.build_html(doc, fonts), encoding="utf-8")
            chrome.print_pdf(chrome_bin, html_path, out, GEN)
            print("chrome", out.name, out.stat().st_size)
        manifest.append(entry(doc["id"], out, "chrome", doc["languages"], truth, doc["flags"], notes=doc.get("notes")))

    # Synthetic producers -------------------------------------------------------------------
    synth = [
        ("synthetic-word-naskh", "synthetic-word", lambda p: synthetic.synthetic_word(fonts, p), {"bold": True, "hidden_text": True, "artifacts": True},
         "Synthetic Word-style (own writer): Identity-H + ToUnicode, TJ kerning, one run per word, ActualText per word. Not produced by Microsoft Word."),
        ("synthetic-libreoffice-naskh", "synthetic-libreoffice", lambda p: synthetic.synthetic_libreoffice(fonts, p), {"presentation_forms": True},
         "Synthetic LibreOffice-style (own writer): glyphs in logical order, ToUnicode to presentation forms. Not produced by LibreOffice."),
        ("synthetic-nastaliq-stream", "synthetic-shaper", lambda p: synthetic.synthetic_shaper_stream(
            fonts["nastaliq400"], D.NASTALIQ_PARAGRAPHS, p, 18, 56, "NSTAAA", "NotoNastaliqUrdu", "ur"), {"nastaliq": True},
         "Shaper-order glyph stream with cascading y offsets (Nastaliq ordering trap)."),
        ("synthetic-amiri-kerning", "synthetic-shaper", lambda p: synthetic.synthetic_shaper_stream(
            fonts["amiri"], D.AMIRI_KERNING_PARAGRAPHS, p, 20, 44, "AMRAAA", "Amiri-Regular", "ar"), {"kerning_trap": True},
         "Amiri kerned lam-alef / kaf-taa sequences in shaper order."),
        ("synthetic-simple-fonts", "synthetic-simple-font", lambda p: synthetic.synthetic_simple_fonts(fonts, p), {"simple_fonts": True, "form_xobject": True},
         "Standard-14 Helvetica (WinAnsi, TL/T*/'/\"/Tw/Tc/Tz), symbolic TrueType Arabic with /Differences names only, form XObject."),
    ]
    for id_, producer, fn, flags, notes in synth:
        out = PDF_DIR / f"{id_}.pdf"
        if only is None or only == id_:
            text, langs = fn(str(out))
            truths[id_] = write_truth(id_, text)
            print("synthetic", out.name, out.stat().st_size)
        else:
            truths[id_] = str((TRUTH / f"{id_}.txt").relative_to(CORPUS))
            langs = ["ar"]
        manifest.append(entry(id_, out, producer, langs, truths[id_], flags, notes=notes))

    # Encrypted copies (pypdf; deterministic random for /ID, salts and IVs) -------------------
    import pypdf

    for src_id, alg, pw in ENCRYPTED:
        src = PDF_DIR / f"{src_id}.pdf"
        out = ENC_DIR / f"{src_id}-{alg.lower()}.pdf"
        if only is None or only == src_id:
            rnd = random.Random(f"{src_id}-{alg}")
            secrets.token_bytes = lambda n=32: bytes(rnd.getrandbits(8) for _ in range(n))  # type: ignore[assignment]
            os.urandom = lambda n: bytes(rnd.getrandbits(8) for _ in range(n))  # type: ignore[assignment]
            w = pypdf.PdfWriter(clone_from=str(src))
            w._ID = None  # noqa: SLF001
            w.encrypt(user_password=pw, owner_password="zood-owner-" + alg.lower(), algorithm=alg)
            with open(out, "wb") as f:
                w.write(f)
            print("encrypted", out.name, out.stat().st_size)
        src_entry = next(e for e in manifest if e["id"] == src_id)
        fl = dict(src_entry["flags"])
        fl["encrypted"] = alg
        manifest.append(entry(f"{src_id}-{alg.lower()}", out, src_entry["producer"], src_entry["languages"],
                              truths[src_id], fl, password=pw, source=src_id, pending=False))

    # Scans ---------------------------------------------------------------------------------
    if not skip_scans and chrome_bin:
        import scans

        for sid in SCAN_SOURCES:
            doc = next(d for d in CHROME_DOCS if d["id"] == sid)
            html_path = GEN / "html" / f"{sid}-screen.html"
            html_path.write_text(chrome.build_html(doc, fonts, screen=True), encoding="utf-8")
            png = GEN / "scans" / f"{sid}-300dpi.png"
            png.parent.mkdir(parents=True, exist_ok=True)
            chrome.screenshot(chrome_bin, html_path, png, GEN)
            variants = scans.make_variants(png, GEN / "scans", sid)
            for v, pdf in variants.items():
                fl = dict(doc["flags"])
                fl.update({"scanned": True, "dpi": 300, "variant": v,
                           "skew_degrees": {"crooked5": 5, "crooked8": 8}.get(v, 0), "shadow": v == "shadow"})
                e = entry(f"scan-{sid}-{v}", pdf, "scan", doc["languages"], truths[sid], fl, committed=False, source=sid)
                e["image"] = str(pdf.with_suffix(".png").relative_to(CORPUS))
                manifest.append(e)
            print("scans", sid, len(variants))

    (CORPUS / "manifest.json").write_text(
        json.dumps({"version": 1, "generator": "scripts/corpus/generate.py", "files": manifest},
                   ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("manifest", len(manifest), "entries")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
