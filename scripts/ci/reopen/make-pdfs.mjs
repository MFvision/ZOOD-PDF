// Writes the sample PDFs the reopen check uses: plain pages with the file's
// letter and the page number in big type, so a screenshot shows at a glance
// which file and which page is on screen.
//   node make-pdfs.mjs <folder>
// Makes A-restore.pdf (8 pages), B-restore.pdf (6 pages), C-restore.pdf (5 pages).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function pdf(letter, pages) {
  const objects = [];
  const kids = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  for (let n = 1; n <= pages; n++) {
    const page = 2 + n * 2;
    const content = page + 1;
    kids.push(`${page} 0 R`);
    const text = `BT /F1 96 Tf 72 560 Td (${letter}  ${n}) Tj ET BT /F1 28 Tf 72 480 Td (File ${letter}, page ${n} of ${pages}) Tj ET`;
    objects[page] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`;
    objects[content] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const folder = process.argv[2];
if (!folder) throw new Error('usage: node make-pdfs.mjs <folder>');
mkdirSync(folder, { recursive: true });
for (const [letter, pages] of [['A', 8], ['B', 6], ['C', 5]]) {
  writeFileSync(join(folder, `${letter}-restore.pdf`), pdf(letter, pages));
}
console.log(`sample PDFs in ${folder}`);
