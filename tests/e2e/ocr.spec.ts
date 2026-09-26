import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium, expect, test, type Page } from '@playwright/test';
import { fixture, fixtureBytes, openViaCard, pickTool, ROOT, savedFiles, stubSavePicker, trackExternalRequests, waitForDocument, writeTemp } from './helpers';
import { addScanImages, createScanPdf, openScanFromPlus, pickLanguages } from '../ocr/benchmark/drive';
import { engineCall, plainText } from '../ocr/benchmark/engine';
import { score } from '../ocr/benchmark/score';

/** Measured accuracy floors for the two small e2e pages (tests/ocr/baseline.json, "e2e" section). */
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/ocr/baseline.json'), 'utf8')) as {
  e2e: Record<string, { accuracy: number }>;
  tolerance: number;
};
const TRUTH = fs.readFileSync(fixture('ocr/truth-ar.txt'), 'utf8');

test.describe.configure({ timeout: 420_000 });

function cspErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => /Content Security Policy|Refused/.test(e.message) && errors.push(e.message));
  return errors;
}

/** Ctrl+F in the viewer opens EmbedPDF's search pane; returns the number of hits it reports. */
async function viewerSearch(page: Page, query: string): Promise<number> {
  const box = (await page.locator('[data-testid=document-view]:visible .viewer-area').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
  await page.keyboard.press('Control+f');
  const input = page.locator('[data-testid=document-view]:visible embedpdf-container').locator('input[placeholder]').first();
  await expect(input).toBeVisible();
  await input.fill(query);
  await input.press('Enter');
  let hits = 0;
  await expect
    .poll(
      async () => {
        hits = await page.evaluate(() => {
          const root = document.querySelector('[data-testid=document-view]:not([hidden]) embedpdf-container')?.shadowRoot;
          const text = root?.textContent ?? '';
          // "3 results found" (en) / "النتائج: 3" (ar); digits may be Arabic-Indic
          const m = text.match(/([0-9\u0660-\u0669]+)\s*results? found/i) ?? text.match(/النتائج:\s*([0-9\u0660-\u0669]+)/);
          return m ? Number(m[1]!.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660))) : 0;
        });
        return hits;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  return hits;
}

test.describe('Scan & OCR', () => {
  test('makes a scanned Arabic PDF searchable: viewer search finds the word, the saved file reads back', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ar-SA' });
    await stubSavePicker(context);
    const page = await context.newPage();
    const external = trackExternalRequests(page);
    const csp = cspErrors(page);
    await page.goto('/');
    await openViaCard(page, fixture('ocr/scan-ar.pdf'));
    const original = fixtureBytes('ocr/scan-ar.pdf');
    expect((await plainText(original)).text.trim()).toBe('');

    await pickTool(page, 'scan');
    await expect(page.locator('[data-ocr-tab=searchable]')).toHaveAttribute('aria-selected', 'true');
    // Arabic interface → Arabic model by default; Arabic-Indic digits in the count
    await expect(page.locator('[data-testid=ocr-langs] [data-lang=ar]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid=ocr-missing]')).toContainText('صفحة واحدة بلا نص');
    await expect(page.locator('[data-testid=ocr-missing]')).toContainText('١');
    await page.locator('[data-testid=ocr-start]').click();
    await expect(page.locator('[data-testid=ocr-progress]')).toContainText('الصفحة ١');
    await expect(page.locator('[data-testid=ocr-searchable]')).toHaveCount(0, { timeout: 300_000 });
    await expect(page.locator('.hud')).toContainText('أُضيف النص إلى صفحة واحدة');
    await waitForDocument(page);
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toContainText('معدَّل');

    // PDFium (the viewer) reads the invisible text layer: Ctrl+F finds an Arabic word.
    expect(await viewerSearch(page, 'الحكومية')).toBeGreaterThanOrEqual(1);

    await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [saved] = await savedFiles(page);
    const bytes = saved!.bytes;
    // incremental: the original scan is an exact prefix, one update appended
    expect(bytes.subarray(0, original.length).equals(original)).toBe(true);
    expect(bytes.length).toBeGreaterThan(original.length);
    expect(bytes.toString('latin1')).not.toContain('/Direction');
    const info = await engineCall<{ revisions: number; pageCount: number }>(bytes, 'doc.info');
    expect(info.revisions).toBe(2);

    // reopen the saved bytes with the engine: logical-order Arabic text
    const text = (await plainText(bytes)).text;
    expect(text).toContain('الحكومية');
    expect(text).toContain('التحول');
    const s = score(text, TRUTH);
    console.log(`[ocr accuracy] scan-ar: ${s.accuracy.toFixed(2)} %`);
    test.info().annotations.push({ type: 'accuracy', description: `scan-ar straight: ${s.accuracy.toFixed(2)} % (with tashkeel ${s.withTashkeel.toFixed(2)} %)` });
    expect(s.accuracy).toBeGreaterThanOrEqual(baseline.e2e['scan-ar']!.accuracy - baseline.tolerance);

    // and in the interface
    const reopened = writeTemp('scan-ar-searchable.pdf', bytes);
    await page.locator('[data-testid=document-view]:visible').getByRole('button', { name: 'الرئيسية' }).click();
    await openViaCard(page, reopened);
    await expect(page.locator('[data-testid=document-view]:visible .doc-name')).toHaveText('scan-ar-searchable.pdf');
    expect(await viewerSearch(page, 'التحول')).toBeGreaterThanOrEqual(1);

    expect(csp).toEqual([]);
    expect(external).toEqual([]);
    await context.close();
  });

  test('scans a crooked photo: skew ≈ 8° detected and a searchable PDF is created', async ({ context, page }) => {
    await stubSavePicker(context);
    const external = trackExternalRequests(page);
    const csp = cspErrors(page);
    await page.goto('/');
    await openScanFromPlus(page, 'scan');
    await pickLanguages(page, ['ar']);
    const [angle] = await addScanImages(page, [fixture('ocr/crooked8-ar.jpg')]);
    expect(Math.abs(angle! - 8)).toBeLessThan(0.5);
    await expect(page.locator('[data-testid=scan-angle]').first()).toContainText(/Skew detected: 8\.\d°/);
    await expect(page.locator('[data-testid=scan-cleaned]')).toBeVisible();

    await createScanPdf(page);
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toHaveText(/Page 1 of 1/);
    await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [saved] = await savedFiles(page);
    const bytes = saved!.bytes;
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const info = await engineCall<{ pageCount: number }>(bytes, 'doc.info');
    expect(info.pageCount).toBe(1);
    const latin = bytes.toString('latin1');
    expect(latin).toMatch(/\/Subtype\s*\/Image/);
    expect(latin).toMatch(/\/Lang\s*\(ar\)/);
    const text = (await plainText(bytes)).text;
    expect(text).toContain('التحول');
    const s = score(text, TRUTH);
    console.log(`[ocr accuracy] crooked8-ar: ${s.accuracy.toFixed(2)} %`);
    test.info().annotations.push({ type: 'accuracy', description: `crooked8-ar: ${s.accuracy.toFixed(2)} % (with tashkeel ${s.withTashkeel.toFixed(2)} %)` });
    expect(s.accuracy).toBeGreaterThanOrEqual(baseline.e2e['crooked8-ar']!.accuracy - baseline.tolerance);
    expect(csp).toEqual([]);
    expect(external).toEqual([]);
  });

  test('cancel stops recognition and leaves the document unchanged', async ({ page }) => {
    await page.goto('/');
    await openViaCard(page, fixture('ocr/scan-ar.pdf'));
    await pickTool(page, 'scan');
    await page.locator('[data-testid=ocr-start]').click();
    await expect(page.locator('[data-testid=ocr-progress]')).toBeVisible();
    await page.locator('[data-testid=ocr-cancel]').click();
    await expect(page.locator('.hud')).toContainText('Recognition cancelled');
    await expect(page.locator('[data-testid=ocr-progress]')).toHaveCount(0);
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).not.toContainText('Edited');
  });

  test('refuses images above the size cap before decoding them', async ({ page }) => {
    await page.goto('/');
    await openScanFromPlus(page, 'scan');
    // a PNG header claiming 30000 × 30000 pixels
    const png = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(png);
    png.writeUInt32BE(30000, 16);
    png.writeUInt32BE(30000, 20);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-testid=scan-choose]').click()]);
    await chooser.setFiles({ name: 'huge.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('.hud')).toContainText('too large');
    await expect(page.locator('[data-testid=scan-item]')).toHaveCount(0);
  });
});

test.describe('Scan & OCR in the Chrome MV3 extension', () => {
  const EXT = path.join(ROOT, 'apps/extension/dist');
  test.beforeAll(() => {
    if (!fs.existsSync(path.join(EXT, 'ocr/worker.min.js'))) execSync('pnpm -C apps/extension build', { cwd: ROOT, stdio: 'inherit' });
  });

  test('recognises a scan under the extension CSP (no blob: worker, no eval)', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zood-ext-ocr-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    try {
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const id = new URL(sw.url()).host;
      const page = await context.newPage();
      const csp = cspErrors(page);
      const external = trackExternalRequests(page);
      await page.goto(`chrome-extension://${id}/index.html`);
      await openScanFromPlus(page, 'scan');
      await pickLanguages(page, ['ar']);
      const [angle] = await addScanImages(page, [fixture('ocr/crooked8-ar.jpg')]);
      expect(Math.abs(angle! - 8)).toBeLessThan(0.5);
      await createScanPdf(page);
      await waitForDocument(page);
      expect(csp).toEqual([]);
      expect(external).toEqual([]);
    } finally {
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
