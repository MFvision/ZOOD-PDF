#!/usr/bin/env python3
"""Acid test runner for PDFium (pypdfium2) and MuPDF (PyMuPDF, AGPL reference).
Writes results-<candidate>.json and screenshots to docs/research/screenshots/<candidate>/.
Usage: run_python.py <repo> [pdfium|mupdf ...]"""
import json, os, sys, time, traceback
from pathlib import Path
REPO = Path(sys.argv[1]).resolve(); CORPUS = REPO / "tests/corpus/arabic"; SHOTS = REPO / "docs/research/screenshots"
PASSWORDS = {"variant-encrypted-aes256.pdf": "warraq"}
MAX_PAGES_TEXT = 3

def save_shot(img, cand, stem):
    d = SHOTS / cand; d.mkdir(parents=True, exist_ok=True)
    img = img.convert("RGB")
    if img.width > 900: img = img.resize((900, int(img.height * 900 / img.width)))
    img.save(d / f"{stem}.jpg", "JPEG", quality=80); return f"docs/research/screenshots/{cand}/{stem}.jpg"

def run_pdfium(path, stem):
    import pypdfium2 as pdfium
    r = {}; t0 = time.perf_counter()
    doc = pdfium.PdfDocument(str(path), password=PASSWORDS.get(path.name)); n = len(doc); page = doc[0]
    r["t_open_ms"] = round((time.perf_counter() - t0) * 1000, 1); r["pages"] = n
    t0 = time.perf_counter(); img = page.render(scale=1.5).to_pil(); r["t_render_p1_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    r["shot"] = save_shot(img, "pdfium", stem)
    t0 = time.perf_counter(); texts = []
    for i in range(min(n, MAX_PAGES_TEXT)):
        tp = doc[i].get_textpage(); texts.append(tp.get_text_bounded())
    r["t_text_ms"] = round((time.perf_counter() - t0) * 1000, 1); r["text"] = "\n".join(texts)
    tp = page.get_textpage(); r["selectable"] = tp.count_chars() > 0 and tp.get_charbox(0) is not None
    if n >= 100:
        t0 = time.perf_counter()
        for i in range(n): doc[i].get_textpage().get_text_bounded()
        r["t_text_all_pages_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return r

def run_mupdf(path, stem):
    import fitz
    r = {}; t0 = time.perf_counter()
    doc = fitz.open(str(path))
    if doc.needs_pass: doc.authenticate(PASSWORDS.get(path.name, ""))
    n = doc.page_count; page = doc[0]; r["t_open_ms"] = round((time.perf_counter() - t0) * 1000, 1); r["pages"] = n
    t0 = time.perf_counter(); pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5)); r["t_render_p1_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    from PIL import Image
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples); r["shot"] = save_shot(img, "mupdf", stem)
    t0 = time.perf_counter(); r["text"] = "\n".join(doc[i].get_text("text") for i in range(min(n, MAX_PAGES_TEXT))); r["t_text_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    r["selectable"] = len(page.get_text("words")) > 0
    if n >= 100:
        t0 = time.perf_counter()
        for i in range(n): doc[i].get_text("text")
        r["t_text_all_pages_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return r

RUNNERS = {"pdfium": run_pdfium, "mupdf": run_mupdf}
import subprocess
if len(sys.argv) > 2 and sys.argv[2] == "--one":  # child mode: one candidate, one file, JSON on stdout
    cand, f = sys.argv[3], Path(sys.argv[4])
    try: r = RUNNERS[cand](f, f.stem); r["open"] = True
    except Exception as e: r = {"open": False, "error": f"{type(e).__name__}: {str(e)[:160]}"}
    print("\n@@JSON@@" + json.dumps(r, ensure_ascii=False)); sys.exit(0)
cands = sys.argv[2:] or list(RUNNERS)
files = sorted((CORPUS / "generated").glob("*.pdf")) + sorted((CORPUS / "realworld").glob("*.pdf"))
for cand in cands:
    out = {}
    for f in files:  # each file in its own process so a native crash cannot kill the run
        p = subprocess.run([sys.executable, __file__, str(REPO), "--one", cand, str(f)], capture_output=True, text=True, timeout=600)
        if "@@JSON@@" in p.stdout: out[f.stem] = json.loads(p.stdout.split("@@JSON@@")[-1])
        else: out[f.stem] = {"open": False, "error": f"CRASH exit={p.returncode} (signal {-p.returncode if p.returncode < 0 else p.returncode - 128 if p.returncode > 128 else 0}) {p.stderr.strip()[-120:]}"}
        r = out[f.stem]
        print(f"{cand:7s} {f.stem:45s} {'OK ' if r['open'] else 'ERR ' + r.get('error','')[:50]} {r.get('t_open_ms','-')}ms open {r.get('t_render_p1_ms','-')}ms render", flush=True)
    json.dump(out, open(REPO / "tests/acid" / f"results-{cand}.json", "w"), ensure_ascii=False, indent=1)
