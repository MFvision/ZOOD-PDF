"""Fixtures for Create PDF: Arabic files of every kind Create reads.

Word, Excel and PowerPoint files are written by hand as their XML parts in
a zip — no Office library — so each one holds exactly what the readers are
tested on: runs, lists, tables with merged and shaded cells, pictures,
sections, headers and footers with page fields; sheets with number formats,
merged cells and a right-to-left view; slides with placeholders that take
their place from the layout, theme colours, bullets, a picture and a table.
The pictures are made with Pillow; everything else is the standard library.

Run from the repository root:  python3 tests/fixtures/create/make_fixtures.py
The output is committed, so the tests never need Python.
"""
import base64
import io
import os
import zipfile

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
PIC = 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'


def png(width, height, colour, text=None):
    image = Image.new("RGB", (width, height), colour)
    if text:
        ImageDraw.Draw(image).text((8, height // 2 - 6), text, fill=(255, 255, 255))
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def write_zip(name, parts):
    path = os.path.join(HERE, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for part, data in parts.items():
            info = zipfile.ZipInfo(part, date_time=(2026, 9, 19, 12, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data if isinstance(data, bytes) else data.encode("utf-8"))
    print("wrote", name)


def rels(entries):
    external_mode = ' TargetMode="External"'
    body = "".join(
        f'<Relationship Id="{i}" Type="{REL}/{t}" Target="{target}"{external_mode if external else ""}/>'
        for i, t, target, external in entries
    )
    return f'{DECL}<Relationships xmlns="{PKG}">{body}</Relationships>'


# ---- Word ---------------------------------------------------------------------------------

def run(text, bold=False, italic=False, underline=False, colour=None, rtl=True):
    props = ""
    if bold:
        props += "<w:b/><w:bCs/>"
    if italic:
        props += "<w:i/><w:iCs/>"
    if underline:
        props += '<w:u w:val="single"/>'
    if colour:
        props += f'<w:color w:val="{colour}"/>'
    if rtl:
        props += "<w:rtl/>"
    return f'<w:r><w:rPr>{props}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>'


def para(runs, style=None, align=None, bidi=True, numbered=None, shade=None, section=None):
    ppr = ""
    if style:
        ppr += f'<w:pStyle w:val="{style}"/>'
    if numbered is not None:
        ppr += f'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{numbered}"/></w:numPr>'
    if shade:
        ppr += f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>'
    if bidi:
        ppr += "<w:bidi/>"
    if align:
        ppr += f'<w:jc w:val="{align}"/>'
    if section:
        ppr += section
    return f"<w:p><w:pPr>{ppr}</w:pPr>{''.join(runs)}</w:p>"


def cell(text, width, span=1, fill=None, bold=False):
    tcpr = f'<w:tcW w:w="{width}" w:type="dxa"/>'
    if span > 1:
        tcpr += f'<w:gridSpan w:val="{span}"/>'
    if fill:
        tcpr += f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>'
    return f"<w:tc><w:tcPr>{tcpr}</w:tcPr>{para([run(text, bold=bold)])}</w:tc>"


def make_docx():
    picture = png(160, 80, (30, 90, 170), "Warraq")
    field = lambda code: (
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        f'<w:r><w:instrText xml:space="preserve"> {code} </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        '<w:r><w:t>1</w:t></w:r>'
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    )
    drawing = (
        '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        '<wp:extent cx="1828800" cy="914400"/><wp:docPr id="1" name="شعار"/>'
        f'<a:graphic {A}><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f'<pic:pic {PIC}><pic:nvPicPr><pic:cNvPr id="1" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
    )
    landscape = (
        '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/>'
        '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>'
    )
    body = "".join([
        para([run("التقرير السنوي لمكتبة ورّاق")], style="Title", align="center"),
        para([run("مقدمة")], style="Heading1"),
        para([
            run("هذا تقرير "),
            run("عريض", bold=True),
            run(" و"),
            run("مائل", italic=True),
            run(" و"),
            run("تحته خط", underline=True),
            run(" و"),
            run("ملوّن", colour="C00000"),
            run(" مع "),
            f'<w:hyperlink r:id="rIdLink">{run("رابط إلى الموقع", colour="0563C1", underline=True)}</w:hyperlink>',
            run("."),
        ], align="both"),
        para([run("فقرة مظللة للتنبيه.")], shade="FFF2CC"),
        para([run("البند الأول")], numbered=1),
        para([run("البند الثاني")], numbered=1),
        para([run("نقطة أولى")], numbered=2),
        para([run("The annual report also has an English paragraph.", rtl=False)], bidi=False),
        para([run("جدول المبيعات")], style="Heading2"),
        '<w:tbl><w:tblPr><w:bidiVisual/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
        '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>'
        f'<w:tr><w:trPr><w:tblHeader/></w:trPr>{cell("الصنف", 3000, fill="D9E2F3", bold=True)}{cell("الكمية", 2000, fill="D9E2F3", bold=True)}{cell("السعر", 2000, fill="D9E2F3", bold=True)}</w:tr>'
        f'<w:tr>{cell("ورق", 3000)}{cell("١٢", 2000)}{cell("3.50", 2000)}</w:tr>'
        f'<w:tr>{cell("المجموع", 5000, span=2)}{cell("42.00", 2000)}</w:tr>'
        "</w:tbl>",
        para([drawing], align="center"),
        para([run("بعد الصورة، نهاية القسم الأول.")], section=landscape),
        para([run("القسم الثاني بصفحة عرضية")], style="Heading1"),
        para([run("هذه الصفحة عرضية لأن قسمها كذلك.")]),
    ])
    final = (
        '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/>'
        '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1134" w:right="1440" w:bottom="1134" w:left="1440" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>'
    )
    document = f"{DECL}<w:document {W} {R} {WP}><w:body>{body}{final}</w:body></w:document>"
    header = f"{DECL}<w:hdr {W} {R}>{para([run('مكتبة ورّاق — تقرير داخلي')], align='center')}</w:hdr>"
    footer = f"{DECL}<w:ftr {W} {R}>{para([run('صفحة '), field('PAGE'), run(' من '), field('NUMPAGES')], align='center')}</w:ftr>"
    styles = (
        f'{DECL}<w:styles {W}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="2F5496"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>'
        "</w:styles>"
    )
    numbering = (
        f'{DECL}<w:numbering {W}>'
        '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
        '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>'
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
        "</w:numbering>"
    )
    core = (
        f'{DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>التقرير السنوي</dc:title></cp:coreProperties>'
    )
    types = (
        f'{DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
        '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
        '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        "</Types>"
    )
    write_zip("report-ar.docx", {
        "[Content_Types].xml": types,
        "_rels/.rels": rels([("rId1", "officeDocument", "word/document.xml", False)]).replace(
            "</Relationships>",
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
        ),
        "word/document.xml": document,
        "word/styles.xml": styles,
        "word/numbering.xml": numbering,
        "word/header1.xml": header,
        "word/footer1.xml": footer,
        "word/_rels/document.xml.rels": rels([
            ("rIdStyles", "styles", "styles.xml", False),
            ("rIdNumbering", "numbering", "numbering.xml", False),
            ("rIdHeader", "header", "header1.xml", False),
            ("rIdFooter", "footer", "footer1.xml", False),
            ("rIdImage", "image", "media/logo.png", False),
            ("rIdLink", "hyperlink", "https://example.sa/warraq", True),
        ]),
        "word/media/logo.png": picture,
        "docProps/core.xml": core,
    })


# ---- Excel --------------------------------------------------------------------------------

def make_xlsx():
    strings = ["الميزانية السنوية", "البند", "المبلغ", "النسبة", "التاريخ", "الرواتب", "الإيجار", "المجموع"]
    sst = "".join(f"<si><t>{s}</t></si>" for s in strings)
    sheet1 = (
        f'{DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" {R}>'
        '<sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews>'
        '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="3" width="12" customWidth="1"/></cols>'
        "<sheetData>"
        '<row r="1"><c r="A1" t="s" s="1"><v>0</v></c></row>'
        '<row r="2"><c r="A2" t="s" s="1"><v>1</v></c><c r="B2" t="s" s="1"><v>2</v></c><c r="C2" t="s" s="1"><v>3</v></c><c r="D2" t="s" s="1"><v>4</v></c></row>'
        '<row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3" s="2"><v>125000.5</v></c><c r="C3" s="3"><v>0.625</v></c><c r="D3" s="4"><v>46284</v></c></row>'
        '<row r="4"><c r="A4" t="s"><v>6</v></c><c r="B4" s="2"><v>75000</v></c><c r="C4" s="3"><v>0.375</v></c><c r="D4" s="4"><v>46285</v></c></row>'
        '<row r="5"><c r="A5" t="s" s="1"><v>7</v></c><c r="B5" s="2"><f>SUM(B3:B4)</f><v>200000.5</v></c><c r="C5" s="3"><f>SUM(C3:C4)</f><v>1</v></c></row>'
        "</sheetData>"
        '<mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells>'
        "</worksheet>"
    )
    sheet2 = (
        f'{DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" {R}>'
        "<sheetData>"
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Quarter</t></is></c><c r="B1" t="inlineStr"><is><t>Sales</t></is></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Q1</t></is></c><c r="B2"><v>1500</v></c></row>'
        '<row r="3"><c r="A3" t="inlineStr"><is><t>Q2</t></is></c><c r="B3" t="b"><v>1</v></c></row>'
        "</sheetData></worksheet>"
    )
    hidden = (
        f'{DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SECRET-HIDDEN</t></is></c></row></sheetData></worksheet>'
    )
    styles = (
        f'{DECL}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>'
        '<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
        '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    )
    workbook = (
        f'{DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" {R}><sheets>'
        '<sheet name="الميزانية" sheetId="1" r:id="rId1"/><sheet name="Summary" sheetId="2" r:id="rId2"/>'
        '<sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>'
    )
    ws = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
    types = (
        f'{DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        f'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="{ws}"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="{ws}"/>'
        f'<Override PartName="/xl/worksheets/sheet3.xml" ContentType="{ws}"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'
    )
    write_zip("budget-ar.xlsx", {
        "[Content_Types].xml": types,
        "_rels/.rels": rels([("rId1", "officeDocument", "xl/workbook.xml", False)]),
        "xl/workbook.xml": workbook,
        "xl/_rels/workbook.xml.rels": rels([
            ("rId1", "worksheet", "worksheets/sheet1.xml", False),
            ("rId2", "worksheet", "worksheets/sheet2.xml", False),
            ("rId3", "worksheet", "worksheets/sheet3.xml", False),
            ("rId4", "styles", "styles.xml", False),
            ("rId5", "sharedStrings", "sharedStrings.xml", False),
        ]),
        "xl/worksheets/sheet1.xml": sheet1,
        "xl/worksheets/sheet2.xml": sheet2,
        "xl/worksheets/sheet3.xml": hidden,
        "xl/styles.xml": styles,
        "xl/sharedStrings.xml": f'{DECL}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(strings)}" uniqueCount="{len(strings)}">{sst}</sst>',
    })


# ---- PowerPoint ---------------------------------------------------------------------------

def make_pptx():
    emu = lambda pt: int(pt * 12700)
    theme = (
        f'{DECL}<a:theme {A} name="Office"><a:themeElements><a:clrScheme name="Office">'
        '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
        '<a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>'
        '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
        '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>'
        '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'
        '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:majorFont>'
        '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme>'
        '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
        '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
        '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
        '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
        "</a:fmtScheme></a:themeElements></a:theme>"
    )
    tree_start = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    xfrm = lambda x, y, w, h: f'<a:xfrm><a:off x="{emu(x)}" y="{emu(y)}"/><a:ext cx="{emu(w)}" cy="{emu(h)}"/></a:xfrm>'
    master = (
        f'{DECL}<p:sldMaster {A} {R} {P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>{tree_start}'
        f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>{xfrm(36, 20, 648, 70)}</p:spPr></p:sp>'
        f'<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>{xfrm(36, 110, 648, 270)}</p:spPr></p:sp>'
        '</p:spTree></p:cSld>'
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
        '<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="3600" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>'
        '<p:bodyStyle><a:lvl1pPr><a:buChar char="•"/><a:defRPr sz="2400"/></a:lvl1pPr><a:lvl2pPr><a:buChar char="–"/><a:defRPr sz="2000"/></a:lvl2pPr></p:bodyStyle>'
        '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>'
    )
    layout = (
        f'{DECL}<p:sldLayout {A} {R} {P} type="obj"><p:cSld name="Title and Content">{tree_start}'
        f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>{xfrm(36, 24, 648, 64)}</p:spPr></p:sp>'
        '</p:spTree></p:cSld></p:sldLayout>'
    )
    title_run = lambda text: f'<a:r><a:rPr lang="ar-SA"/><a:t>{text}</a:t></a:r>'
    slide1 = (
        f'{DECL}<p:sld {A} {R} {P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F4F7FB"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>{tree_start}'
        # A title with no place of its own: it takes the layout's.
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>'
        f'<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr rtl="1"/>{title_run("عرض مكتبة ورّاق")}</a:p></p:txBody></p:sp>'
        f'<p:sp><p:nvSpPr><p:cNvPr id="3" name="Subtitle"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>{xfrm(72, 150, 576, 60)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="ctr" rtl="1"/><a:r><a:rPr lang="ar-SA" sz="2000" i="1"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr><a:t>تقرير الربع الثالث</a:t></a:r></a:p></p:txBody></p:sp>'
        "</p:spTree></p:cSld></p:sld>"
    )
    slide2 = (
        f'{DECL}<p:sld {A} {R} {P}><p:cSld>{tree_start}'
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>'
        f'<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr rtl="1"/>{title_run("أرقام الربع")}</a:p></p:txBody></p:sp>'
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>'
        f'<p:spPr>{xfrm(380, 110, 304, 200)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>'
        '<a:p><a:pPr algn="r" rtl="1"/><a:r><a:rPr lang="ar-SA"/><a:t>ارتفعت المبيعات</a:t></a:r></a:p>'
        '<a:p><a:pPr algn="r" rtl="1"/><a:r><a:rPr lang="ar-SA" b="1"/><a:t>زاد عدد القراء</a:t></a:r></a:p>'
        '<a:p><a:pPr lvl="1" algn="r" rtl="1"/><a:r><a:rPr lang="ar-SA"/><a:t>في الرياض وجدة</a:t></a:r></a:p></p:txBody></p:sp>'
        f'<p:sp><p:nvSpPr><p:cNvPr id="4" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>{xfrm(36, 320, 300, 60)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
        '<a:solidFill><a:schemeClr val="accent2"/></a:solidFill></p:spPr>'
        '<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr" rtl="1"/><a:r><a:rPr lang="ar-SA" sz="1600"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>ملاحظة مهمة</a:t></a:r></a:p></p:txBody></p:sp>'
        f'<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{xfrm(36, 110, 160, 80)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
        f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="{emu(36)}" y="{emu(200)}"/><a:ext cx="{emu(300)}" cy="{emu(100)}"/></p:xfrm>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" rtl="1"/>'
        f'<a:tblGrid><a:gridCol w="{emu(150)}"/><a:gridCol w="{emu(150)}"/></a:tblGrid>'
        f'<a:tr h="{emu(30)}"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ar-SA" sz="1400"/><a:t>المدينة</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="D9E2F3"/></a:solidFill></a:tcPr></a:tc>'
        '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ar-SA" sz="1400"/><a:t>القراء</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>'
        f'<a:tr h="{emu(30)}"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ar-SA" sz="1400"/><a:t>الرياض</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>'
        '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1400"/><a:t>1,250</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>'
        "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>"
        "</p:spTree></p:cSld></p:sld>"
    )
    presentation = (
        f'{DECL}<p:presentation {A} {R} {P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>'
        f'<p:sldSz cx="{emu(720)}" cy="{emu(405)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
    )
    ct = lambda kind: f"application/vnd.openxmlformats-officedocument.presentationml.{kind}+xml"
    types = (
        f'{DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        f'<Override PartName="/ppt/presentation.xml" ContentType="{ct("presentation.main")}"/>'
        f'<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="{ct("slideMaster")}"/>'
        f'<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="{ct("slideLayout")}"/>'
        f'<Override PartName="/ppt/slides/slide1.xml" ContentType="{ct("slide")}"/><Override PartName="/ppt/slides/slide2.xml" ContentType="{ct("slide")}"/>'
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'
    )
    write_zip("slides-ar.pptx", {
        "[Content_Types].xml": types,
        "_rels/.rels": rels([("rId1", "officeDocument", "ppt/presentation.xml", False)]),
        "ppt/presentation.xml": presentation,
        "ppt/_rels/presentation.xml.rels": rels([
            ("rId1", "slideMaster", "slideMasters/slideMaster1.xml", False),
            ("rId2", "slide", "slides/slide1.xml", False),
            ("rId3", "slide", "slides/slide2.xml", False),
            ("rId4", "theme", "theme/theme1.xml", False),
        ]),
        "ppt/slideMasters/slideMaster1.xml": master,
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([
            ("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml", False),
            ("rId2", "theme", "../theme/theme1.xml", False),
        ]),
        "ppt/slideLayouts/slideLayout1.xml": layout,
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([("rId1", "slideMaster", "../slideMasters/slideMaster1.xml", False)]),
        "ppt/slides/slide1.xml": slide1,
        "ppt/slides/_rels/slide1.xml.rels": rels([("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml", False)]),
        "ppt/slides/slide2.xml": slide2,
        "ppt/slides/_rels/slide2.xml.rels": rels([
            ("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml", False),
            ("rId2", "image", "../media/chart.png", False),
        ]),
        "ppt/media/chart.png": png(160, 80, (200, 60, 40), "Q3"),
        "ppt/theme/theme1.xml": theme,
    })


# ---- Web page, Markdown, text, CSV --------------------------------------------------------

def make_text_files():
    logo = base64.b64encode(png(120, 40, (40, 140, 80), "logo")).decode("ascii")
    html = f"""<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>صفحة ورّاق</title>
<style>body {{ font-family: serif }}</style>
<script>document.title = 'this never runs'</script></head>
<body>
<h1>دليل ورّاق</h1>
<p>ورّاق محرر <strong>عربي أولًا</strong> لملفات PDF، <em>يعمل على جهازك</em> و<a href="https://example.sa/ar">موقعه هنا</a>.</p>
<h2>المزايا</h2>
<ul><li>تحرير النص العربي</li><li>تصدير إلى Excel<ul><li>مع الجداول</li></ul></li></ul>
<ol><li>افتح الملف</li><li>اختر الأداة</li></ol>
<table><thead><tr><th>الأداة</th><th>الحالة</th></tr></thead>
<tbody><tr><td>إنشاء PDF</td><td>جاهزة</td></tr><tr><td colspan="2">كل الأدوات تعمل محليًا</td></tr></tbody></table>
<blockquote>المعرفة نور.</blockquote>
<pre>warraq --version
0.1.0</pre>
<p dir="ltr">An English paragraph, left to right.</p>
<img src="data:image/png;base64,{logo}" width="120" height="40" alt="شعار">
<img src="https://example.com/tracker.png" alt="never fetched">
<p hidden>نص مخفي لا يظهر</p>
</body></html>
"""
    open(os.path.join(HERE, "page-ar.html"), "w", encoding="utf-8").write(html)
    legacy = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1256"></head><body dir="rtl"><p>مرحبا بكم في ورّاق</p></body></html>'
    open(os.path.join(HERE, "legacy-1256.html"), "wb").write(legacy.encode("cp1256"))
    md = """# ملاحظات ورّاق

فقرة فيها **كلمة عريضة** و*مائلة* و~~محذوفة~~ و`رمز` و[رابط](https://example.sa).

## قائمة

- البند الأول
- البند الثاني
  - بند فرعي
1. خطوة أولى
2. خطوة ثانية

| المدينة | القراء |
|:--|--:|
| الرياض | 1,250 |
| جدة | ٩٨٠ |

> اقتباس من كتاب.

```
code block
```

---

English line with *emphasis*.
"""
    open(os.path.join(HERE, "notes-ar.md"), "w", encoding="utf-8").write(md)
    txt = "رسالة من ورّاق\n\nهذا نص عادي بالعربية.\nوسطر ثانٍ في الفقرة نفسها.\n\nThis is a plain English paragraph.\n"
    open(os.path.join(HERE, "notes-ar.txt"), "w", encoding="utf-8").write(txt)
    csv = "المدينة,القراء,النسبة\nالرياض,1250,45%\n\"جدة، الساحل\",980,35%\nالدمام,٥٦٠,20%\n"
    open(os.path.join(HERE, "cities-ar.csv"), "w", encoding="utf-8").write(csv)
    print("wrote page-ar.html legacy-1256.html notes-ar.md notes-ar.txt cities-ar.csv")


# ---- Pictures -----------------------------------------------------------------------------

def make_pictures():
    # Two pages: a fax page (CCITT Group 4) and a grey page (LZW).
    fax = Image.new("1", (400, 200), 1)
    draw = ImageDraw.Draw(fax)
    draw.rectangle((20, 20, 380, 180), outline=0, width=4)
    draw.text((40, 90), "FAX PAGE ONE", fill=0)
    grey = Image.new("L", (200, 300), 230)
    ImageDraw.Draw(grey).rectangle((30, 30, 170, 270), fill=60)
    # Pillow writes one compression for every page, so the second is bilevel too.
    fax.save(os.path.join(HERE, "scan-2pages.tiff"), compression="group4", save_all=True, append_images=[grey.convert("1")], dpi=(200, 200))
    grey.save(os.path.join(HERE, "grey-lzw.tiff"), compression="tiff_lzw", dpi=(150, 150))
    # A photo taken turned: stored wide, EXIF says turn it a quarter clockwise.
    photo = Image.new("RGB", (240, 120), (220, 30, 30))
    ImageDraw.Draw(photo).rectangle((120, 0, 240, 120), fill=(30, 30, 220))
    exif = Image.Exif()
    exif[0x0112] = 6
    photo.save(os.path.join(HERE, "photo-rotated.jpg"), "JPEG", quality=90, exif=exif.tobytes())
    Image.new("RGB", (160, 90), (40, 160, 90)).save(os.path.join(HERE, "picture.webp"), "WEBP", lossless=True)
    Image.new("RGB", (120, 60), (90, 40, 160)).save(os.path.join(HERE, "picture.gif"), "GIF")
    Image.new("RGB", (100, 50), (160, 120, 30)).save(os.path.join(HERE, "picture.bmp"), "BMP")
    print("wrote scan-2pages.tiff grey-lzw.tiff photo-rotated.jpg picture.webp picture.gif picture.bmp")


def make_scan():
    """The corpus's 200 dpi invoice scan as a fax TIFF, for reading after creating (its truth is in the corpus)."""
    import fitz  # PyMuPDF, only to take the picture out of the corpus file

    corpus = os.path.join(HERE, "..", "..", "corpus", "arabic", "generated", "scan-arial-200dpi-bilevel.pdf")
    doc = fitz.open(corpus)
    picture = doc.extract_image(doc[0].get_images(full=True)[0][0])
    image = Image.open(io.BytesIO(picture["image"])).convert("1")
    image.save(os.path.join(HERE, "scan-invoice.tiff"), compression="group4", dpi=(200, 200))
    print("wrote scan-invoice.tiff")


if __name__ == "__main__":
    make_docx()
    make_xlsx()
    make_pptx()
    make_text_files()
    make_pictures()
    make_scan()
