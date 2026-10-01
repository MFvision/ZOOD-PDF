"""Writes ZOOD's app icon and in-app artwork from ZOOD's own logo.

The artwork is not drawn here: it is ZOOD's mark and its three logos (Main,
Vertical, Horizontal) from the brand's own identity package (ZOOD New CI,
"01. Logo Design", Illustrator files saved PDF-compatible), cut into
scripts/icon/zood/*.svg — the paths exactly as the .ai files hold them, only
moved to a tight box with the y axis turned down. This script composes
them; it never redraws a curve. The brand's three graphical elements
(scripts/icon/zood/zood-pattern-0N.pdf) were cut from the same package by
scripts/icon/crop_pdf.swift and are copied as they are.

The icon is the brand's own way of carrying its mark: copper on navy, as
the guide's folder has it, foil-stamped (p. 28) — the mark in ZOOD's bronze
(Pantone 2318 C) on ZOOD's navy (Pantone 282 C), nothing else.

    python3 scripts/icon/make_zood_icons.py <out-dir>

writes into <out-dir>:

    square.svg          full bleed (iOS cuts its own shape; also maskable:
                        the mark sits well inside the middle 80 %)
    square-dark.svg     the dark appearance: the same copper on a deeper navy
    square-tinted.svg   the tinted appearance: one grey ramp on black, which
                        the system colours itself
    tile.svg            the continuous-corner tile, for the desktop and the page

and the vector artwork for the iOS asset catalogue, as single-colour PDFs
(template images, so the app colours them):

    ZoodMark.pdf, ZoodLogoMain.pdf, ZoodLogoVertical.pdf, ZoodLogoHorizontal.pdf
"""
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, 'zood')
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- the colours
#
# ZOOD's palette (guide p. 9). The navy is Pantone 282 C; the bronze is
# Pantone 2318 C as the guide renders it, run from a lit edge to a shaded
# one the way a foil catches the light. The same numbers are `ZoodPalette`
# and `ZoodIcon` in apps/ios/PDFEditor/Design/Brand.swift.
NAVY = ('#0A2A55', '#041E42', '#031631')
NAVY_DARK = ('#041330', '#020D22', '#010815')
COPPER = ('#C9A27C', '#977756', '#7A5C3F')
COPPER_DARK = ('#D2AE89', '#A3825F', '#866747')
GREY = ('#FFFFFF', '#D9D9D9', '#B3B3B3')

# How wide the mark is, as a share of the icon's side, and where its centre
# sits. ZoodIcon.markWidth in Brand.swift is the same number; ThemeTests
# compares the icon iOS was given with the app's own drawing of it.
MARK_WIDTH = 0.60


def load(name):
    text = open(os.path.join(ART, name + '.svg'), encoding='utf-8').read()
    box = [float(v) for v in re.search(r'viewBox="([^"]+)"', text).group(1).split()]
    paths = re.findall(r'<path d="([^"]+)"/>', text)
    return box[2], box[3], paths


MARK_W, MARK_H, MARK = load('zood-mark')


def squircle(cx, cy, half, n=5.0, steps=256):
    """A continuous-corner square, as the desktop icon's tile is."""
    points = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = cx + half * math.copysign(abs(c) ** (2 / n), c)
        y = cy + half * math.copysign(abs(s) ** (2 / n), s)
        points.append(f'{x:.2f},{y:.2f}')
    return 'M' + ' L'.join(points) + ' Z'


def icon(name, ground, metal, body, side):
    """The mark, centred, `MARK_WIDTH` of `side` wide, on `ground`."""
    scale = side * MARK_WIDTH / MARK_W
    x = 512 - MARK_W * scale / 2
    y = 512 - MARK_H * scale / 2
    marks = '\n'.join(f'      <path d="{d}"/>' for d in MARK)
    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<!-- محرر PDF's app icon: ZOOD's own mark (ZOOD visual identity, Bold Brands,
     p. 8), copper on navy as the brand foil-stamps it (p. 28). ZOOD's
     trademark, used at the owner's request. Written by
     scripts/icon/make_zood_icons.py from scripts/icon/zood/zood-mark.svg. -->
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{ground[0]}"/>
      <stop offset="0.5" stop-color="{ground[1]}"/>
      <stop offset="1" stop-color="{ground[2]}"/>
    </linearGradient>
    <linearGradient id="metal" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="{MARK_W:.3f}" y2="{MARK_H:.3f}">
      <stop offset="0" stop-color="{metal[0]}"/>
      <stop offset="0.5" stop-color="{metal[1]}"/>
      <stop offset="1" stop-color="{metal[2]}"/>
    </linearGradient>
  </defs>
  <path d="{body}" fill="url(#ground)"/>
  <g fill="url(#metal)">
    <g transform="translate({x:.3f} {y:.3f}) scale({scale:.5f})">
{marks}
    </g>
  </g>
</svg>
'''
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as handle:
        handle.write(svg)


FULL = 'M0 0 H1024 V1024 H0 Z'
icon('square.svg', NAVY, COPPER, FULL, 1024)
icon('square-dark.svg', NAVY_DARK, COPPER_DARK, FULL, 1024)
icon('square-tinted.svg', ('#000000',) * 3, GREY, FULL, 1024)
# The desktop tile is 824 across (100 of margin all round, as macOS icons
# keep); the mark is the same share of the tile as of the iOS square.
icon('tile.svg', NAVY, COPPER, squircle(512, 512, 412), 824)

# ---------------------------------------------------------- the vector artwork
#
# Single-colour PDFs of the artwork, the same paths in PDF's upward axis.
# Xcode keeps them as vectors ("Preserve Vector Data") and draws them as
# template images, so the app gives them whatever colour the theme asks.
TOKEN = re.compile(r'([MLCZ])([^MLCZ]*)')


def pdf_ops(d, height):
    ops = []
    for op, rest in TOKEN.findall(d):
        numbers = [float(v) for v in rest.split()]
        points = [(numbers[i], height - numbers[i + 1]) for i in range(0, len(numbers), 2)]
        text = ' '.join(f'{px:.3f} {py:.3f}' for px, py in points)
        if op == 'M':
            ops.append(f'{text} m')
        elif op == 'L':
            ops.append(f'{text} l')
        elif op == 'C':
            ops.append(f'{text} c')
        else:
            ops.append('h')
    return '\n'.join(ops)


def pdf(svg_name, pdf_name):
    width, height, paths = load(svg_name)
    content = '0 0 0 rg\n' + '\n'.join(pdf_ops(d, height) + '\nf' for d in paths) + '\n'
    objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.3f} {height:.3f}] /Contents 4 0 R /Resources << >> >>',
        f'<< /Length {len(content.encode())} >>\nstream\n{content}endstream',
    ]
    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f'{number} 0 obj\n{body}\nendobj\n'.encode()
    xref = len(out)
    out += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode()
    for offset in offsets:
        out += f'{offset:010d} 00000 n \n'.encode()
    out += f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    with open(os.path.join(OUT, pdf_name), 'wb') as handle:
        handle.write(out)


pdf('zood-mark', 'ZoodMark.pdf')
pdf('zood-logo-main', 'ZoodLogoMain.pdf')
pdf('zood-logo-vertical', 'ZoodLogoVertical.pdf')
pdf('zood-logo-horizontal', 'ZoodLogoHorizontal.pdf')
print(OUT)
