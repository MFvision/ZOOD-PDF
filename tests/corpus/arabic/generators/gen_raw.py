#!/usr/bin/env python3
"""HarfBuzz-shaped raw PDFs with precisely controlled font/ToUnicode structures.

Produces:
  raw-amiri-cid-identity-tounicode.pdf   ideal Type0/CIDFontType2, Identity-H, correct ToUnicode
  raw-amiri-cid-no-tounicode.pdf          same glyph runs, ToUnicode omitted
  raw-cairo-cid-broken-tounicode.pdf      ToUnicode maps every CID to U+FFFD
  raw-legacy-symbolic-truetype.pdf        simple TrueType, symbolic (3,0) cmap, 1-byte codes,
                                          presentation-form glyphs in visual order, no ToUnicode
"""
import io, os, sys, unicodedata
from pathlib import Path
import uharfbuzz as hb
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
sys.path.insert(0, os.path.dirname(__file__))
import corpus_texts as T
from pdfwriter import PdfWriter, pdf_text_string
from bidi_lite import runs as bidi_runs

REPO = Path(sys.argv[1]).resolve()
FONTS = REPO / "tests/fonts"; OUT = REPO / "tests/corpus/arabic/generated"; TRUTH = REPO / "tests/corpus/arabic/truth"
A4 = (595.28, 841.89); MARGIN = 56.0
LINES = T.INVOICE + T.TASHKEEL + T.BIDI_STRESS[:5]

def load_font(path: Path) -> bytes:
    tt = TTFont(path)
    if "fvar" in tt:  # embed a static instance, not the variable font
        tt = instancer.instantiateVariableFont(tt, {a.axisTag: a.defaultValue for a in tt["fvar"].axes})
        buf = io.BytesIO(); tt.save(buf); return buf.getvalue()
    return path.read_bytes()

class Shaper:
    def __init__(self, fontdata: bytes):
        self.face = hb.Face(fontdata); self.font = hb.Font(self.face)
        self.upem = self.face.upem; self.font.scale = (self.upem, self.upem)
        self.tt = TTFont(io.BytesIO(fontdata)); self.hmtx = self.tt["hmtx"]; self.order = self.tt.getGlyphOrder()
    def width(self, gid: int) -> float:  # in 1/1000 text space
        return self.hmtx[self.order[gid]][0] * 1000.0 / self.upem
    def shape(self, text: str, direction: str):
        buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties(); buf.direction = direction
        buf.cluster_level = hb.BufferClusterLevel.MONOTONE_CHARACTERS
        hb.shape(self.font, buf, {"kern": True, "liga": True, "calt": True, "rlig": True, "mark": True, "mkmk": True})
        infos, poss = buf.glyph_infos, buf.glyph_positions
        # map glyph -> unicode text via clusters (logical order)
        clusters = sorted(set(i.cluster for i in infos))
        nxt = {c: (clusters[k+1] if k+1 < len(clusters) else len(text)) for k, c in enumerate(clusters)}
        glyphs = []
        for i, p in zip(infos, poss):
            s = self.upem / 1000.0
            glyphs.append({"gid": i.codepoint, "text": text[i.cluster:nxt[i.cluster]],
                           "adv": p.x_advance / s, "xoff": p.x_offset / s, "yoff": p.y_offset / s})
        return glyphs

def layout_line(shaper: Shaper, line: str, size: float, x_right: float, y: float, code_of):
    """Return (content ops, [(gid,text)]) placing the line right-aligned at x_right."""
    vruns = bidi_runs(line)
    shaped = [shaper.shape(seg, d) for seg, d, _ in vruns]
    total = sum(g["adv"] for run in shaped for g in run) * size / 1000.0
    x = x_right - total
    ops = [b"BT /F1 %.2f Tf" % size]
    used = []
    pen = x
    chunk = []; chunk_x = None
    def flush():
        nonlocal chunk, chunk_x
        if chunk:
            ops.append(b"1 0 0 1 %.3f %.3f Tm [%s] TJ" % (chunk_x, y, b" ".join(chunk)))
        chunk = []; chunk_x = None
    for run in shaped:
        for g in run:
            used.append((g["gid"], g["text"]))
            code = code_of(g["gid"])
            if g["xoff"] or g["yoff"]:
                flush()
                ops.append(b"1 0 0 1 %.3f %.3f Tm <%s> Tj" % (pen + g["xoff"] * size / 1000.0, y + g["yoff"] * size / 1000.0, code))
            else:
                if chunk_x is None: chunk_x = pen
                chunk.append(b"<%s>" % code)
                diff = shaper.width(g["gid"]) - g["adv"]  # PDF advances by glyph width; correct with TJ
                if abs(diff) > 0.01: chunk.append(b"%.1f" % diff)
            pen += g["adv"] * size / 1000.0
    flush(); ops.append(b"ET")
    return b"\n".join(ops), used

def subset_font(fontdata: bytes, gids, retain_gids=True, family_rename=None) -> bytes:
    tt = TTFont(io.BytesIO(fontdata))
    opts = subset.Options(); opts.retain_gids = retain_gids; opts.hinting = False; opts.desubroutinize = True
    opts.drop_tables += ["GSUB", "GPOS", "GDEF", "BASE", "JSTF", "MATH", "DSIG"]; opts.notdef_outline = True
    opts.name_IDs = ["*"]; opts.name_legacy = True; opts.layout_features = []; opts.glyph_names = True
    sub = subset.Subsetter(opts); sub.populate(gids=sorted(set(gids) | {0})); sub.subset(tt)
    if family_rename:
        for rec in tt["name"].names:
            if rec.nameID in (1, 4, 6, 16):
                rec.string = family_rename
    buf = io.BytesIO(); tt.save(buf); return buf.getvalue()

def tounicode_cmap(mapping: dict) -> bytes:
    """mapping: code(int, 2-byte) -> unicode str"""
    lines = [b"/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"]
    items = sorted(mapping.items())
    for i in range(0, len(items), 100):
        chunk = items[i:i+100]
        lines.append(b"%d beginbfchar\n" % len(chunk))
        for code, s in chunk:
            lines.append(b"<%04X> <%s>\n" % (code, s.encode("utf-16-be").hex().upper().encode()))
        lines.append(b"endbfchar\n")
    lines.append(b"endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n")
    return b"".join(lines)

def font_descriptor(w: PdfWriter, tt: TTFont, name: bytes, fontfile: int) -> int:
    head, os2, hhea = tt["head"], tt["OS/2"], tt["hhea"]
    s = 1000.0 / head.unitsPerEm
    bbox = b"[%d %d %d %d]" % (head.xMin * s, head.yMin * s, head.xMax * s, head.yMax * s)
    return w.add(b"<< /Type /FontDescriptor /FontName /%s /Flags 4 /FontBBox %s /ItalicAngle 0 /Ascent %d /Descent %d /CapHeight %d /StemV 80 /FontFile2 %d 0 R >>"
                 % (name, bbox, hhea.ascent * s, hhea.descent * s, getattr(os2, "sCapHeight", 700) * s or 700, fontfile))

def make_cid_pdf(fontpath: Path, out: Path, tounicode: str, size=15.0):
    fontdata = load_font(fontpath); shaper = Shaper(fontdata)
    y = A4[1] - MARGIN; ops = []; used_all = []
    for line in LINES:
        o, used = layout_line(shaper, line, size, A4[0] - MARGIN, y, lambda gid: b"%04X" % gid)
        ops.append(o); used_all += used; y -= size * 2.1
    gids = sorted(set(g for g, _ in used_all))
    gid_text = {}
    for g, t in used_all: gid_text.setdefault(g, t)
    sub = subset_font(fontdata, gids, retain_gids=True)
    tt = TTFont(io.BytesIO(sub)); psname = ("WARRAQ+" + fontpath.stem.split("-")[0]).encode()
    w = PdfWriter()
    ff = w.add(PdfWriter.stream(b"/Length1 %d" % len(sub), sub))
    fd = font_descriptor(w, tt, psname, ff)
    widths = b" ".join(b"%d [%d]" % (g, shaper.width(g)) for g in gids)
    cid = w.add(b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /%s /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor %d 0 R /DW 1000 /W [%s] /CIDToGIDMap /Identity >>" % (psname, fd, widths))
    tu = b""
    if tounicode == "correct":
        tu_obj = w.add(PdfWriter.stream(b"", tounicode_cmap(gid_text))); tu = b" /ToUnicode %d 0 R" % tu_obj
    elif tounicode == "broken":
        tu_obj = w.add(PdfWriter.stream(b"", tounicode_cmap({g: "�" for g in gids}))); tu = b" /ToUnicode %d 0 R" % tu_obj
    f0 = w.add(b"<< /Type /Font /Subtype /Type0 /BaseFont /%s /Encoding /Identity-H /DescendantFonts [%d 0 R]%s >>" % (psname, cid, tu))
    content = w.add(PdfWriter.stream(b"", b"\n".join(ops)))
    pages = w.reserve()
    page = w.add(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>" % (pages, A4[0], A4[1], f0, content))
    w.set(pages, b"<< /Type /Pages /Kids [%d 0 R] /Count 1 >>" % page)
    info = w.add(b"<< /Title %s /Producer (Warraq corpus generator: gen_raw.py) /Creator (HarfBuzz %s) >>" % (pdf_text_string(T.SHORT_TITLE), hb.version_string().encode()))
    root = w.add(b"<< /Type /Catalog /Pages %d 0 R /Lang (ar) >>" % pages)
    out.write_bytes(w.build(root, info)); print("ok ", out.name, out.stat().st_size, "bytes")

def make_legacy_symbolic_pdf(fontpath: Path, out: Path, size=15.0):
    """Simple TrueType font, 1-byte codes assigned in order of first use, symbolic cmap (3,0)."""
    fontdata = load_font(fontpath); shaper = Shaper(fontdata)
    codes = {}
    def code_of(gid):
        if gid not in codes:
            if len(codes) >= 224: raise RuntimeError("too many glyphs for a 1-byte font")
            codes[gid] = 0x20 + len(codes)
        return b"%02X" % codes[gid]
    y = A4[1] - MARGIN; ops = []; used_all = []
    for line in LINES:
        o, used = layout_line(shaper, line, size, A4[0] - MARGIN, y, code_of); ops.append(o); used_all += used; y -= size * 2.1
    # build the symbolic font: subset (renumbered), then a (3,0) cmap 0xF000+code -> glyph
    # keep glyph ids (retain_gids) so the symbol cmap can address the original ids directly
    sub = subset_font(fontdata, list(codes), retain_gids=True, family_rename="WarraqLegacyTest")
    tt = TTFont(io.BytesIO(sub)); order = tt.getGlyphOrder()
    st = CmapSubtable.newSubtable(4); st.platformID = 3; st.platEncID = 0; st.language = 0
    st.cmap = {0xF000 + c: order[g] for g, c in codes.items()}
    tt["cmap"].tables = [st]
    buf = io.BytesIO(); tt.save(buf); sub = buf.getvalue(); tt = TTFont(io.BytesIO(sub))
    w = PdfWriter(); psname = b"WARRAQ+WarraqLegacyTest"
    ff = w.add(PdfWriter.stream(b"/Length1 %d" % len(sub), sub)); fd = font_descriptor(w, tt, psname, ff)
    first, last = 0x20, 0x20 + len(codes) - 1
    by_code = {c: g for g, c in codes.items()}
    widths = b" ".join(b"%d" % shaper.width(by_code[c]) for c in range(first, last + 1))
    f1 = w.add(b"<< /Type /Font /Subtype /TrueType /BaseFont /%s /FirstChar %d /LastChar %d /Widths [%s] /FontDescriptor %d 0 R >>" % (psname, first, last, widths, fd))
    content = w.add(PdfWriter.stream(b"", b"\n".join(ops))); pages = w.reserve()
    page = w.add(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>" % (pages, A4[0], A4[1], f1, content))
    w.set(pages, b"<< /Type /Pages /Kids [%d 0 R] /Count 1 >>" % page)
    info = w.add(b"<< /Title (Legacy symbolic Arabic font test) /Producer (Warraq corpus generator: gen_raw.py) >>")
    root = w.add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages)
    out.write_bytes(w.build(root, info)); print("ok ", out.name, out.stat().st_size, "bytes", f"({len(codes)} codes)")

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    make_cid_pdf(FONTS / "Amiri-Regular.ttf", OUT / "raw-amiri-cid-identity-tounicode.pdf", "correct")
    make_cid_pdf(FONTS / "Amiri-Regular.ttf", OUT / "raw-amiri-cid-no-tounicode.pdf", "none")
    make_cid_pdf(FONTS / "Cairo-Variable.ttf", OUT / "raw-cairo-cid-broken-tounicode.pdf", "broken")
    make_legacy_symbolic_pdf(FONTS / "Amiri-Regular.ttf", OUT / "raw-legacy-symbolic-truetype.pdf")
    for n in ("raw-amiri-cid-identity-tounicode", "raw-amiri-cid-no-tounicode", "raw-cairo-cid-broken-tounicode", "raw-legacy-symbolic-truetype"):
        (TRUTH / f"{n}.txt").write_text("\n".join(LINES) + "\n", encoding="utf-8")
