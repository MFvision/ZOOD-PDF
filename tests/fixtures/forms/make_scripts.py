#!/usr/bin/env python3
"""Two small forms for what Prepare form must say rather than do:

  scripts-not-run.pdf  a text field whose calculation, and a document open
                       action, are JavaScript outside the subset Warraq runs
  xfa-static.pdf       a static XFA form: an XFA packet beside a real AcroForm

Written by hand, byte by byte, so nothing else decides what is in them:

  python3 tests/fixtures/forms/make_scripts.py
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def pdf(objects: list[bytes]) -> bytes:
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def stream(data: bytes, extra: bytes = b"") -> bytes:
    return b"<< /Length " + str(len(data)).encode() + extra + b" >>\nstream\n" + data + b"\nendstream"


PAGE_TEXT = b"BT /F1 14 Tf 72 760 Td (Amount) Tj ET\n0.5 w 72 700 m 300 700 l S\n"

# 1: catalog, 2: pages, 3: page, 4: content, 5: font, 6: field, 7: open action
scripts = pdf([
    b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] /DA (/Helv 12 Tf 0 g) >> "
    b"/OpenAction 7 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
    b"/Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>",
    stream(PAGE_TEXT),
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /Rect [72 702 300 724] /P 3 0 R /F 4 "
    b"/DA (/Helv 12 Tf 0 g) /AA << /C << /S /JavaScript /JS (event.value = this.getField\\('Amount'\\).value.length;) >> "
    b"/F << /S /JavaScript /JS (AFNumber_Format\\(2, 0, 0, 0, \"\", true\\);) >> >> >>",
    b"<< /S /JavaScript /JS (app.alert\\('Hello from the file'\\);) >>",
])
(HERE / "scripts-not-run.pdf").write_bytes(scripts)

XFA = (b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">'
       b'<subform name="form1" layout="position"><field name="Amount"/></subform></template></xdp:xdp>')

# 1: catalog, 2: pages, 3: page, 4: content, 5: font, 6: field, 7: XFA stream
xfa = pdf([
    b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] /DA (/Helv 12 Tf 0 g) /XFA 7 0 R >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
    b"/Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>",
    stream(PAGE_TEXT),
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /Rect [72 702 300 724] /P 3 0 R /F 4 "
    b"/DA (/Helv 12 Tf 0 g) >>",
    stream(XFA),
])
(HERE / "xfa-static.pdf").write_bytes(xfa)
print("wrote scripts-not-run.pdf and xfa-static.pdf")
