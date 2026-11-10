// The sample PDFs the reopen check uses: every page filled with the colour of
// its page number (the same eight colours in each file), with the file's
// letter and the page number in big type. A screenshot then says which page
// is on screen, to the check (screen.mjs) and at a glance to a person.
//   A-restore.pdf (8 pages), B-restore.pdf (6 pages), C-restore.pdf (5 pages).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Page n's colour, n from 1 to 8, in 0–255 sRGB: far apart, so a screenshot cannot mix them up. */
export const PAGE_COLORS = [
  [230, 25, 75], // 1 red
  [245, 130, 48], // 2 orange
  [255, 225, 25], // 3 yellow
  [60, 180, 75], // 4 green
  [0, 130, 200], // 5 blue
  [145, 30, 180], // 6 purple
  [70, 240, 240], // 7 cyan
  [240, 50, 230], // 8 magenta
];

export const FILES = { A: 8, B: 6, C: 5 };

const unit = (value) => (value / 255).toFixed(3);

function pdf(letter, pages) {
  const objects = [];
  const kids = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  for (let n = 1; n <= pages; n++) {
    const page = 2 + n * 2;
    const content = page + 1;
    kids.push(`${page} 0 R`);
    const [r, g, b] = PAGE_COLORS[n - 1];
    const text =
      `${unit(r)} ${unit(g)} ${unit(b)} rg 0 0 595 842 re f 0 0 0 rg ` +
      `BT /F1 96 Tf 72 560 Td (${letter}  ${n}) Tj ET BT /F1 28 Tf 72 480 Td (File ${letter}, page ${n} of ${pages}) Tj ET`;
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

/** Writes the three files into `folder`; returns their paths by letter. */
export function writePdfs(folder) {
  mkdirSync(folder, { recursive: true });
  const paths = {};
  for (const [letter, pages] of Object.entries(FILES)) {
    paths[letter] = join(folder, `${letter}-restore.pdf`);
    writeFileSync(paths[letter], pdf(letter, pages));
  }
  return paths;
}
