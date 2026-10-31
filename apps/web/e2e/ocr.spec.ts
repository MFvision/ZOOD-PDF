import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, corpus, enterEditText, openPdf, test } from './helpers';

const panel = (page: Page) => page.locator('.pane-end');
const outcome = (page: Page) => panel(page).locator('[role="status"]').last();

/** How many of the truth's Arabic words the text layer holds. */
function share(text: string, name: string): number {
  const truth = readFileSync(`../../tests/corpus/arabic/truth/${name}.txt`, 'utf8');
  const words = [
    ...new Set(truth.split(/[\s|:،.()—؟]+/).filter((w) => /[؀-ۿ]/.test(w) && w.length >= 3)),
  ];
  return words.filter((w) => text.includes(w)).length / words.length;
}

/** The cleanup steps as the panel names them. */
const CLEANUP = ['Remove shadows and stains', 'Strengthen the contrast', 'Black and white', 'Remove specks', 'Remove dark borders'];

async function recognize(page: Page, name: string, cleanup: readonly string[] = [], replace = false): Promise<string> {
  await page.goto('/');
  await openPdf(page, corpus(`generated/${name}.pdf`));
  await chooseTool(page, 'Scan & OCR');
  // The choices are remembered: each run sets every one of them.
  for (const step of CLEANUP) await panel(page).getByRole('checkbox', { name: step }).setChecked(cleanup.includes(step));
  if (cleanup.length > 0) {
    await panel(page).getByRole('checkbox', { name: 'Put the cleaned-up picture in place of the scan' }).setChecked(replace);
  }
  await panel(page).getByRole('button', { name: 'Recognize text', exact: true }).click();
  await expect(outcome(page)).toContainText('Text layer added', { timeout: 180_000 });
  const first = await enterEditText(page);
  return (await first.locator('.text-layer').textContent()) ?? '';
}

async function saveAs(page: Page, path: string): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  await download.saveAs(path);
  return readFileSync(path);
}

test.describe('Scan & OCR gives scanned pages a text layer, on this device', () => {
  test.setTimeout(300_000);

  test('a 300 dpi Arabic scan reads almost word for word, and the layer is saved', async ({
    page,
    stayLocal: _,
  }) => {
    const name = 'scan-notonaskh-300dpi-skewed-jpeg';
    const text = await recognize(page, name);
    // Measured 130 of 138 (94 %); diacritics are what it misses.
    expect(share(text, name)).toBeGreaterThan(0.85);
    // Arabic and English are both ticked (the default): English is only read
    // where the Arabic reading failed, so the page's English words (PDF,
    // Acrobat…) are read and Arabic words no longer come back as English
    // nonsense (read with both models at once, Arabic pages got words like
    // "gull" and "LIA"); a misread "PDE" or so at most.
    const truth = readFileSync(`../../tests/corpus/arabic/truth/${name}.txt`, 'utf8');
    const english = (t: string) => t.match(/[A-Za-z][A-Za-z0-9.-]*/g) ?? [];
    const made = english(text).filter((w) => !english(truth).some((t) => t.includes(w.replace(/[.-]+$/, ''))));
    expect(made.length).toBeLessThanOrEqual(3);

    // Saved, and read back from the file: the layer is in it.
    const saved = await saveAs(page, 'test-results/ocr-saved.pdf');
    expect(saved.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await page.goto('/');
    await openPdf(page, 'test-results/ocr-saved.pdf');
    const reopened = await enterEditText(page);
    expect(
      share((await reopened.locator('.text-layer').textContent()) ?? '', name),
    ).toBeGreaterThan(0.85);

    // A second run finds nothing left to read.
    await chooseTool(page, 'Scan & OCR');
    await panel(page).getByRole('button', { name: 'Recognize text', exact: true }).click();
    await expect(outcome(page)).toContainText('No page needed recognizing');
  });

  test('a scan 8° crooked is straightened before it is read, and its lines read in order', async ({
    page,
    stayLocal: _,
  }) => {
    const name = 'scan-notonaskh-300dpi-crooked-8deg-jpeg';
    const text = await recognize(page, name);
    // Measured 127 of 137 (93 %) straightened; read as it was, 77 (56 %).
    expect(share(text, name)).toBeGreaterThan(0.85);
    // The layer is turned back with the page: a line comes back whole, in order.
    expect(text.replace(/\s+/g, ' ')).toContain('المصدر يعمل دون حساب');
  });

  test('a 200 dpi black-and-white scan of an invoice', async ({ page, stayLocal: _ }) => {
    const name = 'scan-arial-200dpi-bilevel';
    // Measured 20 of 30 when Tesseract found the lines itself (its layout
    // analysis skipped the table rows); found by the line finder, every row is read.
    const text = await recognize(page, name);
    console.log(`invoice: ${Math.round(share(text, name) * 100)} %`);
    expect(share(text, name)).toBeGreaterThan(0.8);
    // Its English is still read: in place of what the Arabic model could not read.
    expect(text).toContain('INV-2026-0042');
  });

  test('a shadowed, stained scan reads well as it is, and the cleaned picture can take its place', async ({
    page,
    stayLocal: _,
  }) => {
    const name = 'scan-notonaskh-300dpi-shadowed-stained-jpeg';
    const plain = share(await recognize(page, name), name);

    // Cleaned up, every step, the cleaned picture put in the scan's place.
    await page.goto('/');
    await openPdf(page, corpus(`generated/${name}.pdf`));
    await chooseTool(page, 'Scan & OCR');
    for (const step of CLEANUP) await panel(page).getByRole('checkbox', { name: step }).setChecked(true);
    await panel(page).getByRole('checkbox', { name: 'Put the cleaned-up picture in place of the scan' }).setChecked(true);
    // The preview shows the page on screen as it will be read.
    await panel(page).getByRole('button', { name: 'Preview on page 1' }).click();
    const preview = panel(page).getByRole('img', { name: 'Page 1, cleaned up as chosen' });
    await expect.poll(() => preview.evaluate((c) => (c as HTMLCanvasElement).width)).toBeGreaterThan(500);
    // Black and white, and the shadow gone: nearly every pixel is paper or ink, and most are paper.
    const shades = await preview.evaluate((node) => {
      const c = node as HTMLCanvasElement;
      const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let white = 0;
      let grey = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === 255) white += 1;
        else if (data[i] !== 0) grey += 1;
      }
      return { white: white / (data.length / 4), grey };
    });
    expect(shades.grey).toBe(0);
    expect(shades.white).toBeGreaterThan(0.85);

    await panel(page).getByRole('button', { name: 'Recognize text', exact: true }).click();
    await expect(outcome(page)).toContainText('Text layer added', { timeout: 180_000 });
    await expect(outcome(page)).toContainText('Pages whose picture was replaced by the cleaned-up one: 2.');
    const first = await enterEditText(page);
    const cleaned = share((await first.locator('.text-layer').textContent()) ?? '', name);
    console.log(`shadowed and stained scan, page 1: ${Math.round(plain * 100)} % plain, ${Math.round(cleaned * 100)} % cleaned up`);
    // Read as it was, it used to give 59 %: Tesseract's one threshold for the
    // page lost the shadowed lines. Each line is evened out on its own now.
    expect(plain).toBeGreaterThan(0.8);
    expect(cleaned).toBeGreaterThan(0.85);

    // Saved: the original bytes first, the cleaned pages at one bit a pixel after them.
    const original = readFileSync(corpus(`generated/${name}.pdf`));
    const saved = await saveAs(page, 'test-results/ocr-cleaned.pdf');
    expect(saved.subarray(0, original.length).equals(original)).toBe(true);
    expect(saved.subarray(original.length).toString('latin1')).toContain('/BitsPerComponent 1');
    await page.goto('/');
    await openPdf(page, 'test-results/ocr-cleaned.pdf');
    const reopened = await enterEditText(page);
    expect(share((await reopened.locator('.text-layer').textContent()) ?? '', name)).toBeGreaterThan(0.85);
  });
});
