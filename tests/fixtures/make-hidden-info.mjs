// Writes tests/fixtures/hidden-info.pdf by hand (no dependencies): a one-page PDF carrying every kind
// of hidden information the Redact tool's "Remove hidden information" must remove — document and
// chained JavaScript, an automatic action, an embedded file + file-attachment annotation, XMP, document
// info, a comment, text in an optional-content layer that is OFF, and invisible (Tr 3) text.
// Run: node tests/fixtures/make-hidden-info.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const content = [
  'BT /F1 20 Tf 72 760 Td (Hidden information test) Tj ET',
  'BT /F1 13 Tf 72 720 Td (This paragraph is visible and stays.) Tj ET',
  '/OC /Hid BDC BT /F1 13 Tf 72 690 Td (HIDDEN LAYER SECRET) Tj ET EMC',
  'BT /F1 13 Tf 3 Tr 72 660 Td (INVISIBLE OCR SECRET) Tj ET',
  '',
].join('\n');
const xmp =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>XMP SECRET CREATOR</dc:creator></rdf:Description>' +
  '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
const payload = 'ATTACHMENT PAYLOAD SECRET\n';

const stream = (dict, data) => `<< ${dict} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`;

const objects = {
  1: "<< /Type /Catalog /Pages 2 0 R /OpenAction 10 0 R /Names 11 0 R /Metadata 12 0 R /AA << /WC 14 0 R >> /OCProperties << /OCGs [13 0 R] /D << /OFF [13 0 R] /Order [13 0 R] >> >> >>",
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> /Properties << /Hid 13 0 R >> >> /Contents 5 0 R /Annots [6 0 R 7 0 R] >>',
  4: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  5: stream('', content),
  6: '<< /Type /Annot /Subtype /FileAttachment /Rect [500 780 520 800] /FS 8 0 R /Contents (Attached file) /Name /PushPin >>',
  7: '<< /Type /Annot /Subtype /Text /Rect [500 700 520 720] /Contents (Reviewer comment secret) >>',
  8: '<< /Type /Filespec /F (notes.txt) /UF (notes.txt) /EF << /F 9 0 R >> >>',
  9: stream('/Type /EmbeddedFile', payload),
  10: "<< /S /JavaScript /JS (app.alert\\('opened'\\)) /Next 15 0 R >>",
  11: '<< /JavaScript << /Names [(init) 16 0 R] >> /EmbeddedFiles << /Names [(notes.txt) 8 0 R] >> >>',
  12: stream('/Type /Metadata /Subtype /XML', xmp),
  13: '<< /Type /OCG /Name (Hidden layer) >>',
  14: "<< /S /JavaScript /JS (app.alert\\('closing'\\)) >>",
  15: "<< /S /JavaScript /JS (app.alert\\('chained'\\)) >>",
  16: '<< /S /JavaScript /JS (this.print\\(\\)) >>',
  17: '<< /Title (Hidden info fixture) /Author (SECRET AUTHOR) >>',
};

let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
const offsets = [];
const n = Object.keys(objects).length;
for (let i = 1; i <= n; i++) {
  offsets[i] = Buffer.byteLength(out, 'latin1');
  out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
}
const xref = Buffer.byteLength(out, 'latin1');
out += `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= n; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
out += `trailer\n<< /Size ${n + 1} /Root 1 0 R /Info 17 0 R /ID [<5a6f6f64486964646e5446697874757265> <5a6f6f64486964646e5446697874757265>] >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(here, 'hidden-info.pdf'), Buffer.from(out, 'latin1'));
console.log('wrote hidden-info.pdf', Buffer.byteLength(out, 'latin1'), 'bytes');
