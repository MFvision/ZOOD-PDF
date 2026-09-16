from __future__ import annotations
"""Minimal, dependency-free PDF writer used by the corpus generators.

It exists so we can produce *exactly* the object structures we want to test
(no ToUnicode, broken ToUnicode, symbolic simple TrueType fonts) without any
library "helpfully" fixing them.
"""
import zlib

class PdfWriter:
    def __init__(self):
        self.objects = []  # list of bytes (object bodies), index+1 = object number

    def add(self, body: bytes) -> int:
        self.objects.append(body)
        return len(self.objects)

    def reserve(self) -> int:
        self.objects.append(None)
        return len(self.objects)

    def set(self, num: int, body: bytes):
        self.objects[num - 1] = body

    @staticmethod
    def stream(dict_entries: bytes, data: bytes, compress=True) -> bytes:
        if compress:
            data = zlib.compress(data)
            dict_entries += b" /Filter /FlateDecode"
        return b"<< " + dict_entries + b" /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"

    def build(self, root: int, info: int | None = None) -> bytes:
        out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for i, body in enumerate(self.objects, start=1):
            offsets.append(len(out))
            out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
        xref = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(self.objects) + 1)
        for off in offsets:
            out += b"%010d 00000 n \n" % off
        trailer = b"<< /Size %d /Root %d 0 R" % (len(self.objects) + 1, root)
        if info:
            trailer += b" /Info %d 0 R" % info
        trailer += b" >>"
        out += b"trailer\n" + trailer + b"\nstartxref\n%d\n%%%%EOF\n" % xref
        return bytes(out)

def pdf_text_string(s: str) -> bytes:
    """UTF-16BE text string with BOM, hex-encoded."""
    return b"<" + (b"\xfe\xff" + s.encode("utf-16-be")).hex().encode() + b">"
