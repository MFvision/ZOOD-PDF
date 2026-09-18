#!/usr/bin/env python3
"""A PDF carrying one of every kind of hidden information Remove hidden
information knows, each marked with a string of its own, so the tests can
grep the output for exactly what was removed — in the bytes and in every
decompressed stream. Standard library only. Run from the repository root:
python3 tests/fixtures/hidden/make.py

  metadata      INFO-TITLE-SECRET, INFO-AUTHOR-SECRET, XMP-SECRET
  scripts       DOCJS-SECRET, OPENACTION-SECRET, PAGE-AA-SECRET
  attachments   ATTACH-DOC-SECRET (doc-secret.txt), ATTACH-ANNOT-SECRET (annot-secret.txt)
  comments      COMMENT-SECRET, ANNOT-WRITER-SECRET
  forms         FIELDNAME-SECRET, FIELDVALUE-SECRET, XFA-SECRET; FIELD-SHOWN stays drawn
  hidden layers LAYER-OFF-SECRET, LAYERNAME-OFF-SECRET; LAYER-ON-TEXT stays
  bookmarks     BOOKMARK-SECRET
  thumbnails    THUMB-SECRET
  private data  PIECEINFO-SECRET, PAGEPIECE-SECRET
  links         link-secret.example, bookmark-uri-secret.example
  hidden text   WHITE-TEXT-SECRET, INVISIBLE-TEXT-SECRET, OFFPAGE-TEXT-SECRET
  revisions     OLD-REVISION-SECRET (only in the earlier revision)
  unreachable   ORPHAN-SECRET (an object nothing refers to)
  always kept   VISIBLE-TEXT-KEPT
"""
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent


def stream(body, compress=True, extra=""):
    data = zlib.compress(body) if compress else body
    filt = " /Filter /FlateDecode" if compress else ""
    return (f"<< /Length {len(data)}{filt}{extra} >>\nstream\n").encode() + data + b"\nendstream"


def write(objects, trailer_extra=""):
    """objects: {number: bytes}. Returns the file and each object's offset."""
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for n in sorted(objects):
        offsets[n] = len(out)
        out += f"{n} 0 obj\n".encode() + objects[n] + b"\nendobj\n"
    size = max(objects) + 1
    xref = len(out)
    out += f"xref\n0 {size}\n0000000000 65535 f \n".encode()
    for n in range(1, size):
        if n in offsets:
            out += f"{offsets[n]:010d} 00000 n \n".encode()
        else:
            out += b"0000000000 65535 f \n"
    out += f"trailer\n<< /Size {size} /Root 1 0 R{trailer_extra} >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out, size


def update(base, objects, size, trailer_extra=""):
    """An incremental update of `base` replacing `objects`."""
    prev = int(base.rsplit(b"startxref\n", 1)[1].split(b"\n", 1)[0])
    out = bytearray(base)
    offsets = {}
    for n in sorted(objects):
        offsets[n] = len(out)
        out += f"{n} 0 obj\n".encode() + objects[n] + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n"
    for n in sorted(offsets):
        out += f"{n} 1\n{offsets[n]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {size} /Root 1 0 R /Prev {prev}{trailer_extra} >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


content = b"""BT /F1 18 Tf 72 740 Td (VISIBLE-TEXT-KEPT) Tj ET
/OC /L1 BDC BT /F1 14 Tf 72 700 Td (LAYER-ON-TEXT) Tj ET EMC
/OC /L2 BDC BT /F1 14 Tf 72 680 Td (LAYER-OFF-SECRET) Tj ET EMC
q 1 g BT /F1 12 Tf 72 640 Td (WHITE-TEXT-SECRET) Tj ET Q
q BT 3 Tr /F1 12 Tf 72 620 Td (INVISIBLE-TEXT-SECRET) Tj ET Q
BT /F1 12 Tf -900 620 Td (OFFPAGE-TEXT-SECRET) Tj ET
BT /F1 12 Tf 72 600 Td (Visible again) Tj ET
"""

xmp = b"""<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>XMP-SECRET</dc:creator></rdf:Description>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>"""

objects = {
    1: b"""<< /Type /Catalog /Pages 2 0 R /Names 20 0 R /OpenAction 30 0 R /Outlines 40 0 R
/OCProperties << /OCGs [50 0 R 51 0 R] /D << /ON [50 0 R] /OFF [51 0 R] /Order [50 0 R 51 0 R] >> >>
/AcroForm 60 0 R /Metadata 70 0 R /PageMode /UseOutlines
/PieceInfo << /Warraq << /Private (PIECEINFO-SECRET) >> >> >>""",
    2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: b"""<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R
/Resources << /Font << /F1 5 0 R >> /Properties << /L1 50 0 R /L2 51 0 R >> >>
/Annots [10 0 R 11 0 R 12 0 R 13 0 R] /Thumb 15 0 R
/PieceInfo << /Warraq << /Private (PAGEPIECE-SECRET) >> >>
/AA << /O << /S /JavaScript /JS (app.alert('PAGE-AA-SECRET')) >> >> >>""",
    4: stream(content),
    5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    8: b"<< /Title (OLD-REVISION-SECRET) /Author (INFO-AUTHOR-SECRET) >>",
    10: b"<< /Type /Annot /Subtype /Text /Rect [400 700 420 720] /Contents (COMMENT-SECRET) /T (ANNOT-WRITER-SECRET) >>",
    11: b"<< /Type /Annot /Subtype /Link /Rect [72 580 200 596] /Border [0 0 0] /A << /S /URI /URI (https://link-secret.example/) >> >>",
    12: b"<< /Type /Annot /Subtype /FileAttachment /Rect [450 700 470 720] /FS 16 0 R /Contents (An attached note) >>",
    13: b"""<< /Type /Annot /Subtype /Widget /FT /Tx /T (FIELDNAME-SECRET) /V (FIELDVALUE-SECRET)
/Rect [72 500 272 524] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) /AP << /N 17 0 R >> >>""",
    15: stream(b"\x80" * 64, compress=False, extra=" /Width 8 /Height 8 /BitsPerComponent 8 /ColorSpace /DeviceGray /WarraqMarker (THUMB-SECRET)"),
    16: b"<< /Type /Filespec /F (annot-secret.txt) /UF (annot-secret.txt) /EF << /F 18 0 R >> >>",
    17: stream(b"/Tx BMC BT /F1 12 Tf 2 6 Td (FIELD-SHOWN) Tj ET EMC", extra=" /Type /XObject /Subtype /Form /BBox [0 0 200 24] /Resources << /Font << /F1 5 0 R >> >>"),
    18: stream(b"ATTACH-ANNOT-SECRET\n", extra=" /Type /EmbeddedFile /Params << /Size 20 >>"),
    20: b"<< /EmbeddedFiles << /Names [(doc-secret.txt) 21 0 R] >> /JavaScript << /Names [(init) 23 0 R] >> >>",
    21: b"<< /Type /Filespec /F (doc-secret.txt) /UF (doc-secret.txt) /Desc (A document attachment) /EF << /F 22 0 R >> >>",
    22: stream(b"ATTACH-DOC-SECRET\n", extra=" /Type /EmbeddedFile /Subtype /text#2Fplain /Params << /Size 18 >>"),
    23: b"<< /S /JavaScript /JS (console.println('DOCJS-SECRET')) >>",
    30: b"<< /S /JavaScript /JS (app.alert('OPENACTION-SECRET')) >>",
    40: b"<< /Type /Outlines /First 41 0 R /Last 42 0 R /Count 2 >>",
    41: b"<< /Title (BOOKMARK-SECRET) /Parent 40 0 R /Next 42 0 R /Dest [3 0 R /Fit] >>",
    42: b"<< /Title (Web) /Parent 40 0 R /Prev 41 0 R /A << /S /URI /URI (https://bookmark-uri-secret.example/) >> >>",
    50: b"<< /Type /OCG /Name (Visible layer) >>",
    51: b"<< /Type /OCG /Name (LAYERNAME-OFF-SECRET) >>",
    60: b"<< /Fields [13 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> /XFA 61 0 R >>",
    61: stream(b"<xdp:xdp xmlns:xdp='http://ns.adobe.com/xdp/'><data>XFA-SECRET</data></xdp:xdp>"),
    70: stream(xmp, compress=True, extra=" /Type /Metadata /Subtype /XML"),
    90: b"(ORPHAN-SECRET)",
}

base, size = write(objects, " /Info 8 0 R")
# The current revision's information replaces the earlier one's.
final = update(bytes(base), {8: b"<< /Title (INFO-TITLE-SECRET) /Author (INFO-AUTHOR-SECRET) >>"}, size, " /Info 8 0 R")
(HERE / "everything.pdf").write_bytes(final)
print("everything.pdf", len(final), "bytes")
