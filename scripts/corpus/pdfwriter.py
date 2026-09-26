"""A tiny, dependency-light PDF writer used to produce *synthetic* Word-/LibreOffice-style PDFs.

It is our own code (Apache-2.0). It is only used to generate test inputs; nothing here ships in the
product. Fonts are subset with fontTools (MIT) and shaped with uharfbuzz (Apache-2.0).
"""
from __future__ import annotations

import io
import zlib
from dataclasses import dataclass, field

import uharfbuzz as hb
from fontTools import subset as ftsubset
from fontTools.ttLib import TTFont


def pdf_str_hex_utf16(s: str) -> str:
    return "<FEFF" + "".join(f"{u:04X}" for u in _utf16_units(s)) + ">"


def _utf16_units(s: str) -> list[int]:
    b = s.encode("utf-16-be")
    return [int.from_bytes(b[i:i + 2], "big") for i in range(0, len(b), 2)]


def fmt(v: float) -> str:
    r = round(v, 3)
    if r == int(r):
        return str(int(r))
    return f"{r:.3f}".rstrip("0").rstrip(".")


class PdfDoc:
    def __init__(self, producer: str):
        self.objects: list[bytes | None] = []
        self.producer = producer
        self.pages: list[int] = []
        self.pages_id = self.reserve()

    def reserve(self) -> int:
        self.objects.append(None)
        return len(self.objects)

    def set(self, oid: int, body: bytes | str) -> int:
        self.objects[oid - 1] = body.encode("latin-1") if isinstance(body, str) else body
        return oid

    def add(self, body: bytes | str) -> int:
        return self.set(self.reserve(), body)

    def stream(self, dict_entries: str, data: bytes, compress: bool = True) -> int:
        if compress:
            data = zlib.compress(data, 9)
            dict_entries += " /Filter /FlateDecode"
        head = f"<< {dict_entries} /Length {len(data)} >>\nstream\n".encode("latin-1")
        return self.add(head + data + b"\nendstream")

    def add_page(self, content: bytes, resources: str, width: float = 595.276, height: float = 841.89) -> int:
        cid = self.stream("", content)
        pid = self.add(
            f"<< /Type /Page /Parent {self.pages_id} 0 R /MediaBox [0 0 {fmt(width)} {fmt(height)}] "
            f"/Resources {resources} /Contents {cid} 0 R >>"
        )
        self.pages.append(pid)
        return pid

    def write(self, path, title: str, lang: str = "ar") -> None:
        kids = " ".join(f"{p} 0 R" for p in self.pages)
        self.set(self.pages_id, f"<< /Type /Pages /Kids [{kids}] /Count {len(self.pages)} >>")
        catalog = self.add(f"<< /Type /Catalog /Pages {self.pages_id} 0 R /Lang (" + lang + ") >>")
        info = self.add(
            "<< /Title " + pdf_str_hex_utf16(title) + " /Producer (" + self.producer + ") "
            "/CreationDate (D:20250101000000Z) /ModDate (D:20250101000000Z) >>"
        )
        out = io.BytesIO()
        out.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for i, body in enumerate(self.objects, 1):
            offsets.append(out.tell())
            out.write(f"{i} 0 obj\n".encode())
            out.write(body or b"null")
            out.write(b"\nendobj\n")
        xref = out.tell()
        out.write(f"xref\n0 {len(self.objects) + 1}\n0000000000 65535 f \n".encode())
        for o in offsets:
            out.write(f"{o:010d} 00000 n \n".encode())
        out.write(
            f"trailer\n<< /Size {len(self.objects) + 1} /Root {catalog} 0 R /Info {info} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n".encode()
        )
        with open(path, "wb") as f:
            f.write(out.getvalue())


# ------------------------------------------------------------------------------------------
# Shaping


@dataclass
class Glyph:
    gid: int
    cluster: int  # char index in the shaped text
    x_advance: float  # points
    y_advance: float
    x_offset: float
    y_offset: float


@dataclass
class ShapedFont:
    path: str
    size: float = 12.0
    features: dict = field(default_factory=dict)

    def __post_init__(self):
        data = open(self.path, "rb").read()
        self.data = data
        self.face = hb.Face(hb.Blob(data))
        self.font = hb.Font(self.face)
        self.upem = self.face.upem
        self.tt = TTFont(io.BytesIO(data))
        self.hmtx = self.tt["hmtx"].metrics
        self.glyph_order = self.tt.getGlyphOrder()
        hhea = self.tt["hhea"]
        self.ascent = hhea.ascent * 1000 / self.upem
        self.descent = hhea.descent * 1000 / self.upem
        self.cmap = self.tt.getBestCmap()

    def shape(self, text: str, size: float, direction: str | None = None) -> list[Glyph]:
        buf = hb.Buffer()
        buf.add_codepoints([ord(c) for c in text])
        buf.guess_segment_properties()
        if direction:
            buf.direction = direction
        buf.cluster_level = hb.BufferClusterLevel.MONOTONE_CHARACTERS
        hb.shape(self.font, buf, self.features)
        k = size / self.upem
        return [
            Glyph(i.codepoint, i.cluster, p.x_advance * k, p.y_advance * k, p.x_offset * k, p.y_offset * k)
            for i, p in zip(buf.glyph_infos, buf.glyph_positions)
        ]

    def advance_1000(self, gid: int) -> float:
        name = self.glyph_order[gid]
        return self.hmtx[name][0] * 1000 / self.upem


def is_rtl_word(w: str) -> bool:
    for c in w:
        o = ord(c)
        if 0x0590 <= o <= 0x08FF or 0xFB1D <= o <= 0xFEFC:
            return True
        if c.isalpha():
            return False
    return False


def is_latin_word(w: str) -> bool:
    for c in w:
        o = ord(c)
        if 0x0590 <= o <= 0x08FF:
            return False
        if c.isalpha():
            return True
    return False


def visual_word_order(words: list[str]) -> list[int]:
    """Word-level bidi for an RTL line: returns indices of words from left to right.

    Consecutive Latin words (with digits between them) form one left-to-right block.
    """
    blocks: list[list[int]] = []
    i = 0
    while i < len(words):
        if is_latin_word(words[i]):
            j = i
            blk = [i]
            while j + 1 < len(words) and (is_latin_word(words[j + 1]) or (
                    not is_rtl_word(words[j + 1]) and j + 2 < len(words) and is_latin_word(words[j + 2]))):
                j += 1
                blk.append(j)
            blocks.append(blk)
            i = j + 1
        else:
            blocks.append([i])
            i += 1
    out = []
    for blk in reversed(blocks):
        out.extend(blk)
    return out


# ------------------------------------------------------------------------------------------
# Fonts


class CidFont:
    """Identity-H CIDFontType2 font collecting used glyphs and their Unicode text."""

    def __init__(self, sf: ShapedFont, tag: str, name: str):
        self.sf = sf
        self.tag = tag
        self.name = name
        self.used: set[int] = {0}
        self.gid_text: dict[int, str] = {}

    def map_glyph(self, gid: int, text: str) -> bool:
        """Record glyph → text. Returns False when the glyph already maps to other text."""
        self.used.add(gid)
        cur = self.gid_text.get(gid)
        if cur is None:
            self.gid_text[gid] = text
            return True
        return cur == text

    def embed(self, doc: PdfDoc, with_tounicode: bool = True) -> int:
        opts = ftsubset.Options()
        opts.retain_gids = True
        opts.layout_features = []
        opts.notdef_outline = True
        opts.name_IDs = []
        opts.drop_tables += ["GSUB", "GPOS", "GDEF", "STAT", "fvar", "gvar", "avar", "HVAR", "MVAR", "DSIG"]
        tt = TTFont(io.BytesIO(self.sf.data), recalcTimestamp=False)
        sub = ftsubset.Subsetter(opts)
        sub.populate(gids=sorted(self.used))
        sub.subset(tt)
        buf = io.BytesIO()
        tt.save(buf)
        data = buf.getvalue()
        ff = doc.stream(f"/Length1 {len(data)}", data)
        base = f"{self.tag}+{self.name}"
        bbox = self.sf.tt["head"]
        k = 1000 / self.sf.upem
        fd = doc.add(
            f"<< /Type /FontDescriptor /FontName /{base} /Flags 4 /FontBBox [{int(bbox.xMin * k)} {int(bbox.yMin * k)} "
            f"{int(bbox.xMax * k)} {int(bbox.yMax * k)}] /ItalicAngle 0 /Ascent {int(self.sf.ascent)} "
            f"/Descent {int(self.sf.descent)} /CapHeight {int(self.sf.ascent * 0.7)} /StemV 80 /FontFile2 {ff} 0 R >>"
        )
        widths = " ".join(f"{g} [{fmt(self.sf.advance_1000(g))}]" for g in sorted(self.used))
        cid = doc.add(
            f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{base} /CIDSystemInfo << /Registry (Adobe) "
            f"/Ordering (Identity) /Supplement 0 >> /FontDescriptor {fd} 0 R /DW 1000 /W [{widths}] "
            f"/CIDToGIDMap /Identity >>"
        )
        tu = ""
        if with_tounicode:
            tu_id = doc.stream("", tounicode_cmap({g: t for g, t in self.gid_text.items()}, 2))
            tu = f" /ToUnicode {tu_id} 0 R"
        return doc.add(
            f"<< /Type /Font /Subtype /Type0 /BaseFont /{base} /Encoding /Identity-H "
            f"/DescendantFonts [{cid} 0 R]{tu} >>"
        )


def tounicode_cmap(mapping: dict[int, str], code_bytes: int) -> bytes:
    lines = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<" + "00" * code_bytes + "> <" + "FF" * code_bytes + ">",
        "endcodespacerange",
    ]
    items = sorted(mapping.items())
    for i in range(0, len(items), 100):
        chunk = items[i:i + 100]
        lines.append(f"{len(chunk)} beginbfchar")
        for code, text in chunk:
            dst = "".join(f"{u:04X}" for u in _utf16_units(text)) or "0000"
            lines.append(f"<{code:0{code_bytes * 2}X}> <{dst}>")
        lines.append("endbfchar")
    lines += ["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"]
    return "\n".join(lines).encode("ascii")
