#!/usr/bin/env python3
"""Photos for the iOS scanner's tests (apps/ios): synthetic, so what they hold
is known exactly.

  id-front.jpg, id-back.jpg   a card (ISO ID-1 proportions) lying a little
                              crooked on a dark desk, for ID mode
  book-spread.jpg             an open book: two pages, a dark gutter down the
                              middle, the lines of text bowed towards it as
                              a curved page's are, for book mode
  page-crooked.jpg            a page on a dark desk, turned 6 degrees, for
                              edge detection and deskew
  whiteboard.jpg              a whiteboard with blue, red and green marker
                              writing, a window's glare and a shadow, for
                              whiteboard mode

Run from the repository root: python3 tests/fixtures/scan/make_fixtures.py
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FONT = HERE.parent.parent / "fonts" / "NotoSans-Variable.ttf"


def font(size):
    return ImageFont.truetype(str(FONT), size)


def card(front):
    """A pale card with a name block and a number, on a dark grey desk, turned 4 degrees."""
    w, h = 1712, 1080  # ID-1 at 500 dpi: 85.60 x 53.98 mm
    card = Image.new("RGB", (w, h), (238, 236, 228))
    d = ImageDraw.Draw(card)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=62, outline=(180, 178, 170), width=4)
    if front:
        d.rectangle([90, 120, 560, 720], fill=(200, 205, 215))
        d.text((640, 130), "IDENTITY CARD", font=font(88), fill=(30, 40, 90))
        d.text((640, 300), "Name: SAMI AL AHMAD", font=font(66), fill=(20, 20, 20))
        d.text((640, 420), "Born: 1990-04-12", font=font(66), fill=(20, 20, 20))
        d.text((640, 540), "No: 1029 3847 5610", font=font(66), fill=(20, 20, 20))
        d.text((90, 820), "Expires 2031-04-11", font=font(60), fill=(60, 60, 60))
    else:
        d.rectangle([0, 150, w, 330], fill=(40, 40, 40))
        d.text((90, 420), "Signature ______________", font=font(66), fill=(20, 20, 20))
        d.text((90, 560), "Issued by the Civil Registry", font=font(60), fill=(60, 60, 60))
        d.text((90, 760), "<<<1029384756<<<<<<<<<<<<", font=font(70), fill=(20, 20, 20))
    turned = card.rotate(4, resample=Image.BICUBIC, expand=True, fillcolor=(0, 0, 0))
    desk = Image.new("RGB", (turned.width + 400, turned.height + 400), (52, 50, 48))
    mask = Image.new("L", card.size, 255).rotate(4, resample=Image.BICUBIC, expand=True)
    desk.paste(turned, (200, 200), mask)
    return desk.resize((desk.width // 2, desk.height // 2), Image.LANCZOS)


def bow_columns(img, amount, towards_right):
    """Each column slid down by a parabola rising towards one edge: a curved page's lines."""
    w, h = img.size
    out = Image.new("RGB", img.size, (255, 255, 255))
    src = img.load()
    dst = out.load()
    for x in range(w):
        t = x / (w - 1)
        if not towards_right:
            t = 1 - t
        shift = amount * t * t
        for y in range(h):
            sy = y - shift
            y0 = int(math.floor(sy))
            f = sy - y0
            if y0 < 0 or y0 + 1 >= h:
                continue
            a = src[x, y0]
            b = src[x, y0 + 1]
            dst[x, y] = tuple(int(round(a[c] * (1 - f) + b[c] * f)) for c in range(3))
    return out


def page_text(w, h, first_line, bow, towards_right):
    """A page of text lines, bowed by `bow` pixels towards one edge."""
    page = Image.new("RGB", (w, h), (246, 244, 238))
    d = ImageDraw.Draw(page)
    words = ("The quick brown fox jumps over the lazy dog while the scanner reads every line "
             "of the open book and the pages curve gently towards the middle").split()
    y = 90
    k = first_line
    f = font(34)
    while y < h - 80:
        line = " ".join(words[(k + i) % len(words)] for i in range(9))
        d.text((70, y), line, font=f, fill=(25, 25, 25))
        y += 58
        k += 3
    return bow_columns(page, bow, towards_right)


def book_spread():
    w, h = 1100, 1500
    left = page_text(w, h, 0, 64, towards_right=True)
    right = page_text(w, h, 5, 64, towards_right=False)
    gutter = 70
    spread = Image.new("RGB", (2 * w + gutter, h), (60, 58, 55))
    spread.paste(left, (0, 0))
    spread.paste(right, (w + gutter, 0))
    d = ImageDraw.Draw(spread)
    # The gutter darkens into the fold on both sides.
    for i in range(60):
        shade = 246 - int(190 * (i / 59) ** 1.6)
        d.line([(w - 60 + i, 0), (w - 60 + i, h)], fill=(shade, shade - 2, shade - 6))
        d.line([(w + gutter + 59 - i, 0), (w + gutter + 59 - i, h)], fill=(shade, shade - 2, shade - 6))
    desk = Image.new("RGB", (spread.width + 300, spread.height + 300), (42, 40, 38))
    desk.paste(spread, (150, 150))
    return desk.resize((desk.width * 2 // 3, desk.height * 2 // 3), Image.LANCZOS)


def crooked_page():
    w, h = 1240, 1754  # A4 at 150 dpi
    page = Image.new("RGB", (w, h), (250, 249, 245))
    d = ImageDraw.Draw(page)
    d.text((110, 120), "Meeting notes", font=font(64), fill=(20, 20, 20))
    y = 260
    f = font(36)
    lines = [
        "Agenda item one: the scanner finds the page on the desk.",
        "Agenda item two: the corners are corrected and the page is level.",
        "Agenda item three: the shadow across the paper is divided away.",
        "Agenda item four: the words are read and written into the PDF.",
        "Agenda item five: searching the file finds every word.",
    ]
    for i in range(24):
        d.text((110, y), lines[i % len(lines)], font=f, fill=(30, 30, 30))
        y += 58
    turned = page.rotate(6, resample=Image.BICUBIC, expand=True, fillcolor=(0, 0, 0))
    mask = Image.new("L", page.size, 255).rotate(6, resample=Image.BICUBIC, expand=True)
    desk = Image.new("RGB", (turned.width + 300, turned.height + 300), (58, 56, 52))
    desk.paste(turned, (150, 150), mask)
    return desk.resize((desk.width // 2, desk.height // 2), Image.LANCZOS)


def whiteboard():
    w, h = 1600, 1000
    board = Image.new("RGB", (w, h), (232, 234, 230))
    px = board.load()
    # Glare from a window on the left, a shadow across the right.
    for x in range(w):
        for y in range(h):
            g = max(0.0, 1 - ((x - 300) ** 2 + (y - 250) ** 2) / 240000.0)
            shade = 1 - 0.32 * max(0.0, (x - 900) / 700.0)
            r, gg, b = px[x, y]
            px[x, y] = (min(255, int((r + 40 * g) * shade)), min(255, int((gg + 40 * g) * shade)), min(255, int((b + 30 * g) * shade)))
    d = ImageDraw.Draw(board)
    d.text((120, 120), "Sprint plan", font=font(90), fill=(40, 60, 170))
    d.text((120, 300), "1. Scanner: edges + OCR", font=font(60), fill=(40, 60, 170))
    d.text((120, 420), "2. Whiteboard mode: keep colours", font=font(60), fill=(180, 40, 40))
    d.text((120, 540), "3. Ship Friday", font=font(60), fill=(30, 130, 60))
    d.ellipse([1050, 300, 1450, 700], outline=(180, 40, 40), width=8)
    frame = Image.new("RGB", (w + 200, h + 200), (70, 68, 66))
    frame.paste(board, (100, 100))
    return frame.resize((frame.width * 2 // 3, frame.height * 2 // 3), Image.LANCZOS)


if __name__ == "__main__":
    card(True).save(HERE / "id-front.jpg", "JPEG", quality=82)
    card(False).save(HERE / "id-back.jpg", "JPEG", quality=82)
    book_spread().save(HERE / "book-spread.jpg", "JPEG", quality=82)
    crooked_page().save(HERE / "page-crooked.jpg", "JPEG", quality=82)
    whiteboard().save(HERE / "whiteboard.jpg", "JPEG", quality=82)
    for name in ("id-front", "id-back", "book-spread", "page-crooked", "whiteboard"):
        print(name, Image.open(HERE / f"{name}.jpg").size)
