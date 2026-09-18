import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, corpus, enterEditText, openPdf, test } from './helpers';

const panel = (page: Page) => page.locator('.pane-end');
const outcome = (page: Page) => panel(page).locator('[role="status"]').last();

/** How many of the truth's Arabic words the text layer holds. */
function share(text: string, name: string): number {
  const truth = readFileSync(`../../tests/corpus/arabic/truth/${name}.txt`, 'utf8');
  const words = [...new Set(truth.split(/[\s|:،.()—؟]+/).filter((w) => /[؀-ۿ]/.test(w) && w.length >= 3))];
  return words.filter((w) => text.includes(w)).length / words.length;
}

async function recognize(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await openPdf(page, corpus(`generated/${name}.pdf`));
  await chooseTool(page, 'Scan & OCR');
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

  test('a 300 dpi Arabic scan reads almost word for word, and the layer is saved', async ({ page, stayLocal: _ }) => {
    const name = 'scan-notonaskh-300dpi-skewed-jpeg';
    const text = await recognize(page, name);
    // Measured 130 of 138 (94 %); diacritics are what it misses.
    expect(share(text, name)).toBeGreaterThan(0.85);

    // Saved, and read back from the file: the layer is in it.
    const saved = await saveAs(page, 'test-results/ocr-saved.pdf');
    expect(saved.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await page.goto('/');
    await openPdf(page, 'test-results/ocr-saved.pdf');
    const reopened = await enterEditText(page);
    expect(share((await reopened.locator('.text-layer').textContent()) ?? '', name)).toBeGreaterThan(0.85);

    // A second run finds nothing left to read.
    await chooseTool(page, 'Scan & OCR');
    await panel(page).getByRole('button', { name: 'Recognize text', exact: true }).click();
    await expect(outcome(page)).toContainText('No page needed recognizing');
  });

  test('a 200 dpi black-and-white scan of an invoice', async ({ page, stayLocal: _ }) => {
    const name = 'scan-arial-200dpi-bilevel';
    // Measured 20 of 30: Tesseract's layout analysis skips the table rows.
    expect(share(await recognize(page, name), name)).toBeGreaterThan(0.55);
  });
});
