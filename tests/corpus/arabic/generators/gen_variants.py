#!/usr/bin/env python3
"""Structural variants of the Chrome-generated Arabic files (pikepdf/qpdf):
encryption, object streams, linearization, Arabic metadata/outlines/annotations/
attachments, a hand-written incremental update, and 100/500-page perf files."""
import os, re, shutil, sys
from pathlib import Path
import pikepdf
from pikepdf import Pdf, Name, Dictionary, Array, String, Encryption, Outline, OutlineItem, AttachedFileSpec
sys.path.insert(0, os.path.dirname(__file__)); import corpus_texts as T
REPO = Path(sys.argv[1]).resolve(); GEN = REPO / "tests/corpus/arabic/generated"; TRUTH = REPO / "tests/corpus/arabic/truth"
SRC = GEN / "chrome-notonaskh-justified-3pages.pdf"
src_truth = (TRUTH / "chrome-notonaskh-justified-3pages.txt").read_text(encoding="utf-8")

def done(out): print("ok ", out.name, out.stat().st_size, "bytes")
def truth(name, text=src_truth): (TRUTH / f"{name}.txt").write_text(text, encoding="utf-8")

with Pdf.open(SRC) as pdf:
    out = GEN / "variant-encrypted-aes256.pdf"
    pdf.save(out, encryption=Encryption(user="warraq", owner="warraq-owner", R=6, aes=True)); done(out); truth(out.stem)
with Pdf.open(SRC) as pdf:
    out = GEN / "variant-objectstreams-xrefstream.pdf"
    pdf.save(out, object_stream_mode=pikepdf.ObjectStreamMode.generate, compress_streams=True); done(out); truth(out.stem)
with Pdf.open(SRC) as pdf:
    out = GEN / "variant-linearized.pdf"; pdf.save(out, linearize=True); done(out); truth(out.stem)

with Pdf.open(SRC) as pdf:
    with pdf.open_metadata() as m:
        m["dc:title"] = "دليل وراق: النسخة التجريبية"; m["dc:creator"] = ["فريق وراق"]; m["dc:description"] = "وثيقة اختبار تحتوي على بيانات وصفية عربية"
    pdf.docinfo[Name.Title] = String("دليل وراق: النسخة التجريبية"); pdf.docinfo[Name.Author] = String("فريق وراق"); pdf.docinfo[Name.Keywords] = String("عربي، اختبار، PDF")
    with pdf.open_outline() as ol:
        for i, h in enumerate(T.HEADINGS):
            item = OutlineItem(h, i); item.children.append(OutlineItem("مقدمة " + h.split(":")[0], i)); ol.root.append(item)
    page = pdf.pages[0]
    note = Dictionary(Type=Name.Annot, Subtype=Name.Text, Rect=Array([60, 700, 84, 724]), Contents=String("ملاحظة: يرجى مراجعة هذه الفقرة قبل النشر."), T=String("محمد"), Name=Name.Comment, F=4, C=Array([1, 0.8, 0]))
    hl = Dictionary(Type=Name.Annot, Subtype=Name.Highlight, Rect=Array([100, 640, 540, 660]), QuadPoints=Array([100, 660, 540, 660, 100, 640, 540, 640]), Contents=String("تمييز نصي"), T=String("سارة"), C=Array([1, 1, 0]), F=4)
    page.Annots = Array([pdf.make_indirect(note), pdf.make_indirect(hl)])
    fs = AttachedFileSpec(pdf, "بيانات مرفقة: اسم الملف بالعربية".encode("utf-8"), description="مرفق تجريبي", filename="ملف-مرفق.txt", mime_type="text/plain")
    pdf.attachments["ملف-مرفق.txt"] = fs
    pdf.Root.Lang = String("ar-SA")
    out = GEN / "variant-arabic-metadata-outlines-annots.pdf"; pdf.save(out); done(out); truth(out.stem)

# incremental update appended by hand on top of the Cairo invoice (title changed in Arabic)
inv = GEN / "chrome-cairo-mixed-invoice.pdf"; data = inv.read_bytes()
with Pdf.open(inv) as pdf:
    root_id = pdf.Root.objgen[0]; size = int(pdf.trailer.Size)
prev = int(re.findall(rb"startxref\s+(\d+)", data)[-1])
uses_xref_stream = not data[prev:prev + 4].startswith(b"xref")
new_num = size
title = "<" + (b"\xfe\xff" + "فاتورة ضريبية — نسخة محدّثة".encode("utf-16-be")).hex() + ">"
body = bytearray(data if data.endswith(b"\n") else data + b"\n")
obj_off = len(body)
body += f"{new_num} 0 obj\n<< /Title {title} /Producer (Warraq incremental update test) >>\nendobj\n".encode()
if uses_xref_stream:
    xs_num = new_num + 1; xs_off = len(body)
    rows = bytes([1]) + obj_off.to_bytes(4, "big") + b"\x00\x00" + bytes([1]) + xs_off.to_bytes(4, "big") + b"\x00\x00"
    body += f"{xs_num} 0 obj\n<< /Type /XRef /Size {xs_num + 1} /W [1 4 2] /Index [{new_num} 2] /Root {root_id} 0 R /Info {new_num} 0 R /Prev {prev} /Length {len(rows)} >>\nstream\n".encode() + rows + b"\nendstream\nendobj\n"
    body += f"startxref\n{xs_off}\n%%EOF\n".encode()
else:
    xref_off = len(body)
    body += f"xref\n{new_num} 1\n{obj_off:010d} 00000 n \ntrailer\n<< /Size {new_num + 1} /Root {root_id} 0 R /Info {new_num} 0 R /Prev {prev} >>\nstartxref\n{xref_off}\n%%EOF\n".encode()
out = GEN / "variant-incremental-update.pdf"; out.write_bytes(body); done(out); truth(out.stem, (TRUTH / "chrome-cairo-mixed-invoice.txt").read_text(encoding="utf-8"))
with Pdf.open(out) as check: print("    incremental update readable, title =", str(check.docinfo.get("/Title")), "| xref stream:", uses_xref_stream)

# performance files: distinct page objects sharing content streams and fonts
for n in (100, 500):
    with Pdf.open(SRC) as pdf:
        base = list(pdf.pages)
        while len(pdf.pages) < n:
            pdf.pages.append(base[len(pdf.pages) % 3])
        out = GEN / f"perf-text-{n}-pages.pdf"; pdf.save(out, object_stream_mode=pikepdf.ObjectStreamMode.generate); done(out)
