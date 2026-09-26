/**
 * Full OCR accuracy benchmark over the generated corpus scans, through the real product path:
 * headless Chromium, the production build, Scan & OCR → "Make searchable" → Save, then the saved
 * bytes are read back with the engine (text.plain) and scored against the page's truth.
 *
 *   python3 scripts/corpus/generate.py      # tests/corpus/generated/scans (git-ignored)
 *   pnpm ocr:bench                          # E2E_PORT, OCR_BENCH_ONLY=<substring> to filter
 *   OCR_BENCH_UPDATE=1 pnpm ocr:bench       # also rewrite the "corpus" floors in baseline.json
 *
 * Results: tests/ocr/results.json and a Markdown table on stdout (copied to docs/STATUS.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { pickLanguages, type Lang } from './drive';
import { plainText } from './engine';
import { score, type Score } from './score';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCANS = path.join(ROOT, 'tests/corpus/generated/scans');
const TRUTH = path.join(ROOT, 'tests/corpus/truth');
const BASELINE = path.join(ROOT, 'tests/ocr/baseline.json');
const RESULTS = path.join(ROOT, 'tests/ocr/results.json');

const DOCS: { id: string; label: string; langs: Lang[] }[] = [
  { id: 'chrome-news-amiri', label: 'Arabic news (Amiri)', langs: ['ar'] },
  { id: 'chrome-tashkeel-amiri', label: 'Arabic, full tashkeel (Amiri)', langs: ['ar'] },
  { id: 'chrome-urdu-nastaliq', label: 'Urdu Nastaliq', langs: ['ur'] },
  { id: 'chrome-persian-vazirmatn', label: 'Persian (Vazirmatn)', langs: ['fa'] },
  { id: 'chrome-mixed-naskh', label: 'Mixed Arabic/English (Naskh)', langs: ['ar', 'en'] },
];
const VARIANTS = ['straight', 'crooked5', 'crooked8', 'shadow'] as const;

interface Row extends Score {
  id: string;
  doc: string;
  variant: string;
  langs: Lang[];
  seconds: number;
}

const rows: Row[] = [];
const only = process.env.OCR_BENCH_ONLY;

test.describe.configure({ mode: 'serial', timeout: 600_000 });

for (const doc of DOCS) {
  for (const variant of VARIANTS) {
    const id = `${doc.id}-${variant}`;
    if (only && !id.includes(only)) continue;
    test(id, async ({ browser }) => {
      const file = path.join(SCANS, `${id}.pdf`);
      test.skip(!fs.existsSync(file), `missing ${file}: run python3 scripts/corpus/generate.py`);
      const context = await browser.newContext({ locale: 'en-US' });
      await context.addInitScript(() => {
        const w = window as unknown as { __saved: Uint8Array[]; showSaveFilePicker: unknown };
        w.__saved = [];
        w.showSaveFilePicker = async (o: { suggestedName: string }) => ({
          name: o.suggestedName,
          createWritable: async () => {
            const parts: Uint8Array[] = [];
            return {
              write: async (b: Uint8Array) => void parts.push(new Uint8Array(b)),
              close: async () => {
                const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
                let o2 = 0;
                for (const p of parts) {
                  all.set(p, o2);
                  o2 += p.length;
                }
                w.__saved.push(all);
              },
            };
          },
        });
      });
      const page = await context.newPage();
      const external: string[] = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (!['localhost', '127.0.0.1'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) external.push(r.url());
      });
      await page.goto('/');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-card=open]').click()]);
      await chooser.setFiles(file);
      const view = page.locator('[data-testid=document-view]:visible');
      await expect(view.locator('.viewer-loading')).toHaveCount(0, { timeout: 60_000 });
      await view.locator('[data-testid=tool-picker]').click();
      await page.locator('[data-testid=tool-gallery] [data-tool=scan]').click();
      await pickLanguages(page, doc.langs);
      const t0 = Date.now();
      await page.locator('[data-testid=ocr-start]').click();
      await expect(page.locator('[data-testid=ocr-searchable]')).toHaveCount(0, { timeout: 540_000 });
      const seconds = (Date.now() - t0) / 1000;
      await expect(view.locator('.viewer-loading')).toHaveCount(0, { timeout: 60_000 });
      await view.locator('[data-testid=save]').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __saved: unknown[] }).__saved.length)).toBe(1);
      const bytes = Buffer.from(await page.evaluate(() => Array.from((window as unknown as { __saved: Uint8Array[] }).__saved[0]!)));
      const text = (await plainText(bytes)).text;
      const truth = fs.readFileSync(path.join(TRUTH, `${doc.id}.txt`), 'utf8');
      const s = score(text, truth);
      rows.push({ id, doc: doc.label, variant, langs: doc.langs, seconds, ...s });
      test.info().annotations.push({ type: 'accuracy', description: `${id}: ${s.accuracy.toFixed(2)} % (tashkeel kept ${s.withTashkeel.toFixed(2)} %), ${seconds.toFixed(0)} s` });
      expect(external).toEqual([]);
      await context.close();
    });
  }
}

test.afterAll(() => {
  if (rows.length === 0) return;
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as { tolerance: number; corpus: Record<string, { accuracy: number }> };
  const prev = fs.existsSync(RESULTS) ? (JSON.parse(fs.readFileSync(RESULTS, 'utf8')) as { rows: Row[] }).rows : [];
  const merged = new Map(prev.map((r) => [r.id, r]));
  for (const r of rows) merged.set(r.id, r);
  const all = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(RESULTS, `${JSON.stringify({ measured: new Date().toISOString().slice(0, 10), rows: all }, null, 2)}\n`);
  const lines = ['| Page | Languages | Straight | Crooked 5° | Crooked 8° | Shadowed |', '|---|---|---|---|---|---|'];
  for (const d of DOCS) {
    const cell = (v: string) => {
      const r = merged.get(`${d.id}-${v}`);
      return r ? `${r.accuracy.toFixed(1)} % (${r.withTashkeel.toFixed(1)} %)` : '–';
    };
    lines.push(`| ${d.label} | ${d.langs.join('+')} | ${VARIANTS.map(cell).join(' | ')} |`);
  }
  console.log(`\nCharacter accuracy, tashkeel removed (kept):\n${lines.join('\n')}\n`);
  if (process.env.OCR_BENCH_UPDATE) {
    for (const r of rows) baseline.corpus[r.id] = { accuracy: Math.floor(r.accuracy * 10) / 10 };
    fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  } else {
    // regression gate: every measured page stays within tolerance of its recorded floor
    const worse = rows.filter((r) => baseline.corpus[r.id] && r.accuracy < baseline.corpus[r.id]!.accuracy - baseline.tolerance);
    if (worse.length) throw new Error(`OCR accuracy regressed: ${worse.map((r) => `${r.id} ${r.accuracy.toFixed(1)} < ${baseline.corpus[r.id]!.accuracy}`).join(', ')}`);
  }
});
