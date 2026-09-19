#!/usr/bin/env python3
"""Pages for search-and-redact where the words do not lie level on the page
as shown: the same lines on pages turned by /Rotate 0, 90, 180 and 270, then
a page whose lines all slant 8 degrees (as a crooked scan's text layer
does), and a page with a line up its margin beside level text, and a footer
marked as an artifact (as Word and Page marks write headers and footers)
that carries a name and a phone number.

English in Helvetica, so every word sits literally in the content stream
where a raw check can look for it. Standard library only. Run from the
repository root: python3 tests/fixtures/redact/make_turned.py

  pages 1-4  "Nadia Haddad keeps the rest" at 72, 700; "Line above stays"
             and "Line below stays" 40 points above and below
  page 5     the same three lines, each at 8 degrees from where it starts
  page 6     the middle line up the margin from 540, 200 (reading up);
             "Text beside it stays" at 400, 260; the footer "Prepared for
             Nadia Haddad, +966 50 123 4567" at 72, 40 as a pagination
             artifact
"""
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent

LEVEL = b"""BT /F1 12 Tf 72 740 Td (Line above stays) Tj ET
BT /F1 12 Tf 72 700 Td (Nadia Haddad keeps the rest) Tj ET
BT /F1 12 Tf 72 660 Td (Line below stays) Tj ET
"""

c, s = math.cos(math.radians(8)), math.sin(math.radians(8))
m = f"{c:.6f} {s:.6f} {-s:.6f} {c:.6f}"
CROOKED = f"""BT /F1 12 Tf {m} 72 740 Tm (Line above stays) Tj ET
BT /F1 12 Tf {m} 72 700 Tm (Nadia Haddad keeps the rest) Tj ET
BT /F1 12 Tf {m} 72 660 Tm (Line below stays) Tj ET
""".encode()

MARGIN = b"""BT /F1 12 Tf 0 1 -1 0 540 200 Tm (Nadia Haddad keeps the rest) Tj ET
BT /F1 12 Tf 400 260 Td (Text beside it stays) Tj ET
/Artifact << /Type /Pagination /Subtype /Footer >> BDC
BT /F1 10 Tf 72 40 Td (Prepared for Nadia Haddad, +966 50 123 4567) Tj ET
EMC
"""


def stream(body):
    return f"<< /Length {len(body)} >>\nstream\n".encode() + body + b"\nendstream"


pages = [(0, LEVEL), (90, LEVEL), (180, LEVEL), (270, LEVEL), (0, CROOKED), (0, MARGIN)]
objects = {
    1: b"<< /Type /Catalog /Pages 2 0 R >>",
    2: ("<< /Type /Pages /Kids [" + " ".join(f"{10 + 2 * i} 0 R" for i in range(len(pages)))
        + f"] /Count {len(pages)} >>").encode(),
    3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
}
for i, (rotate, content) in enumerate(pages):
    page, body = 10 + 2 * i, 11 + 2 * i
    objects[page] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate {rotate}"
                     f" /Contents {body} 0 R /Resources << /Font << /F1 3 0 R >> >> >>").encode()
    objects[body] = stream(content)

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
(HERE / "turned.pdf").write_bytes(out)
print("turned.pdf", len(out), "bytes")
