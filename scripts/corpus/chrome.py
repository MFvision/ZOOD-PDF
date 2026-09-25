"""Chrome-made PDFs: HTML → headless Chromium `--print-to-pdf`, and 300-dpi screenshots for scans."""
from __future__ import annotations

import glob
import html
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

DATE_RE = re.compile(rb"D:\d{14}(?:[+-]\d\d'\d\d'|Z)?")


def find_chrome() -> str:
    env = os.environ.get("CHROME_PATH")
    if env:
        return env
    for pat in ("/opt/pw-browsers/chromium-*/chrome-linux/chrome", "/opt/pw-browsers/chromium-*/chrome-linux64/chrome"):
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[-1]
    for name in ("chromium", "chromium-browser", "google-chrome"):
        p = shutil.which(name)
        if p:
            return p
    raise SystemExit("Chromium not found: set CHROME_PATH")


def font_faces(fonts: dict) -> str:
    """@font-face rules for the CSS families used by the corpus."""
    def face(family, path, weight="400"):
        return f'@font-face{{font-family:"{family}";src:url("file://{path}");font-weight:{weight};}}'
    rules = [
        face("Amiri", fonts["amiri"]), face("Amiri", fonts["amiriBold"], "700"),
        face("NaskhStatic", fonts["naskh400"]), face("NaskhStatic", fonts["naskh700"], "700"),
        face("NaskhRegularOnly", fonts["naskh400"]),
        face("CairoVar", fonts["cairoVar"], "200 1000"),
        face("CairoStatic", fonts["cairo400"]), face("CairoStatic", fonts["cairo700"], "700"),
        face("Nastaliq", fonts["nastaliq400"]),
        face("Vazir", fonts["vazir400"]), face("Vazir", fonts["vazir700"], "700"),
        face("InterStatic", fonts["inter400"]), face("InterStatic", fonts["inter700"], "700"),
    ]
    return "\n".join(rules)


def render_block(b) -> str:
    kind = b[0]
    esc = html.escape
    if kind in ("h1", "h2", "h3"):
        return f"<{kind}>{esc(b[1])}</{kind}>"
    if kind == "p":
        opts = b[2] if len(b) > 2 else {}
        style = []
        attrs = ""
        if opts.get("align"):
            style.append(f"text-align:{opts['align']}")
        if opts.get("font"):
            style.append(f'font-family:"{opts["font"]}"')
        if opts.get("dir"):
            attrs += f' dir="{opts["dir"]}"'
        inner = esc(b[1])
        if opts.get("bold"):
            inner = f"<b>{inner}</b>"
        st = f' style="{";".join(style)}"' if style else ""
        return f"<p{attrs}{st}>{inner}</p>"
    if kind == "ul":
        return "<ul>" + "".join(f"<li>{esc(i)}</li>" for i in b[1]) + "</ul>"
    if kind == "ol":
        return "<ol>" + "".join(f"<li>{esc(i)}</li>" for i in b[1]) + "</ol>"
    if kind == "ol-ar":
        return '<ol style="list-style-type:arabic-indic">' + "".join(f"<li>{esc(i)}</li>" for i in b[1]) + "</ol>"
    if kind == "table":
        rows = []
        for r, row in enumerate(b[1]):
            tag = "th" if r == 0 else "td"
            rows.append("<tr>" + "".join(f"<{tag}>{esc(c)}</{tag}>" for c in row) + "</tr>")
        return "<table>" + "".join(rows) + "</table>"
    if kind == "cols":
        return '<div class="cols">' + "".join(render_block(x) for x in b[1]) + "</div>"
    raise ValueError(kind)


def build_html(doc: dict, fonts: dict, screen: bool = False) -> str:
    lang = doc.get("lang", "ar")
    d = doc.get("dir", "rtl")
    css = f"""
{font_faces(fonts)}
@page {{ size: A4; margin: 2cm; }}
html {{ -webkit-print-color-adjust: exact; }}
body {{ font-family: "{doc['font']}", "InterStatic"; font-size: {doc.get('size', 14)}pt;
        line-height: {doc.get('line_height', 1.6)}; color: #000; background: #fff; margin: 0; }}
h1 {{ font-size: 1.6em; margin: 0 0 .6em; }}
h2 {{ font-size: 1.3em; margin: 1em 0 .5em; }}
h3 {{ font-size: 1.1em; margin: 1em 0 .4em; }}
p {{ margin: 0 0 .8em; }}
.cols {{ column-count: 2; column-gap: 2.5em; text-align: justify; }}
table {{ border-collapse: collapse; margin: .5em 0 1em; }}
th, td {{ border: 1px solid #555; padding: .3em .8em; }}
"""
    if screen:
        css += "body { width: 642px; padding: 76px; }\n"
    body = "\n".join(render_block(b) for b in doc["blocks"])
    return (f'<!doctype html><html lang="{lang}" dir="{d}"><head><meta charset="utf-8">'
            f"<title>{html.escape(doc['title'])}</title><style>{css}</style></head><body>{body}</body></html>")


def _run_chrome(chrome: str, args: list[str], workdir: pathlib.Path) -> None:
    profile = tempfile.mkdtemp(prefix="chrome-profile-", dir=workdir)
    try:
        cmd = [chrome, "--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions",
               "--hide-scrollbars", "--font-render-hinting=none", f"--user-data-dir={profile}",
               "--virtual-time-budget=10000", *args]
        subprocess.run(cmd, check=True, timeout=180, capture_output=True)
    finally:
        # Chrome has exited (run waits); the profile can go.
        shutil.rmtree(profile, ignore_errors=True)


def print_pdf(chrome: str, html_path: pathlib.Path, out_pdf: pathlib.Path, workdir: pathlib.Path) -> None:
    _run_chrome(chrome, ["--no-pdf-header-footer", f"--print-to-pdf={out_pdf}", html_path.as_uri()], workdir)
    data = out_pdf.read_bytes()
    # Deterministic: fixed dates of the same length (xref offsets stay valid).
    data = DATE_RE.sub(lambda m: b"D:20250101000000" + m.group(0)[16:], data)
    out_pdf.write_bytes(data)


def screenshot(chrome: str, html_path: pathlib.Path, out_png: pathlib.Path, workdir: pathlib.Path) -> None:
    """A4 page at 96 css px/in × 3.125 = 300 dpi (2481 × 3509 px)."""
    _run_chrome(chrome, [f"--screenshot={out_png}", "--window-size=794,1123", "--force-device-scale-factor=3.125",
                         "--default-background-color=ffffffff", html_path.as_uri()], workdir)
