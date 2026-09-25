#!/usr/bin/env python3
"""Generate third-party encrypted fixtures for warraq-pdf's decryption tests.

These files are produced by INDEPENDENT implementations of the Standard security handler
so our own handler is cross-checked, not just round-tripped:

* qpdf via pikepdf (MPL-2.0) — used ONLY here, as a fixture generator. It is never bundled
  or linked into ZOOD PDF.
* pypdf (BSD-3-Clause).

Every fixture has page content containing "Hello ZOOD" and /Title "Fixture Title".
Run from this directory:  python3 make_fixtures.py
"""
import pikepdf
from pikepdf import Encryption, Permissions, Name, Dictionary, Array
import pypdf

CONTENT = b"BT /F1 24 Tf 72 720 Td (Hello ZOOD) Tj ET"


def base(pages=2):
    pdf = pikepdf.new()
    font = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica))
    for i in range(pages):
        page = pikepdf.Page(Dictionary(Type=Name.Page, MediaBox=Array([0, 0, 595, 842]),
                                       Resources=Dictionary(Font=Dictionary(F1=font))))
        pdf.pages.append(page)
        pdf.pages[-1].obj.Contents = pdf.make_stream(CONTENT + b" %% page %d" % (i + 1))
    pdf.docinfo[Name.Title] = "Fixture Title"
    with pdf.open_metadata(set_pikepdf_as_editor=False) as m:
        m["dc:title"] = "Fixture Title"
    return pdf


def save(name, enc=None, objstm=False):
    pdf = base()
    mode = pikepdf.ObjectStreamMode.generate if objstm else pikepdf.ObjectStreamMode.disable
    pdf.save(name, encryption=enc if enc else False, object_stream_mode=mode,
             deterministic_id=enc is None)


restricted = Permissions(extract=False, modify_other=False, modify_annotation=False,
                         modify_assembly=False, modify_form=False, print_highres=False)

save("plain_objstm.pdf", None, objstm=True)
save("qpdf_r2_rc4_40.pdf", Encryption(owner="owner", user="user", R=2, aes=False, metadata=False))
save("qpdf_r3_rc4_128.pdf", Encryption(owner="owner", user="user", R=3, aes=False, metadata=False))
save("qpdf_r4_rc4.pdf", Encryption(owner="owner", user="user", R=4, aes=False, metadata=False))
save("qpdf_r4_aes.pdf", Encryption(owner="owner", user="user", R=4, aes=True))
save("qpdf_r4_aes_objstm.pdf", Encryption(owner="owner", user="user", R=4, aes=True), objstm=True)
save("qpdf_r4_aes_nometa.pdf", Encryption(owner="owner", user="user", R=4, aes=True, metadata=False))
save("qpdf_r6.pdf", Encryption(owner="owner", user="user", R=6))
save("qpdf_r6_objstm.pdf", Encryption(owner="owner", user="user", R=6), objstm=True)
save("qpdf_r6_empty_user_restricted.pdf", Encryption(owner="owner", user="", R=6, allow=restricted))

# pypdf: a second, independent writer.
for algo, name in [("RC4-40", "pypdf_rc4_40.pdf"), ("RC4-128", "pypdf_rc4_128.pdf"),
                   ("AES-128", "pypdf_aes128.pdf"), ("AES-256", "pypdf_aes256.pdf")]:
    reader = pypdf.PdfReader("plain_objstm.pdf")
    w = pypdf.PdfWriter(clone_from=reader)
    w.encrypt(user_password="user", owner_password="owner", algorithm=algo)
    with open(name, "wb") as f:
        w.write(f)
print("ok")
