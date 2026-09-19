#!/usr/bin/env node
// A page for search-and-redact: English in a standard font — so its words
// sit literally in the content stream, where a raw check can look for them —
// and Arabic drawn by Warraq's own core, shaped, subset and carrying its
// words as ActualText, as every Arabic edit does. Emails, phone numbers
// (one in Arabic-Indic digits), an IBAN, a card number, a national ID and
// dates for the ready-made patterns.
//
// Needs the WASM core: `pnpm build:core`, then from the repository root:
//   node tests/fixtures/redact/make.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const coreDir = new URL('packages/ui/src/core-wasm/', root);
const core = await import(new URL('warraq_core.js', coreDir).href);
await core.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', coreDir)) });

const english = [
  'Contract between Warraq Labs and Nadia Haddad',
  'Contact: nadia.haddad@example.com, phone +966 50 123 4567',
  'IBAN SA03 8000 0000 6080 1016 7519, card 4111 1111 1111 1111',
  'Signed on 16/09/2026. National ID 1012345678.',
  'Keep this line: the rest stays readable.',
];
const content = english
  .map((line, i) => `BT /F1 12 Tf 56 ${780 - i * 22} Td (${line}) Tj ET`)
  .join('\n');

// A minimal file: catalog, one A4 page, Helvetica.
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
];
let pdf = '%PDF-1.7\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const doc = core.Document.open(new TextEncoder().encode(pdf));
const amiri = new Uint8Array(readFileSync(new URL('tests/fonts/Amiri-Regular.ttf', root)));
const arabic = [
  'العقد بين شركة ورّاق والسيدة نادية',
  'البريد: nadia@example.sa والجوال ٠٥٠١٢٣٤٥٦٧',
  'تاريخ التوقيع ١٦ سبتمبر ٢٠٢٦',
  'يبقى هذا السطر كما هو.',
];
// `x` is where an Arabic line starts: its right edge.
arabic.forEach((line, i) => doc.add_text(0, 540, 330 + i * 34, 16, line, amiri));
const out = doc.save();
doc.free();
writeFileSync(new URL('tests/fixtures/redact/contract.pdf', root), out);
console.log('contract.pdf', out.length, 'bytes');
