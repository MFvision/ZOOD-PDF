#!/usr/bin/env python3
"""Generate Skia/PDF-class corpus files with headless Chrome (same PDF backend
as Google Docs export and Chromium print-to-PDF).

Usage: python3 gen_chrome.py <repo-root> <chrome-binary>
Writes HTML into generators/html/, PDFs into generated/, truth into truth/.
"""
import http.server, os, signal, time, socketserver, subprocess, sys, tempfile, threading, html as htmlmod
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
import corpus_texts as T

REPO = Path(sys.argv[1]).resolve()
CHROME = sys.argv[2]
GEN = REPO / "tests/corpus/arabic/generators"
HTML = GEN / "html"; OUT = REPO / "tests/corpus/arabic/generated"; TRUTH = REPO / "tests/corpus/arabic/truth"
for d in (HTML, OUT, TRUTH): d.mkdir(parents=True, exist_ok=True)

FONT_FACES = """
@font-face{font-family:'Cairo';src:url('/tests/fonts/static/Cairo-Regular-static.ttf')}
@font-face{font-family:'Cairo Variable';src:url('/tests/fonts/Cairo-Variable.ttf')}
@font-face{font-family:'Amiri';src:url('/tests/fonts/Amiri-Regular.ttf')}
@font-face{font-family:'Noto Naskh Arabic';src:url('/tests/fonts/static/NotoNaskhArabic-Regular-static.ttf')}
@font-face{font-family:'Noto Naskh Arabic Variable';src:url('/tests/fonts/NotoNaskhArabic-Variable.ttf')}
@font-face{font-family:'Noto Sans Arabic';src:url('/tests/fonts/static/NotoSansArabic-Regular-static.ttf')}
@font-face{font-family:'Tajawal';src:url('/tests/fonts/Tajawal-Regular.ttf')}
@font-face{font-family:'IBM Plex Sans Arabic';src:url('/tests/fonts/IBMPlexSansArabic-Regular.ttf')}
@font-face{font-family:'Scheherazade New';src:url('/tests/fonts/ScheherazadeNew-Regular.ttf')}
@font-face{font-family:'Inter';src:url('/tests/fonts/static/Inter-Regular-static.ttf')}
@font-face{font-family:'Vazirmatn';src:url('/tests/fonts/static/Vazirmatn-Regular-static.ttf')}
@font-face{font-family:'Noto Nastaliq Urdu';src:url('/tests/fonts/static/NotoNastaliqUrdu-Regular-static.ttf')}
"""
BASE_CSS = "@page{size:A4;margin:15mm} body{direction:rtl;text-align:right;line-height:1.9;font-size:14pt;margin:0} h1{font-size:22pt} p{margin:0 0 8pt} table{border-collapse:collapse;width:100%} td,th{border:1px solid #444;padding:4pt 8pt} .ltr{direction:ltr;text-align:left}"

def esc(s): return htmlmod.escape(s)

def page(title, body, font_stack, extra_css=""):
    return f"""<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>{esc(title)}</title>
<style>{FONT_FACES}{BASE_CSS} body{{font-family:{font_stack}}} {extra_css}</style></head><body>{body}</body></html>"""

def lines_html(lines, tag="p"):
    return "".join(f"<{tag}>{esc(l)}</{tag}>" for l in lines)

def invoice_body():
    rows = [l.split(" | ") for l in T.INVOICE[4:7]]
    head = "".join(f"<th>{esc(c)}</th>" for c in rows[0])
    body = "".join("<tr>" + "".join(f"<td>{esc(c)}</td>" for c in r) + "</tr>" for r in rows[1:])
    return (f"<h1>{esc(T.INVOICE[0])}</h1>" + lines_html(T.INVOICE[1:4]) +
            f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>" + lines_html(T.INVOICE[7:]))

def paragraphs_body():
    out = []
    for i, h in enumerate(T.HEADINGS):
        out.append(f"<h1>{esc(h)}</h1>")
        for p in T.PARAGRAPHS: out.append(f"<p style='text-align:justify'>{esc(p)}</p>")
        if i < len(T.HEADINGS) - 1: out.append("<div style='page-break-after:always'></div>")
    return "".join(out)

def paragraphs_truth():
    out = []
    for h in T.HEADINGS:
        out.append(h); out.extend(T.PARAGRAPHS)
    return out

def bidi_body():
    parts = [f"<p>{esc(l)}</p>" for l in T.BIDI_STRESS[:1]]
    parts.append(f"<p class='ltr'>{esc(T.BIDI_STRESS[1])}</p>")
    parts += [f"<p>{esc(l)}</p>" for l in T.BIDI_STRESS[2:]]
    return "".join(parts)

def form_body():
    f = T.FORM
    fields = "".join(f"<tr><th style='width:30%'>{esc(l)}</th><td style='height:26pt'></td></tr>" for l in f[1:7])
    return (f"<h1>{esc(f[0])}</h1><table>{fields}</table><p>{esc(f[7])}</p><p style='text-align:justify'>{esc(f[8])}</p><p>{esc(f[9])}</p>")

FILES = {
    "chrome-cairo-mixed-invoice": (page("فاتورة", invoice_body(), "'Cairo','Inter',sans-serif"), T.INVOICE),
    "chrome-amiri-tashkeel-ligatures": (page("تشكيل", lines_html(T.TASHKEEL), "'Amiri',serif", "body{font-size:20pt;line-height:2.4}"), T.TASHKEEL),
    "chrome-notonaskh-justified-3pages": (page("فصول", paragraphs_body(), "'Noto Naskh Arabic',serif"), paragraphs_truth()),
    "chrome-tajawal-persian-urdu-digits": (page("فارسی", lines_html(T.PERSIAN_URDU), "'Tajawal','Scheherazade New',sans-serif", "body{font-size:18pt}"), T.PERSIAN_URDU),
    "chrome-windows-arial-tahoma-times": (page("فاتورة", invoice_body(), "Arial,Tahoma,'Times New Roman',sans-serif", "h1{font-family:'Times New Roman'} table{font-family:Tahoma}"), T.INVOICE),
    "chrome-ibmplex-bidi-stress": (page("ثنائي الاتجاه", bidi_body(), "'IBM Plex Sans Arabic','Inter',sans-serif"), T.BIDI_STRESS),
    "chrome-notosansarabic-form-layout": (page("نموذج", form_body(), "'Noto Sans Arabic','Inter',sans-serif"), T.FORM),
    "chrome-vazirmatn-persian-prose": (page("فارسی", lines_html(T.PERSIAN_PROSE), "'Vazirmatn',sans-serif", "body{font-size:16pt}"), T.PERSIAN_PROSE),
    "chrome-nastaliq-urdu-prose": (page("اردو", lines_html(T.URDU_PROSE), "'Noto Nastaliq Urdu',serif", "body{font-size:16pt;line-height:2.6}"), T.URDU_PROSE),
    # variable webfont: Skia embeds it as a Type3 font with dots as separate glyphs mapped to U+0000
    "chrome-variablefont-type3-notonaskh-justified": (page("فصول", paragraphs_body(), "'Noto Naskh Arabic Variable',serif"), paragraphs_truth()),
}

for name, (doc, truth) in FILES.items():
    (HTML / f"{name}.html").write_text(doc, encoding="utf-8")
    (TRUTH / f"{name}.txt").write_text("\n".join(truth) + "\n", encoding="utf-8")

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def __init__(self, *a, **k): super().__init__(*a, directory=str(REPO), **k)

with socketserver.TCPServer(("127.0.0.1", 0), Quiet) as srv:
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix="warraq-chrome-")
    for name in FILES:
        url = f"http://127.0.0.1:{port}/tests/corpus/arabic/generators/html/{name}.html"
        out = OUT / f"{name}.pdf"
        cmd = [CHROME, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               f"--user-data-dir={profile}", "--hide-scrollbars", "--no-pdf-header-footer",
               "--virtual-time-budget=8000", "--run-all-compositor-stages-before-draw",
               f"--print-to-pdf={out}", url]
        # Chrome 152 writes the PDF and then keeps running (updater/background
        # processes), so poll for the output and kill the process group.
        if out.exists(): out.unlink()
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.time() + 60; last = -1; stable = 0
        while time.time() < deadline:
            time.sleep(0.5)
            size = out.stat().st_size if out.exists() else -1
            if size > 0 and size == last: stable += 1
            else: stable = 0
            last = size
            if stable >= 3 or proc.poll() is not None: break
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        ok = out.exists() and out.stat().st_size > 1000
        print(f"{'ok ' if ok else 'ERR'} {out.name} {out.stat().st_size if out.exists() else 0} bytes")
    srv.shutdown()
