#!/usr/bin/env python3
"""A one-page PDF with layers (optional content groups) for the Layers pane:
four layers, one named in Arabic, one switched off, one locked, one that
prints while hidden, listed in an order tree with a nested layer and a
labelled group. Each layer draws something large and of its own colour, so
switching it changes the page visibly. Standard library only. Run from the
repository root: python3 tests/fixtures/layers/make.py

  "Text"           on    black text LAYER-TEXT and a grey band
  "طبقة عربية"     on    a blue square (named in Arabic, UTF-16BE)
  "Watermark"      off   a red square; /Usage says it prints
  "Locked notes"   on    locked; a green square, listed under "Text"
"""
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent


def utf16(s):
    return "<FEFF" + s.encode("utf-16-be").hex().upper() + ">"


def stream(body):
    data = zlib.compress(body)
    return f"<< /Length {len(data)} /Filter /FlateDecode >>\nstream\n".encode() + data + b"\nendstream"


content = b"""/OC /Text BDC 0.85 g 40 600 532 60 re f
BT 0 g /F1 36 Tf 60 615 Td (LAYER-TEXT) Tj ET EMC
/OC /Arabic BDC 0 0 1 rg 60 300 200 200 re f EMC
/OC /Mark BDC 1 0 0 rg 330 300 200 200 re f EMC
/OC /Locked BDC 0 0.6 0 rg 60 60 470 180 re f EMC
BT 0 g /F1 14 Tf 60 760 Td (Always shown) Tj ET
"""

objects = {
    1: f"""<< /Type /Catalog /Pages 2 0 R
/OCProperties << /OCGs [10 0 R 11 0 R 12 0 R 13 0 R]
/D << /Name (Default) /ON [10 0 R 11 0 R 13 0 R] /OFF [12 0 R] /Locked [13 0 R]
/Order [10 0 R [13 0 R] 11 0 R [(Extras) 12 0 R]]
/AS [<< /Event /Print /Category [/Print] /OCGs [12 0 R] >>] >> >> >>""".encode(),
    2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: b"""<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R
/Resources << /Font << /F1 5 0 R >> /Properties << /Text 10 0 R /Arabic 11 0 R /Mark 12 0 R /Locked 13 0 R >> >> >>""",
    4: stream(content),
    5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    10: b"<< /Type /OCG /Name (Text) >>",
    11: f"<< /Type /OCG /Name {utf16('طبقة عربية')} >>".encode(),
    12: b"<< /Type /OCG /Name (Watermark) /Usage << /Print << /PrintState /ON >> /View << /ViewState /OFF >> >> >>",
    13: b"<< /Type /OCG /Name (Locked notes) /Usage << /Export << /ExportState /OFF >> >> >>",
}

out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
offsets = {}
for n in sorted(objects):
    offsets[n] = len(out)
    out += f"{n} 0 obj\n".encode() + objects[n] + b"\nendobj\n"
size = max(objects) + 1
xref = len(out)
out += f"xref\n0 {size}\n0000000000 65535 f \n".encode()
for n in range(1, size):
    out += (f"{offsets[n]:010d} 00000 n \n" if n in offsets else "0000000000 65535 f \n").encode()
out += f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
(HERE / "layers.pdf").write_bytes(out)
print("layers.pdf", len(out), "bytes")
