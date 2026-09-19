#!/usr/bin/env python3
"""Two pages whose outline has a heading that goes nowhere — as producers
write a part or a chapter title over its sections — a section that goes to
a page, one that goes to a web address, and an entry that goes to page 2.
Standard library only. Run from the repository root:
python3 tests/fixtures/panes/make.py

  Part one          no destination, open, over:
    Chapter         page 1
    On the web      https://example.org/
  Appendix          page 2
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def stream(body):
    return f"<< /Length {len(body)} >>\nstream\n".encode() + body + b"\nendstream"


objects = {
    1: b"<< /Type /Catalog /Pages 2 0 R /Outlines 20 0 R /PageMode /UseOutlines >>",
    2: b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    4: stream(b"BT /F1 24 Tf 72 700 Td (Chapter) Tj ET"),
    5: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    6: stream(b"BT /F1 24 Tf 72 700 Td (Appendix) Tj ET"),
    7: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    20: b"<< /Type /Outlines /First 21 0 R /Last 24 0 R /Count 4 >>",
    21: b"<< /Title (Part one) /Parent 20 0 R /Next 24 0 R /First 22 0 R /Last 23 0 R /Count 2 >>",
    22: b"<< /Title (Chapter) /Parent 21 0 R /Next 23 0 R /Dest [3 0 R /Fit] >>",
    23: b"<< /Title (On the web) /Parent 21 0 R /Prev 22 0 R /A << /S /URI /URI (https://example.org/) >> >>",
    24: b"<< /Title (Appendix) /Parent 20 0 R /Prev 21 0 R /Dest [5 0 R /Fit] >>",
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
(HERE / "headings.pdf").write_bytes(out)
print("headings.pdf", len(out), "bytes")
