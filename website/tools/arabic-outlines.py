"""Turn the desk's sample Arabic lines into SVG outlines, so the Arabic page
looks the same before any web font loads. Run from the repository root:

    python3 -m pip install fonttools uharfbuzz
    python3 website/tools/arabic-outlines.py > website/js/desk-arabic.js

The text is invented sample content (see the `lines` below). The output is a
JS module exporting the paths and the box of the search word."""
import json, sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

FONT = 'tests/fonts/NotoNaskhArabic-Variable.ttf'
# The search word appears on line 1 with its diacritics; the find band lands on it.
LINES = [
    ('title', 'إشعار الفَاتُورَةُ التجريبية', 700),
    ('body', 'نرفق لكم الفَاتُورَةُ رقم ٠٠٠٠ عن خدمات شهر رمضان ١٤٤٧ هـ،', 400),
    ('body', 'ونأمل سدادها خلال ثلاثين يومًا من تاريخ هذا الإشعار.', 400),
    ('body', 'المبلغ المستحق: ٠٫٠٠ ر.س شاملًا ضريبة القيمة المضافة.', 400),
    ('body', ['رقم الآيبان: ', 'SA00 0000 0000 0000 0000 0000'], 400),
    ('body', 'هذا مستند تجريبي، وكل الأسماء والأرقام فيه وهمية.', 400),
]
WORD = 'الفَاتُورَةُ'


class CompactPen:
    """Relative, integer SVG path commands: about a third the size of SVGPathPen's."""
    def __init__(self):
        self.out = []
        self.cur = (0, 0)
    def _cmd(self, c, pts):
        # every point of a relative command is measured from where it starts
        x0, y0 = self.cur
        body = ''
        for p in pts:
            x, y = round(p[0]), round(p[1])
            t = f"{x - x0}" + (f"{y - y0}" if y - y0 < 0 else f" {y - y0}")
            body += t if (t.startswith('-') or not body) else ' ' + t
        self.cur = (round(pts[-1][0]), round(pts[-1][1]))
        self.out.append(c + body)
    def moveTo(self, p):
        x, y = round(p[0]), round(p[1])
        self.out.append(f"M{x} {y}")
        self.cur = (x, y)
        self.start = (x, y)
    def lineTo(self, p):
        self._cmd('l', [p])
    def qCurveTo(self, *pts):
        # expand implied on-curve points between consecutive off-curve points
        if pts[-1] is None:
            pts = pts[:-1]
        offs, on = pts[:-1], pts[-1]
        for i, o in enumerate(offs):
            if i < len(offs) - 1:
                n = offs[i + 1]
                mid = ((o[0] + n[0]) / 2, (o[1] + n[1]) / 2)
                self._cmd('q', [o, mid]); 
            else:
                self._cmd('q', [o, on])
    def curveTo(self, *pts):
        self._cmd('c', pts)
    def closePath(self):
        self.out.append('z')
        self.cur = self.start
    endPath = closePath
    def addComponent(self, *a):
        raise NotImplementedError
    def getCommands(self):
        return ''.join(self.out)

blob = hb.Blob.from_file_path(FONT)
face = hb.Face(blob)
tt = TTFont(FONT)
upem = tt['head'].unitsPerEm

def shape(text, wght):
    # HarfBuzz shapes the whole run right to left; a number inside Arabic reads
    # left to right (the bidi algorithm's job), so its digits go in reversed.
    import re
    text = re.sub(r'[\u0660-\u0669\u066B]+', lambda m: m.group()[::-1], text)
    font = hb.Font(face)
    font.set_variations({'wght': wght})
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, {})
    return font, buf

def outline(text, wght, size):
    font, buf = shape(text, wght)
    gs = tt.getGlyphSet(location={'wght': wght})
    names = tt.getGlyphOrder()
    scale = size / upem
    x = 0
    pen = CompactPen()
    word_box = None
    # the run is visual order (left to right); find the word's clusters
    start_char = text.find(WORD) if 'الفَاتُورَةُ' in text else -1
    lo = hi = None
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        g = names[info.codepoint]
        tp = TransformPen(pen, (scale, 0, 0, -scale, (x + pos.x_offset) * scale, -pos.y_offset * scale))
        from fontTools.pens.recordingPen import DecomposingRecordingPen
        rec = DecomposingRecordingPen(gs)
        gs[g].draw(rec)
        rec.replay(tp)
        if start_char >= 0 and start_char <= info.cluster < start_char + len(WORD):
            a, b = x * scale, (x + pos.x_advance) * scale
            lo = a if lo is None else min(lo, a)
            hi = b if hi is None else max(hi, b)
        x += pos.x_advance
    if lo is not None:
        word_box = [round(lo, 1), round(hi, 1)]
    return pen.getCommands(), round(x * scale, 1), word_box

def outline_line(text, wght, size):
    # A line is one run, or a list of runs from right to left (Arabic, then a
    # Latin run such as the IBAN), each shaped in its own direction.
    if isinstance(text, str):
        return outline(text, wght, size)
    parts = [outline(t, wght, size) for t in text]
    total = sum(p[1] for p in parts)
    d, x = '', total
    for cmds, w, _ in parts:
        x -= w
        d += shift(cmds, x)
    return d, round(total, 1), None

def shift(cmds, dx):
    import re
    # only the absolute M commands carry position; relative ones follow them
    return re.sub(r'M(-?\d+) ', lambda m: f"M{int(m.group(1)) + round(dx)} ", cmds)

out = []
for kind, text, wght in LINES:
    size = 110 if kind == 'title' else 75  # tenths of a px: integers stay exact
    d, w, box = outline_line(text, wght, size)
    import re
    out.append({'kind': kind, 'w': w, 'size': size, 'd': d, 'word': box})

sys.stdout.write('// Generated by website/tools/arabic-outlines.py. Invented sample text drawn as\n')
sys.stdout.write('// outlines (Noto Naskh Arabic, SIL OFL 1.1), so the page needs no web font.\n')
sys.stdout.write('export const ARABIC_LINES = ' + json.dumps(out, ensure_ascii=False) + ';\n')
