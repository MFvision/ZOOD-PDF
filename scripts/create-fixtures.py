#!/usr/bin/env python3
"""Test-only generator of Create PDF fixtures (tests/fixtures/create/).

Uses python-docx (MIT), openpyxl (MIT), python-pptx (MIT) and Pillow (MIT-CMU) — never shipped.
Every fixture has a `<name>.truth.txt` with the text a reader must produce in logical order
(list labels included, as drawn). Lines starting with "| " are table rows (cells separated by
" | "): the extractor may visit table cells column by column, so tests compare them as a set.
Deterministic: fixed timestamps, no randomness. Run: python3 scripts/create-fixtures.py
"""
import datetime
import io
import os
import zipfile

from docx import Document
from docx.enum.text import WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Inches
from openpyxl import Workbook
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.util import Inches as PInches, Pt as PPt

ROOT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "create")
FIXED = datetime.datetime(2026, 1, 1, 12, 0, 0)


def out(name):
    return os.path.join(ROOT, name)


def truth(name, lines):
    with open(out(name + ".truth.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def normalise_zip(path):
    """Rewrite a zip with fixed timestamps and sorted entries (deterministic bytes)."""
    with zipfile.ZipFile(path) as z:
        items = [(i.filename, z.read(i.filename)) for i in z.infolist()]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in items:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 12, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)


def logo_png():
    im = Image.new("RGBA", (120, 60), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((4, 4, 116, 56), radius=12, fill=(10, 132, 255, 255))
    d.rectangle((40, 20, 80, 40), fill=(255, 255, 255, 200))
    b = io.BytesIO()
    im.save(b, "PNG", dpi=(144, 144))
    return b.getvalue()


def rtl_paragraph(p, justify=False):
    ppr = p._p.get_or_add_pPr()
    bidi = OxmlElement("w:bidi")
    ppr.insert(0, bidi)
    if justify:
        jc = OxmlElement("w:jc")
        jc.set(qn("w:val"), "both")
        ppr.append(jc)


def rtl_run(r):
    rpr = r._r.get_or_add_rPr()
    rpr.append(OxmlElement("w:rtl"))


def docx_fixture():
    doc = Document()
    doc.core_properties.title = "تقرير زود"
    doc.core_properties.created = FIXED
    doc.core_properties.modified = FIXED
    lines = []

    h = doc.add_heading("تقرير الربع الأول", level=1)
    rtl_paragraph(h)
    lines.append("تقرير الربع الأول")

    body = ("كتب الفريق هذا التقرير لعرض نتائج العمل في الربع الأول من العام، "
            "وقد تحسنت النتائج تحسنا واضحا بفضل التعاون بين الأقسام المختلفة.")
    p = doc.add_paragraph()
    rtl_paragraph(p, justify=True)
    r = p.add_run(body)
    rtl_run(r)
    lines.append(body)

    p = doc.add_paragraph()
    rtl_paragraph(p)
    r1 = p.add_run("النتيجة ")
    rtl_run(r1)
    r2 = p.add_run("ممتازة")
    r2.bold = True
    rtl_run(r2)
    r3 = p.add_run(" في عام 2024 بنسبة 35%.")
    rtl_run(r3)
    lines.append("النتيجة ممتازة في عام 2024 بنسبة 35%.")

    en = "The English summary follows the Arabic text."
    doc.add_paragraph(en)
    lines.append(en)

    for item in ["البند الأول", "البند الثاني"]:
        li = doc.add_paragraph(item, style="List Number")
        rtl_paragraph(li)
    lines += ["١. البند الأول", "٢. البند الثاني"]
    for item in ["First bullet", "Second bullet"]:
        doc.add_paragraph(item, style="List Bullet")
        lines.append("• " + item)

    t = doc.add_table(rows=3, cols=3)
    t.style = "Table Grid"
    tblpr = t._tbl.tblPr
    tblpr.append(OxmlElement("w:bidiVisual"))
    data = [["المدينة", "City", "العدد"], ["الرياض", "Riyadh", "120"], ["جدة", "Jeddah", "80"]]
    for i, row in enumerate(data):
        for j, val in enumerate(row):
            cell = t.cell(i, j)
            cell.text = val
            if any("؀" <= ch <= "ۿ" for ch in val):
                rtl_paragraph(cell.paragraphs[0])
    lines.extend("| " + " | ".join(row) for row in data)

    pic = doc.add_paragraph()
    pic.add_run().add_picture(io.BytesIO(logo_png()), width=Inches(1.5))

    p = doc.add_paragraph()
    rtl_paragraph(p)
    r = p.add_run("نهاية الصفحة الأولى")
    rtl_run(r)
    r.add_break(WD_BREAK.PAGE)
    lines.append("نهاية الصفحة الأولى")
    p = doc.add_paragraph()
    rtl_paragraph(p)
    rtl_run(p.add_run("الصفحة الثانية"))
    lines.append("الصفحة الثانية")

    doc.save(out("report.docx"))
    normalise_zip(out("report.docx"))
    truth("report.docx", lines)


def xlsx_fixture():
    wb = Workbook()
    ws = wb.active
    ws.title = "المبيعات"
    ws.sheet_view.rightToLeft = True
    rows = [["المنتج", "الكمية", "السعر"], ["قلم", 12, 2.5], ["دفتر", 7, 10], ["المجموع", None, 100]]
    for r in rows:
        ws.append(r)
    ws.merge_cells("A4:B4")
    ws2 = wb.create_sheet("Summary")
    ws2.append(["Region", "Total"])
    ws2.append(["North", 1500])
    wb.properties.created = FIXED
    wb.properties.modified = FIXED
    wb.save(out("sales.xlsx"))
    normalise_zip(out("sales.xlsx"))
    truth("sales.xlsx", ["المبيعات", "| المنتج | الكمية | السعر", "| قلم | 12 | 2.5", "| دفتر | 7 | 10",
                         "| المجموع | 100", "Summary", "| Region | Total", "| North | 1500"])


def pptx_fixture():
    prs = Presentation()
    prs.core_properties.created = FIXED
    prs.core_properties.modified = FIXED
    s1 = prs.slides.add_slide(prs.slide_layouts[0])
    s1.shapes.title.text = "عرض زود"
    s1.placeholders[1].text = "مستندات عربية أولا"
    s2 = prs.slides.add_slide(prs.slide_layouts[5])
    s2.shapes.title.text = "Quarter results"
    tb = s2.shapes.add_textbox(PInches(1), PInches(2), PInches(5), PInches(1))
    tb.text_frame.text = "نمو المبيعات عشرين بالمئة"
    tb.text_frame.paragraphs[0].runs[0].font.size = PPt(24)
    s2.shapes.add_picture(io.BytesIO(logo_png()), PInches(7), PInches(2), width=PInches(2))
    prs.save(out("deck.pptx"))
    normalise_zip(out("deck.pptx"))
    truth("deck.pptx", ["عرض زود", "مستندات عربية أولا", "Quarter results", "نمو المبيعات عشرين بالمئة"])


def images():
    # JPEG photo with a JFIF density of 150 dpi.
    im = Image.new("RGB", (300, 200), (230, 240, 250))
    d = ImageDraw.Draw(im)
    d.ellipse((50, 30, 250, 170), fill=(255, 149, 0))
    im.save(out("photo.jpg"), "JPEG", quality=85, dpi=(150, 150))
    with open(out("logo.png"), "wb") as f:
        f.write(logo_png())
    # Multi-page TIFF: G4 bilevel (black square), LZW RGB, Deflate gray, 200 dpi.
    p1 = Image.new("1", (400, 300), 1)
    ImageDraw.Draw(p1).rectangle((100, 100, 300, 200), fill=0)
    p2 = Image.new("RGB", (400, 300), (255, 255, 255))
    ImageDraw.Draw(p2).rectangle((0, 0, 200, 150), fill=(255, 0, 0))
    p3 = Image.new("L", (400, 300), 255)
    ImageDraw.Draw(p3).rectangle((0, 150, 400, 300), fill=0)
    # Pillow applies one compression to all frames of save_all; append frame by frame instead.
    from PIL import TiffImagePlugin
    with TiffImagePlugin.AppendingTiffWriter(out("scan.tif"), True) as tf:
        for img, comp in [(p1, "group4"), (p2, "tiff_lzw"), (p3, "tiff_adobe_deflate")]:
            img.save(tf, dpi=(200, 200), compression=comp)
            tf.newFrame()


def text_fixtures():
    md = ("# دليل الاستخدام\n\nيدعم **زود** إنشاء ملفات PDF من *Markdown* مباشرة.\n\n"
          "## الخطوات\n\n1. افتح الأداة\n2. اختر الملفات\n3. اضغط إنشاء\n\n"
          "| العمود | القيمة |\n|---|---|\n| أ | ١٠ |\n| ب | ٢٠ |\n")
    with open(out("guide.md"), "w", encoding="utf-8") as f:
        f.write(md)
    truth("guide.md", ["دليل الاستخدام", "يدعم زود إنشاء ملفات PDF من Markdown مباشرة.", "الخطوات",
                       "١. افتح الأداة", "٢. اختر الملفات", "٣. اضغط إنشاء", "| العمود | القيمة", "| أ | ١٠",
                       "| ب | ٢٠"])
    html = ("<!doctype html><html dir=\"rtl\" lang=\"ar\"><head><title>t</title><style>p{}</style></head>"
            "<body><h1>صفحة ويب</h1><p>فقرة <b>مهمة</b> من الويب.</p><ul><li>عنصر</li></ul>"
            "<script>alert(1)</script></body></html>")
    with open(out("page.html"), "w", encoding="utf-8") as f:
        f.write(html)
    truth("page.html", ["صفحة ويب", "فقرة مهمة من الويب.", "• عنصر"])
    with open(out("data.csv"), "w", encoding="utf-8") as f:
        f.write("الاسم;المدينة;العمر\nعلي;الرياض;30\n\"سارة; أحمد\";جدة;25\n")
    truth("data.csv", ["| الاسم | المدينة | العمر", "| علي | الرياض | 30", "| سارة; أحمد | جدة | 25"])
    with open(out("notes.txt"), "w", encoding="utf-8") as f:
        f.write("ملاحظات الاجتماع\n\nناقش الفريق الخطة الجديدة.\nThe plan starts in March.\n")
    truth("notes.txt", ["ملاحظات الاجتماع", "ناقش الفريق الخطة الجديدة.", "The plan starts in March."])


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    docx_fixture()
    xlsx_fixture()
    pptx_fixture()
    images()
    text_fixtures()
    print("fixtures written to", os.path.abspath(ROOT))
