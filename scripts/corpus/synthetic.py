"""Synthetic producer-style PDFs (our own writer; honest labels in the manifest).

* synthetic Word-style: Identity-H CID fonts with ToUnicode, one TJ run (with kerning) per word,
  /ActualText per word, fake bold drawn twice, Tr 2 bold, Tr 3 hidden text, /Artifact footers.
* synthetic LibreOffice-style: one glyph per Tm in *logical* order (x decreasing), ToUnicode to
  Arabic presentation forms (incl. lam-alef ligatures), space glyphs, no ActualText.
* synthetic shaper-stream (Nastaliq / Amiri kerning): glyphs in shaper (visual) order with x/y
  offsets, ToUnicode per cluster, /ActualText only where a glyph is shared by several letters.
* synthetic simple fonts: standard-14 Helvetica with WinAnsi and TL/T*/'/"/Tw/Tc/Tz, an embedded
  symbolic TrueType Arabic subset whose text is only recoverable from /Differences glyph names,
  and text inside a form XObject.
"""
from __future__ import annotations

import io
import unicodedata

from fontTools import subset as ftsubset
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

import corpus_docs as D
from pdfwriter import CidFont, PdfDoc, ShapedFont, fmt, pdf_str_hex_utf16, visual_word_order

PAGE_W, PAGE_H = 595.276, 841.89
MARGIN = 72.0
RIGHT = PAGE_W - MARGIN
WIDTH = PAGE_W - 2 * MARGIN


def cluster_texts(text: str, glyphs) -> list[str]:
    """Text for each glyph: the widest glyph of a cluster (the base, not a zero-width dot or
    mark) gets the cluster's chars, the others get ""."""
    starts = sorted({g.cluster for g in glyphs})
    nxt = {c: (starts[i + 1] if i + 1 < len(starts) else len(text)) for i, c in enumerate(starts)}
    carrier = {}
    for k, g in enumerate(glyphs):
        best = carrier.get(g.cluster)
        if best is None or g.x_advance > glyphs[best].x_advance:
            carrier[g.cluster] = k
    return [text[g.cluster:nxt[g.cluster]] if carrier[g.cluster] == k else "" for k, g in enumerate(glyphs)]


def break_lines(sf: ShapedFont, text: str, size: float, width: float):
    words = text.split(" ")
    space = sf.shape(" ", size)[0].x_advance
    shaped = []
    for w in words:
        gl = sf.shape(w, size)
        shaped.append((w, gl, sum(g.x_advance for g in gl)))
    lines, cur, cur_w = [], [], 0.0
    for item in shaped:
        add = item[2] + (space if cur else 0.0)
        if cur and cur_w + add > width:
            lines.append(cur)
            cur, cur_w = [], 0.0
            add = item[2]
        cur.append(item)
        cur_w += add
    if cur:
        lines.append(cur)
    return lines, space


# ------------------------------------------------------------------------------------------
# Word-style


def word_tj(font: CidFont, glyphs, size: float, x: float, y: float) -> str:
    """Emit glyphs of one word: Tm + TJ with kerning; glyphs with offsets get their own Tm."""
    parts = []
    pen = x
    cur: list[str] = []
    cur_start = None

    def flush():
        nonlocal cur, cur_start
        if cur:
            parts.append(f"1 0 0 1 {fmt(cur_start)} {fmt(y)} Tm [{' '.join(cur)}] TJ")
        cur, cur_start = [], None

    for g in glyphs:
        if abs(g.x_offset) > 0.01 or abs(g.y_offset) > 0.01:
            flush()
            parts.append(f"1 0 0 1 {fmt(pen + g.x_offset)} {fmt(y + g.y_offset)} Tm <{g.gid:04X}> Tj")
            pen += g.x_advance
            continue
        if cur_start is None:
            cur_start = pen
        cur.append(f"<{g.gid:04X}>")
        natural = font.sf.advance_1000(g.gid) * size / 1000
        adj = -(g.x_advance - natural) * 1000 / size
        if abs(adj) > 0.5:
            cur.append(fmt(adj))
        pen += g.x_advance
    flush()
    return "\n".join(parts)


def emit_rtl_lines(font: CidFont, res: str, text: str, size: float, y: float, leading: float,
                   justify=True, actual_text=True, spaces=False, extra_ops="", align="right"):
    lines, space = break_lines(font.sf, text, size, WIDTH)
    out = []
    for li, line in enumerate(lines):
        last = li == len(lines) - 1
        n = len(line)
        total = sum(w[2] for w in line) + space * (n - 1)
        extra = (WIDTH - total) / (n - 1) if (justify and not last and n > 1) else 0.0
        full = total + extra * max(n - 1, 0)
        x = RIGHT - full if align == "right" else MARGIN + (WIDTH - full) / 2
        order = visual_word_order([w[0] for w in line])
        out.append(f"BT /{res} {fmt(size)} Tf {extra_ops}")
        for k, idx in enumerate(order):
            word, glyphs, ww = line[idx]
            conflict = False
            for g, t in zip(glyphs, cluster_texts(word, glyphs)):
                conflict |= not font.map_glyph(g.gid, t)
            # Like Word: ActualText per word (always, or only where ToUnicode cannot express it).
            wrap = actual_text or conflict
            if wrap:
                out.append(f"/Span <</ActualText {pdf_str_hex_utf16(word)}>> BDC")
            out.append(word_tj(font, glyphs, size, x, y))
            if wrap:
                out.append("EMC")
            x += ww
            if k + 1 < len(order):
                if spaces:
                    sg = font.sf.shape(" ", size)[0]
                    font.map_glyph(sg.gid, " ")
                    out.append(f"1 0 0 1 {fmt(x)} {fmt(y)} Tm <{sg.gid:04X}> Tj")
                x += space + extra
        out.append("ET")
        y -= leading
    return "\n".join(out), y


def synthetic_word(fonts: dict, path: str) -> tuple[str, list[str]]:
    doc = PdfDoc("ZOOD corpus synthetic Word-style writer")
    reg = CidFont(ShapedFont(fonts["naskh400"]), "WRDAAA", "NotoNaskhArabic-Regular")
    bold = CidFont(ShapedFont(fonts["naskh700"]), "WRDAAB", "NotoNaskhArabic-Bold")
    amiri = CidFont(ShapedFont(fonts["amiri"]), "WRDAAC", "Amiri-Regular")
    truth = []
    # ---- page 1
    c = ["0 0 0 rg 0 0 0 RG"]
    y = PAGE_H - MARGIN
    # heading: fake bold drawn twice (fill, then stroke with a small offset)
    for pass_ops, dx in (("0 Tr", 0.0), ("1 Tr 0.3 w", 0.25)):
        lines, _ = break_lines(reg.sf, D.WORD_HEADING, 18, WIDTH)
        ww = sum(w[2] for w in lines[0]) + reg.sf.shape(" ", 18)[0].x_advance * (len(lines[0]) - 1)
        txt, _ = emit_rtl_lines(reg, "F1", D.WORD_HEADING, 18, y, 28, justify=False, extra_ops=pass_ops)
        # shift the second pass slightly: rewrite Tm x
        if dx:
            txt = shift_tm(txt, dx)
        c.append(txt)
        del ww
    truth.append(D.WORD_HEADING)
    y -= 40
    for p in D.WORD_PARAGRAPHS:
        txt, y = emit_rtl_lines(reg, "F1", p, 12, y, 20)
        c.append(txt)
        truth.append(p)
        y -= 10
    # real bold font
    txt, y = emit_rtl_lines(bold, "F2", D.WORD_BOLD_LINE, 13, y, 22, justify=False)
    c.append(txt)
    truth.append(D.WORD_BOLD_LINE)
    y -= 8
    # fill+stroke single draw (Tr 2)
    txt, y = emit_rtl_lines(reg, "F1", "التسجيل مفتوح حتى نهاية الشهر", 13, y, 22, justify=False, extra_ops="2 Tr 0.4 w")
    c.append(txt)
    truth.append("التسجيل مفتوح حتى نهاية الشهر")
    y -= 8
    # invisible text (Tr 3) still extracted
    txt, y = emit_rtl_lines(reg, "F1", D.WORD_HIDDEN_LINE, 10, y, 18, justify=False, extra_ops="3 Tr")
    c.append(txt)
    truth.append(D.WORD_HIDDEN_LINE)
    # footer artifact
    txt, _ = emit_rtl_lines(reg, "F1", D.WORD_FOOTER, 9, 40, 12, justify=False, align="center")
    c.append("/Artifact <</Type /Pagination /Subtype /Footer>> BDC\n" + txt + "\nEMC")
    truth.append(D.WORD_FOOTER)
    content1 = "\n".join(c).encode("latin-1")
    # ---- page 2 (space glyphs, no ActualText)
    c = ["0 0 0 rg"]
    y = PAGE_H - MARGIN
    truth2 = []
    for p in D.WORD_PAGE2:
        txt, y = emit_rtl_lines(amiri, "F3", p, 13, y, 24, spaces=True, actual_text=False)
        c.append(txt)
        truth2.append(p)
        y -= 10
    txt, _ = emit_rtl_lines(reg, "F1", D.WORD_FOOTER2, 9, 40, 12, justify=False, align="center")
    c.append("/Artifact <</Type /Pagination /Subtype /Footer>> BDC\n" + txt + "\nEMC")
    truth2.append(D.WORD_FOOTER2)
    content2 = "\n".join(c).encode("latin-1")
    f1 = reg.embed(doc)
    f2 = bold.embed(doc)
    f3 = amiri.embed(doc)
    res = f"<< /Font << /F1 {f1} 0 R /F2 {f2} 0 R /F3 {f3} 0 R >> >>"
    doc.add_page(content1, res)
    doc.add_page(content2, res)
    doc.write(path, D.WORD_HEADING)
    return "\n".join(truth) + "\n\n" + "\n".join(truth2) + "\n", ["ar"]


def shift_tm(txt: str, dx: float) -> str:
    out = []
    for line in txt.split("\n"):
        if line.startswith("1 0 0 1 ") and " Tm " in line:
            parts = line.split(" ")
            parts[4] = fmt(float(parts[4]) + dx)
            line = " ".join(parts)
        out.append(line)
    return "\n".join(out)


# ------------------------------------------------------------------------------------------
# LibreOffice-style: presentation forms, logical glyph order

RIGHT_JOINING = set("اأإآٱدذرزوؤة")
NON_JOINING = set("ء")


def is_arabic_letter(c: str) -> bool:
    return 0x0620 <= ord(c) <= 0x064A or ord(c) in (0x0671, 0x067E, 0x0686, 0x0698, 0x06A9, 0x06AF, 0x06CC)


def joins_next(c: str) -> bool:
    return is_arabic_letter(c) and c not in RIGHT_JOINING and c not in NON_JOINING


def joins_prev(c: str) -> bool:
    return is_arabic_letter(c) and c not in NON_JOINING


def presentation_forms(word: str) -> list[str]:
    """Presentation-form text per logical char (lam-alef → one ligature char on the lam, "" on alef)."""
    out = []
    chars = list(word)
    i = 0
    while i < len(chars):
        c = chars[i]
        prev = chars[i - 1] if i > 0 else ""
        nxt = chars[i + 1] if i + 1 < len(chars) else ""
        pj = bool(prev) and joins_next(prev) and joins_prev(c)
        if c == "ل" and nxt in "اأإآ" and nxt:
            base = {"ا": "ALEF", "أ": "ALEF WITH HAMZA ABOVE", "إ": "ALEF WITH HAMZA BELOW", "آ": "ALEF WITH MADDA ABOVE"}[nxt]
            form = "FINAL" if pj else "ISOLATED"
            out.append(unicodedata.lookup(f"ARABIC LIGATURE LAM WITH {base} {form} FORM"))
            out.append("")
            i += 2
            continue
        nj = bool(nxt) and joins_next(c) and joins_prev(nxt)
        if not is_arabic_letter(c):
            out.append(c)
        else:
            form = {(False, False): "ISOLATED", (False, True): "INITIAL", (True, True): "MEDIAL", (True, False): "FINAL"}[(pj, nj)]
            name = unicodedata.name(c)
            try:
                out.append(unicodedata.lookup(f"{name} {form} FORM"))
            except KeyError:
                try:
                    out.append(unicodedata.lookup(f"{name} {'FINAL' if pj else 'ISOLATED'} FORM"))
                except KeyError:
                    out.append(c)
        i += 1
    return out


def synthetic_libreoffice(fonts: dict, path: str) -> tuple[str, list[str]]:
    doc = PdfDoc("ZOOD corpus synthetic LibreOffice-style writer")
    f = CidFont(ShapedFont(fonts["amiri"]), "LIBAAA", "Amiri-Regular")
    sf = f.sf
    c = ["0 0 0 rg"]
    y = PAGE_H - MARGIN
    truth = []
    size, leading = 13, 24
    for p in D.LIBRE_PARAGRAPHS:
        lines, space = break_lines(sf, p, size, WIDTH)
        for line in lines:
            # place words right to left in logical order; glyphs emitted in logical order
            x_right = RIGHT
            c.append(f"BT /F1 {size} Tf")
            for word, glyphs, ww in line:
                x0 = x_right - ww
                # visual pen positions
                pos = []
                pen = x0
                for g in glyphs:
                    pos.append(pen + g.x_offset)
                    pen += g.x_advance
                pres = presentation_forms(word)
                texts = cluster_texts(word, glyphs)
                # presentation text per glyph: map cluster → pres chars of its logical chars
                starts = sorted({g.cluster for g in glyphs})
                nxt = {cl: (starts[i + 1] if i + 1 < len(starts) else len(word)) for i, cl in enumerate(starts)}
                seen = set()
                items = []
                for g, px, t in zip(glyphs, pos, texts):
                    if g.cluster in seen or not t:
                        ptxt = ""
                    else:
                        seen.add(g.cluster)
                        ptxt = "".join(pres[g.cluster:nxt[g.cluster]])
                    f.map_glyph(g.gid, ptxt)
                    items.append((g.cluster, px, g))
                items.sort(key=lambda it: (it[0], -it[1]))
                for _, px, g in items:
                    c.append(f"1 0 0 1 {fmt(px)} {fmt(y + g.y_offset)} Tm <{g.gid:04X}> Tj")
                x_right = x0 - space
                sg = sf.shape(" ", size)[0]
                f.map_glyph(sg.gid, " ")
                c.append(f"1 0 0 1 {fmt(x_right)} {fmt(y)} Tm <{sg.gid:04X}> Tj")
            c.append("ET")
            y -= leading
        truth.append(p)
        y -= 12
    fid = f.embed(doc)
    doc.add_page("\n".join(c).encode("latin-1"), f"<< /Font << /F1 {fid} 0 R >> >>")
    doc.write(path, "LibreOffice-style")
    return "\n".join(truth) + "\n", ["ar"]


# ------------------------------------------------------------------------------------------
# Shaper stream (Nastaliq / Amiri kerning)


def synthetic_shaper_stream(font_path: str, paragraphs: list[str], path: str, size: float, leading: float,
                            tag: str, name: str, lang: str) -> tuple[str, list[str]]:
    doc = PdfDoc("ZOOD corpus synthetic shaper-stream writer")
    f = CidFont(ShapedFont(font_path), tag, name)
    sf = f.sf
    c = ["0 0 0 rg"]
    y = PAGE_H - MARGIN - size
    for p in paragraphs:
        glyphs = sf.shape(p, size)
        width = sum(g.x_advance for g in glyphs)
        x = RIGHT - width
        texts = cluster_texts(p, glyphs)
        # group glyphs per cluster to detect ToUnicode conflicts
        conflict_clusters = set()
        for g, t in zip(glyphs, texts):
            if not f.map_glyph(g.gid, t):
                conflict_clusters.add(g.cluster)
        c.append(f"BT /F1 {fmt(size)} Tf")
        pen = x
        open_cluster = None
        for g, t in zip(glyphs, texts):
            if open_cluster is not None and g.cluster != open_cluster:
                c.append("EMC")
                open_cluster = None
            if g.cluster in conflict_clusters and open_cluster is None:
                starts = sorted({gg.cluster for gg in glyphs})
                i = starts.index(g.cluster)
                end = starts[i + 1] if i + 1 < len(starts) else len(p)
                c.append(f"/Span <</ActualText {pdf_str_hex_utf16(p[g.cluster:end])}>> BDC")
                open_cluster = g.cluster
            c.append(f"1 0 0 1 {fmt(pen + g.x_offset)} {fmt(y + g.y_offset)} Tm <{g.gid:04X}> Tj")
            pen += g.x_advance
        if open_cluster is not None:
            c.append("EMC")
        c.append("ET")
        y -= leading
    fid = f.embed(doc)
    doc.add_page("\n".join(c).encode("latin-1"), f"<< /Font << /F1 {fid} 0 R >> >>")
    doc.write(path, name, lang)
    return "\n".join(paragraphs) + "\n", [lang]


# ------------------------------------------------------------------------------------------
# Simple fonts

ARABIC_NAMES = {"م": "meem", "ر": "reh", "ح": "hah", "ب": "beh", "ا": "alef", "ك": "kaf", "ف": "feh",
                "ي": "yeh", "ز": "zain", "و": "waw", "د": "dal"}
AFII = {"م": "afii57445", "ر": "afii57425", "ب": "afii57416", "ا": "afii57415", "ك": "afii57443",
        "ي": "afii57450", "و": "afii57448", "د": "afii57423"}


def synthetic_simple_fonts(fonts: dict, path: str) -> tuple[str, list[str]]:
    doc = PdfDoc("ZOOD corpus synthetic simple-font writer")
    sf = ShapedFont(fonts["amiri"])
    size = 16
    text = D.SIMPLE_FONT_ARABIC
    words = text.split(" ")
    # codes for every distinct (gid) in shaped words; glyph names from the cluster char + form
    code_of: dict[int, int] = {}
    names: dict[int, str] = {}
    widths: dict[int, float] = {}
    shaped_words = []
    scheme = 0
    for w in words:
        gl = sf.shape(w, size)
        texts = cluster_texts(w, gl)
        forms = presentation_forms(w)
        for g, t in zip(gl, texts):
            if g.gid in code_of:
                continue
            code = len(code_of) + 1
            code_of[g.gid] = code
            ch = t[:1]
            form_char = forms[g.cluster] if g.cluster < len(forms) else ch
            form = unicodedata.name(form_char, "").split(" ")[-2].lower() if form_char and form_char != ch else "isol"
            suffix = {"initial": "init", "medial": "medi", "final": "fina", "isolated": "isol"}.get(form, "isol")
            if not ch:
                names[code] = f"g{g.gid}"
            elif scheme % 3 == 0:
                names[code] = f"uni{ord(ch):04X}.{suffix}"
            elif scheme % 3 == 1 and ch in AFII:
                names[code] = AFII[ch]
            else:
                names[code] = f"{ARABIC_NAMES.get(ch, 'uni%04X' % ord(ch))}-ar.{suffix}"
            scheme += 1
            widths[code] = sf.advance_1000(g.gid)
        shaped_words.append((w, gl))
    # embed a subset with a (3,0) symbol cmap: code c → 0xF000 + c
    tt = TTFont(io.BytesIO(sf.data), recalcTimestamp=False)
    order = tt.getGlyphOrder()
    keep = [order[g] for g in code_of]
    opts = ftsubset.Options()
    opts.layout_features = []
    opts.notdef_outline = True
    opts.name_IDs = []
    opts.drop_tables += ["GSUB", "GPOS", "GDEF"]
    sub = ftsubset.Subsetter(opts)
    sub.populate(glyphs=keep)
    sub.subset(tt)
    cm = CmapSubtable.newSubtable(4)
    cm.platformID, cm.platEncID, cm.language = 3, 0, 0
    cm.cmap = {0xF000 + code: order[g] for g, code in code_of.items()}
    tt["cmap"].tables = [cm]
    buf = io.BytesIO()
    tt.save(buf)
    data = buf.getvalue()
    ff = doc.stream(f"/Length1 {len(data)}", data)
    fd = doc.add(f"<< /Type /FontDescriptor /FontName /SIMAAA+Amiri /Flags 4 /FontBBox [-500 -700 1500 1200] "
                 f"/ItalicAngle 0 /Ascent 1100 /Descent -600 /CapHeight 700 /StemV 80 /FontFile2 {ff} 0 R >>")
    n = len(code_of)
    diffs = " ".join(f"/{names[c]}" for c in range(1, n + 1))
    wlist = " ".join(fmt(widths[c]) for c in range(1, n + 1))
    f_ar = doc.add(f"<< /Type /Font /Subtype /TrueType /BaseFont /SIMAAA+Amiri /FirstChar 1 /LastChar {n} "
                   f"/Widths [{wlist}] /FontDescriptor {fd} 0 R /Encoding << /Type /Encoding /Differences [1 {diffs}] >> >>")
    f_hel = doc.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    # form xobject with text
    form = doc.stream(f"/Type /XObject /Subtype /Form /BBox [0 0 400 40] /Matrix [1 0 0 1 72 120] "
                      f"/Resources << /Font << /F2 {f_hel} 0 R >> >>",
                      f"BT /F2 12 Tf 0 10 Td ({D.FORM_XOBJECT_TEXT}) Tj ET".encode("latin-1"))
    c = ["0 0 0 rg"]
    # Arabic line, right aligned, one Tj per word in visual order
    y = PAGE_H - MARGIN - 20
    space = sf.shape(" ", size)[0].x_advance
    widths_w = [sum(g.x_advance for g in gl) for _, gl in shaped_words]
    total = sum(widths_w) + space * (len(words) - 1)
    x = RIGHT - total
    c.append(f"BT /F1 {size} Tf")
    for idx in visual_word_order(words):
        w, gl = shaped_words[idx]
        codes = "".join(f"{code_of[g.gid]:02X}" for g in gl)
        c.append(f"1 0 0 1 {fmt(x)} {fmt(y)} Tm <{codes}> Tj")
        x += widths_w[idx] + space
    c.append("ET")
    # English with text-state operators
    e = D.SIMPLE_FONT_ENGLISH
    c.append(f"BT /F2 12 Tf 16 TL 72 680 Td ({e[0]}) Tj T* ({e[1]}) Tj ({e[2]}) ' "
             f"90 Tz 0.2 Tc 3 0.5 ({e[3]}) \" 100 Tz 0 Tc 0 Tw ET")
    c.append("q /X1 Do Q")
    res = f"<< /Font << /F1 {f_ar} 0 R /F2 {f_hel} 0 R >> /XObject << /X1 {form} 0 R >> >>"
    doc.add_page("\n".join(c).encode("latin-1"), res)
    doc.write(path, "Simple fonts", "ar")
    truth = [text] + e + [D.FORM_XOBJECT_TEXT]
    return "\n".join(truth) + "\n", ["ar", "en"]
