// Acid test runner for PDF.js (pdfjs-dist, Node + @napi-rs/canvas).
import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const pdfjs = await import(path.join(pdfjsRoot, 'legacy/build/pdf.mjs'));
const { createCanvas } = await import('@napi-rs/canvas');
const repo = path.resolve(process.argv[2]); const corpus = path.join(repo, 'tests/corpus/arabic');
const shots = path.join(repo, 'docs/research/screenshots/pdfjs'); fs.mkdirSync(shots, { recursive: true });
const PASSWORDS = { 'variant-encrypted-aes256.pdf': 'warraq' };
const files = ['generated', 'realworld'].flatMap(d => fs.existsSync(path.join(corpus, d)) ? fs.readdirSync(path.join(corpus, d)).filter(f => f.endsWith('.pdf')).sort().map(f => path.join(corpus, d, f)) : []);
// Join text items geometrically (pdf.js items are positioned runs without inter-run spaces):
// a new line when the baseline moves, a space when the next run is not adjacent to the previous one.
function joinItems(items) {
  let out = ''; let prev = null;
  for (const it of items) {
    if (!it.str) { continue; }
    const x = it.transform[4], y = it.transform[5], fs = Math.hypot(it.transform[0], it.transform[1]) || 10;
    if (prev) {
      if (Math.abs(y - prev.y) > 0.5 * fs) out += '\n';
      else {
        const tol = 0.3 * fs;
        const adjacentRight = Math.abs(x - (prev.x + prev.w)) < tol, adjacentLeft = Math.abs((x + it.width) - prev.x) < tol;
        if (!(adjacentRight || adjacentLeft) && !out.endsWith(' ')) out += ' ';
      }
    }
    out += it.str; if (it.hasEOL) out += '\n';
    prev = { x, y, w: it.width };
  }
  return out;
}
const out = {};
for (const file of files) {
  const stem = path.basename(file, '.pdf'); const r = {};
  try {
    const t0 = performance.now();
    const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), password: PASSWORDS[path.basename(file)],
      standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts/'), cMapUrl: path.join(pdfjsRoot, 'cmaps/'), cMapPacked: true,
      useSystemFonts: false, isEvalSupported: false, disableFontFace: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, verbosity: 0 }); const doc = await task.promise;
    const page = await doc.getPage(1); r.t_open_ms = +(performance.now() - t0).toFixed(1); r.pages = doc.numPages;
    const t1 = performance.now(); const viewport = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)); const ctx = canvas.getContext('2d');
    await page.render({ canvas, canvasContext: ctx, viewport }).promise; r.t_render_p1_ms = +(performance.now() - t1).toFixed(1);
    const shot = path.join(shots, `${stem}.jpg`); fs.writeFileSync(shot, canvas.toBuffer('image/jpeg', 80)); r.shot = `docs/research/screenshots/pdfjs/${stem}.jpg`;
    const t2 = performance.now(); const texts = []; let items = 0;
    for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      items += tc.items.length; texts.push(joinItems(tc.items));
    }
    r.t_text_ms = +(performance.now() - t2).toFixed(1); r.text = texts.join('\n'); r.selectable = items > 0;
    if (doc.numPages >= 100) { const t3 = performance.now(); for (let i = 1; i <= doc.numPages; i++) await (await doc.getPage(i)).getTextContent(); r.t_text_all_pages_ms = +(performance.now() - t3).toFixed(1); }
    r.open = true; await task.destroy();
  } catch (e) { r.open = false; r.error = `${e.name}: ${String(e.message).slice(0, 160)}`; }
  out[stem] = r; console.log(`pdfjs   ${stem.padEnd(45)} ${r.open ? 'OK ' : 'ERR ' + r.error} ${r.t_open_ms ?? '-'}ms open ${r.t_render_p1_ms ?? '-'}ms render`);
}
fs.writeFileSync(path.join(repo, 'tests/acid/results-pdfjs.json'), JSON.stringify(out, null, 1));
