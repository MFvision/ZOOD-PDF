// Spike: does EmbedPDF's PDFium engine do the missing tools correctly on Arabic files?
import fs from 'node:fs';
import { init } from '@embedpdf/pdfium';
import { PdfiumNative, createNodeFontLoader, FontCharset } from '@embedpdf/engines/pdfium';
import path from 'node:path';
import * as models from '@embedpdf/models';

const REPO = new URL('../../tests/corpus/arabic', import.meta.url).pathname;
const MODE = process.env.FALLBACK === '1' ? 'fallback' : 'plain';
const OUT = new URL(`./out-${MODE}/`, import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const report = {};
const log = (k, v) => { report[k] = v; console.log(k, typeof v === 'string' ? v : JSON.stringify(v).slice(0, 400)); };

const pdfium = await init({ wasmBinary: fs.readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm') });
console.log('FontCharset keys:', Object.keys(FontCharset).filter((k) => isNaN(Number(k))).join(','));
const fontFallback = MODE === 'fallback'
  ? {
      fonts: { [FontCharset.ARABIC]: 'NotoNaskhArabic-Regular.ttf' },
      fontLoader: createNodeFontLoader(fs, path, 'node_modules/@embedpdf/fonts-arabic/fonts'),
    }
  : null;
const engine = new PdfiumNative(pdfium, { fontFallback });
if (engine.initialize) await engine.initialize().toPromise?.();

const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const read = (rel) => fs.readFileSync(`${REPO}/${rel}`);
let seq = 0;
const open = (bytes, password) =>
  engine.openDocumentBuffer({ id: `d${++seq}`, content: ab(bytes) }, password === undefined ? undefined : { password }).toPromise();
const save = async (doc, name) => {
  const out = Buffer.from(await engine.saveAsCopy(doc).toPromise());
  fs.writeFileSync(`${OUT}${name}.pdf`, out);
  return out;
};
const render = async (bytes, name, pageIndex = 0) => {
  const doc = await open(bytes);
  const img = await engine.renderPageRaw(doc, doc.pages[pageIndex], { scaleFactor: 2, withAnnotations: true, withForms: true }).toPromise();
  fs.writeFileSync(`${OUT}${name}.rgba`, Buffer.from(img.data.buffer ?? img.data));
  fs.writeFileSync(`${OUT}${name}.json`, JSON.stringify({ width: img.width, height: img.height }));
  await engine.closeDocument(doc).toPromise();
};
const text = async (bytes, pageIndex = 0, password) => {
  const doc = await open(bytes, password);
  const t = await engine.extractText(doc, [pageIndex]).toPromise();
  await engine.closeDocument(doc).toPromise();
  return t;
};
const step = async (name, fn) => {
  try { await fn(); } catch (e) { log(`${name}:ERROR`, String(e?.message ?? JSON.stringify(e)).slice(0, 300)); }
};

const INVOICE = read('generated/raw-amiri-cid-identity-tounicode.pdf');
const WORD = read('realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf');
const FORM = read('realworld/F_pdfjs15546_rtl_acroform_textfields_arabic_digits_acrobat.pdf');

// A. Fill an Arabic form field
await step('A', async () => {
  const doc = await open(FORM);
  const widgets = await engine.getPageAnnoWidgets(doc, doc.pages[0]).toPromise();
  log('A.widgets', widgets.map((w) => ({ id: w.id, name: w.field?.name, type: w.field?.type, value: w.field?.value })));
  const target = widgets[0];
  await engine.setFormFieldValue(doc, doc.pages[0], target, { kind: 'text', text: 'محمد الغماس ١٢٣' }).toPromise();
  if (engine.regenerateWidgetAppearances) await engine.regenerateWidgetAppearances(doc, doc.pages[0], [target.id]).toPromise();
  const out = await save(doc, 'A-form');
  await render(out, 'A-form');
  log('A.text', await text(out));
});

// B. An Arabic comment (FreeText) on a real Word export
await step('B', async () => {
  const doc = await open(WORD);
  const p = doc.pages[0];
  log('B.page', p.size);
  const id = await engine.createPageAnnotation(doc, p, {
    type: models.PdfAnnotationSubtype.FREETEXT,
    id: 'ft-arabic',
    pageIndex: 0,
    rect: { origin: { x: 300, y: 40 }, size: { width: 260, height: 40 } },
    contents: 'تعليق عربي للاختبار',
    fontFamily: models.PdfStandardFont.Helvetica,
    fontSize: 16,
    fontColor: '#C00000',
    textAlign: 2,
    verticalAlign: 0,
    opacity: 1,
  }).toPromise();
  log('B.id', id);
  const out = await save(doc, 'B-freetext');
  await render(out, 'B-freetext');
});

// C. Redact the top of an Arabic invoice, then check the text is really gone
await step('C', async () => {
  const before = await text(INVOICE);
  const doc = await open(INVOICE);
  const p = doc.pages[0];
  await engine.redactTextInRects(doc, p, [{ origin: { x: 0, y: 30 }, size: { width: p.size.width, height: 90 } }]).toPromise();
  const out = await save(doc, 'C-redacted');
  await render(out, 'C-redacted');
  const after = await text(out);
  log('C.before', before.slice(0, 160));
  log('C.after', after.slice(0, 160));
});

// D. Encrypt with an Arabic user password (AES), then reopen
await step('D', async () => {
  const doc = await open(INVOICE);
  await engine.setDocumentEncryption(doc, 'سر123', 'owner-secret', 0xfffff0c0 | 0x0).toPromise();
  const out = await save(doc, 'D-encrypted');
  log('D.size', out.length);
  log('D.header', out.subarray(0, 8).toString());
  let refused = false;
  try { await open(out); } catch { refused = true; }
  log('D.refusedWithoutPassword', refused);
  log('D.textWithPassword', (await text(out, 0, 'سر123')).slice(0, 80));
});

// E. Merge two Arabic files
await step('E', async () => {
  const merged = await engine.merge([{ id: 'm1', content: ab(INVOICE) }, { id: 'm2', content: ab(WORD) }]).toPromise();
  const bytes = Buffer.from(merged.content);
  fs.writeFileSync(`${OUT}E-merged.pdf`, bytes);
  const doc = await open(bytes);
  log('E.pages', doc.pages.length);
});

fs.writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
console.log('DONE');
