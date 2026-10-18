"""Writes the icon Windows shows on a .pdf file once محرر PDF opens it.

A sheet of paper with its corner folded, carrying ZOOD's mark in the app
icon's copper and a navy band naming the file "PDF": a document of ours, not
the app itself (the owner's backlog, item 2). Composed from the same pieces
as the app icon (scripts/icon/make_zood_icons.py): ZOOD's mark exactly as
scripts/icon/zood/zood-mark.svg holds it, and "PDF" as the outlines drawn
there from ZOOD's headline face. Nothing is redrawn.

    python3 scripts/icon/make_pdf_document_icon.py

writes apps/desktop/pdf-document.svg, and — when cairosvg and Pillow are
installed — apps/desktop/src-tauri/resources/windows/pdf-document.ico, which
the Windows installer registers for .pdf (src-tauri/windows/hooks.nsh).
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SVG_OUT = os.path.join(REPO, 'apps', 'desktop', 'pdf-document.svg')
ICO_OUT = os.path.join(REPO, 'apps', 'desktop', 'src-tauri', 'resources', 'windows', 'pdf-document.ico')

# The app icon's colours (make_zood_icons.py: NAVY, COPPER).
NAVY = ('#0A2A55', '#041E42', '#031631')
COPPER = ('#C9A27C', '#977756', '#7A5C3F')

mark_svg = open(os.path.join(HERE, 'zood', 'zood-mark.svg'), encoding='utf-8').read()
MARK_W, MARK_H = (float(v) for v in re.search(r'viewBox="([^"]+)"', mark_svg).group(1).split()[2:])
MARK = re.findall(r'<path d="([^"]+)"/>', mark_svg)

composer = open(os.path.join(HERE, 'make_zood_icons.py'), encoding='utf-8').read()
PDF_W, PDF_H = (float(v) for v in re.search(r'PDF_W, PDF_H = ([\d.]+), ([\d.]+)', composer).groups())
PDF_D = re.search(r"PDF_D = '([^']+)'", composer).group(1)

# On a 256 square: the sheet, its folded corner (top right, as Windows draws
# its own documents), the mark in the upper part, the band along the foot.
LEFT, RIGHT, TOP, BOTTOM, FOLD = 36, 220, 8, 248, 56
RADIUS = 10
BAND_TOP, BAND_BOTTOM = 168, 222
MARK_SIDE = 120  # the mark's width

sheet = (
    f'M{LEFT + RADIUS} {TOP} H{RIGHT - FOLD} L{RIGHT} {TOP + FOLD} V{BOTTOM - RADIUS} '
    f'Q{RIGHT} {BOTTOM} {RIGHT - RADIUS} {BOTTOM} H{LEFT + RADIUS} Q{LEFT} {BOTTOM} {LEFT} {BOTTOM - RADIUS} '
    f'V{TOP + RADIUS} Q{LEFT} {TOP} {LEFT + RADIUS} {TOP} Z'
)
fold = f'M{RIGHT - FOLD} {TOP} V{TOP + FOLD - 8} Q{RIGHT - FOLD} {TOP + FOLD} {RIGHT - FOLD + 8} {TOP + FOLD} H{RIGHT} Z'

scale = MARK_SIDE / MARK_W
mark_x = (LEFT + RIGHT - FOLD / 3) / 2 - MARK_W * scale / 2
mark_y = (TOP + BAND_TOP) / 2 + 6 - MARK_H * scale / 2
marks = '\n'.join(f'      <path d="{d}"/>' for d in MARK)

text_h = 30
ts = text_h / PDF_H
text_x = (LEFT + RIGHT) / 2 - PDF_W * ts / 2
text_y = (BAND_TOP + BAND_BOTTOM) / 2 - text_h / 2

svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<!-- The icon of a .pdf file opened with محرر PDF on Windows: a sheet carrying
     ZOOD's own mark (ZOOD visual identity, Bold Brands, p. 8) in the app
     icon's copper, over a navy band naming the file. ZOOD's trademark, used
     at the owner's request. Written by scripts/icon/make_pdf_document_icon.py. -->
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="metal" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="{MARK_W}" y2="{MARK_H}">
      <stop offset="0" stop-color="{COPPER[0]}"/>
      <stop offset="0.5" stop-color="{COPPER[1]}"/>
      <stop offset="1" stop-color="{COPPER[2]}"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{NAVY[0]}"/>
      <stop offset="0.5" stop-color="{NAVY[1]}"/>
      <stop offset="1" stop-color="{NAVY[2]}"/>
    </linearGradient>
    <clipPath id="sheet"><path d="{sheet}"/></clipPath>
  </defs>
  <path d="{sheet}" fill="#FFFFFF" stroke="#8A97A8" stroke-width="5" stroke-linejoin="round"/>
  <g clip-path="url(#sheet)">
    <rect x="{LEFT}" y="{BAND_TOP}" width="{RIGHT - LEFT}" height="{BAND_BOTTOM - BAND_TOP}" fill="url(#ground)"/>
  </g>
  <path d="{fold}" fill="#DCE2EA" stroke="#8A97A8" stroke-width="5" stroke-linejoin="round"/>
  <g transform="translate({mark_x:.2f} {mark_y:.2f}) scale({scale:.5f})" fill="url(#metal)">
{marks}
  </g>
  <path transform="translate({text_x:.2f} {text_y:.2f}) scale({ts:.5f})" d="{PDF_D}" fill="#FFFFFF"/>
</svg>
'''

with open(SVG_OUT, 'w', encoding='utf-8') as out:
    out.write(svg)
print(SVG_OUT)

try:
    import io

    import cairosvg
    from PIL import Image
except ImportError:
    print('cairosvg or Pillow missing: the .ico was not written')
else:
    # Each size drawn from the vector on its own, so the small ones stay crisp.
    sizes = [16, 20, 24, 32, 40, 48, 64, 256]
    frames = [
        Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=s, output_height=s))).convert('RGBA')
        for s in sizes
    ]
    os.makedirs(os.path.dirname(ICO_OUT), exist_ok=True)
    frames[-1].save(ICO_OUT, format='ICO', sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    print(ICO_OUT)
