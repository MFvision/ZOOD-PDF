import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export const corpus = (name: string): string =>
  fileURLToPath(new URL(`../../../tests/corpus/arabic/${name}`, import.meta.url));

/** A real Word 2016 Arabic export — the GATE 2 file. */
export const WORD_EXPORT = corpus(
  'realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf',
);

/** Dark pixels on a page canvas, sampled; zero means nothing was drawn. */
export async function ink(canvas: Locator): Promise<number> {
  return canvas.evaluate((node) => {
    const c = node as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx || c.width === 0 || c.height === 0) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 16) if ((data[i] ?? 255) < 128) dark += 1;
    return dark;
  });
}

/** Opens a PDF the way a person does, and waits until page 1 has real ink. */
export async function openPdf(page: Page, file: string): Promise<Locator> {
  await page.locator('input[type="file"]').setInputFiles(file);
  const first = page.locator('section[data-page="1"]');
  await expect(first).toBeVisible();
  await expect.poll(() => ink(first.locator('canvas.page-canvas'))).toBeGreaterThan(200);
  return first;
}
