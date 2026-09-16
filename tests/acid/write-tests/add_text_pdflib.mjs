// Can pdf-lib add an Arabic paragraph? (known: no shaping, no bidi)
import fs from 'node:fs'; import path from 'node:path';
import { PDFDocument } from 'pdf-lib'; import fontkit from '@pdf-lib/fontkit';
const repo = path.resolve(process.argv[2]); import { fileURLToPath } from "node:url"; const here = path.dirname(fileURLToPath(import.meta.url));
const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
const amiri = await pdf.embedFont(fs.readFileSync(path.join(repo, 'tests/fonts/Amiri-Regular.ttf')), { subset: true });
const page = pdf.addPage([595, 842]);
page.drawText('مرحباً بكم في محرّر وراق — Warraq 2026', { x: 80, y: 760, size: 20, font: amiri });
fs.writeFileSync(path.join(here, 'out-pdflib-add-text.pdf'), await pdf.save()); console.log('pdf-lib add-text written');
