"""Look-alike test files for the conversion checks (tests/corpus/convert).

Every name, ID, phone, e-mail, salary and address here is made up. They
stand in for the files of the 28 Oct 2026 test on the owner's PC and carry
what went wrong there: an Arabic letter in Arial with a date range, an
invoice number and "(FCFS)" in runs Word lays out left to right, ballot
boxes in Segoe UI Symbol and Wingdings; an employee sheet with a navy
header, long e-mails, IDs and phones with leading zeros and amounts in SR;
a slide with the same strings.

    python3 make_convert_fixtures.py   (python-docx, openpyxl, python-pptx)
"""
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from pptx import Presentation
from pptx.util import Pt as PPt, Inches

HERE = __file__.rsplit("/", 1)[0] if "/" in __file__ else "."


def set_fonts(run, latin, cs=None):
    rpr = run._r.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    fonts.set(qn("w:ascii"), latin)
    fonts.set(qn("w:hAnsi"), latin)
    fonts.set(qn("w:cs"), cs or latin)


def rtl_run(run):
    rpr = run._r.get_or_add_rPr()
    rpr.append(OxmlElement("w:rtl"))


def bidi(paragraph):
    ppr = paragraph._p.get_or_add_pPr()
    ppr.append(OxmlElement("w:bidi"))


def add(paragraph, text, *, rtl=True, font="Arial", size=12, bold=False):
    run = paragraph.add_run(text)
    set_fonts(run, font)
    run.font.size = Pt(size)
    rpr = run._r.get_or_add_rPr()
    szcs = OxmlElement("w:szCs")
    szcs.set(qn("w:val"), str(size * 2))
    rpr.append(szcs)
    if bold:
        run.bold = True
    if rtl:
        rtl_run(run)
    return run


def sym(paragraph, font, char):
    run = paragraph.add_run()
    s = OxmlElement("w:sym")
    s.set(qn("w:font"), font)
    s.set(qn("w:char"), char)
    run._r.append(s)


def letter():
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Pt(595.3), Pt(841.9)
    for side in ("top_margin", "bottom_margin", "left_margin", "right_margin"):
        setattr(section, side, Pt(56.7))
    lines = [
        [("شركة الأفق للتطوير العقاري", True, 16, True)],
        [("التاريخ: ", True, 12, False), ("27/01/2026", False, 12, False)],
        [("رقم الفاتورة: ", True, 12, False), ("INV-C01136/2026", False, 12, False)],
        [("السادة / مؤسسة النخيل للخدمات المحترمين", True, 12, True)],
        [("السلام عليكم ورحمة الله وبركاته، وبعد:", True, 12, False)],
        [
            ("نفيدكم بأن مدة العقد للفترة ", True, 12, False),
            ("(27/01/2026 - 27/01/2027)", False, 12, False),
            (" وتكون الأولوية للحجز حسب ", True, 12, False),
            ("(FCFS)", False, 12, False),
            (" وبقيمة إجمالية قدرها ", True, 12, False),
            ("45,250.00", False, 12, False),
            (" ريال سعودي شاملة ضريبة القيمة المضافة ", True, 12, False),
            ("(15%)", True, 12, False),
            (".", True, 12, False),
        ],
        [("يرجى التكرم بالاطلاع والإفادة بما يلزم حيال ما يلي:", True, 12, False)],
    ]
    for parts in lines:
        p = doc.add_paragraph()
        bidi(p)
        for text, rtl, size, bold in parts:
            add(p, text, rtl=rtl, size=size, bold=bold)
    for item, wingdings in (("الموافقة على العرض", False), ("طلب تعديل البنود", True), ("رفض العرض", False)):
        p = doc.add_paragraph()
        bidi(p)
        if wingdings:
            sym(p, "Wingdings", "F0A8")
        else:
            box = add(p, "☐", rtl=False, font="Segoe UI Symbol")
        add(p, " " + item)
    p = doc.add_paragraph()
    bidi(p)
    add(p, "للتواصل: ", size=11)
    add(p, "+966 50 525 7674", rtl=False, size=11)
    add(p, " – ", size=11)
    add(p, "info@example.com", rtl=False, size=11)
    p = doc.add_paragraph()
    bidi(p)
    add(p, "مدير إدارة الأملاك", bold=True)
    p = doc.add_paragraph()
    bidi(p)
    add(p, "سالم بن ناصر الغامدي")
    doc.save(f"{HERE}/letter-ar.docx")


EMPLOYEES = [
    ("000123", "Ahmed Saleh Al-Harbi", "ahmed.alharbi@example-realty.sa", "0505257674", "HEAD OFFICE - RIYADH", 12500.0),
    ("000124", "Sara Nasser Al-Qahtani", "sara.alqahtani@example-realty.sa", "0551234567", "BRANCH OFFICE - JEDDAH", 9800.5),
    ("000131", "Mohammed Fahad Al-Otaibi", "mohammed.alotaibi@example-realty.sa", "0539876543", "HEAD OFFICE - RIYADH", 15200.0),
    ("000207", "Noura Abdullah Al-Shehri", "noura.alshehri@example-realty.sa", "0567654321", "SALES OFFICE - DAMMAM", 8750.0),
    ("000318", "خالد عبدالرحمن الدوسري", "khalid.aldossari@example-realty.sa", "0501112233", "المكتب الرئيسي - الرياض", 11300.75),
    ("000402", "Reem Turki Al-Mutairi", "reem.almutairi@example-realty.sa", "0544455566", "OPERATIONS OFFICE - KHOBAR", 10100.0),
]


def employees():
    wb = Workbook()
    ws = wb.active
    ws.title = "Employees"
    header = ["Employee ID", "Employee Name", "Email Address", "Mobile", "Office", "Salary"]
    ws.append(header)
    navy = PatternFill("solid", fgColor="1F3864")
    for cell in ws[1]:
        cell.fill = navy
        cell.font = Font(bold=True, color="FFFFFF", name="Calibri", size=11)
        cell.alignment = Alignment(horizontal="center")
    for row in EMPLOYEES * 4:
        ws.append(list(row))
    for r in range(2, ws.max_row + 1):
        ws.cell(r, 1).number_format = "@"
        ws.cell(r, 4).number_format = "@"
        ws.cell(r, 6).number_format = '#,##0.00 "SR"'
    for col, width in zip("ABCDEF", (12, 26, 34, 12, 22, 12)):
        ws.column_dimensions[col].width = width
    wb.save(f"{HERE}/employees.xlsx")


def slides():
    deck = Presentation()
    deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)
    slide = deck.slides.add_slide(deck.slide_layouts[6])
    box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(11), Inches(4))
    frame = box.text_frame
    for k, text in enumerate([
        "فاتورة ضريبية رقم INV-C01136/2026",
        "مدة العقد (27/01/2026 - 27/01/2027)",
        "الأولوية (FCFS) للحجز",
        "الإجمالي 52.17 SR",
    ]):
        p = frame.paragraphs[0] if k == 0 else frame.add_paragraph()
        p.text = text
        p.font.size = PPt(28)
        p.font.name = "Arial"
        p._p.get_or_add_pPr().set("rtl", "1")
    deck.save(f"{HERE}/report-ar.pptx")


if __name__ == "__main__":
    letter()
    employees()
    slides()
