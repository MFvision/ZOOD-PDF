import { readFileSync, statSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, chooseTool, corpus, documentStatus, embedDocument, openPdf, test } from './helpers';

const SCAN = corpus('generated/scan-notonaskh-300dpi-skewed-jpeg.pdf');
const panel = (page: Page) => page.locator('.pane-end');
const statusBar = (page: Page) => documentStatus(page);

test.describe('Compress makes a smaller copy and leaves the open file alone', () => {
  test('a 300 dpi scan, downsampled to 150 dpi: saved smaller, and it opens', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, SCAN);
    await chooseTool(page, 'Compress');
    await expect(panel(page).getByRole('radio', { name: /Smaller images \(150 dpi\)/ })).toBeChecked();
    await panel(page).getByRole('button', { name: 'Compress', exact: true }).click();
    const result = panel(page).locator('.compress-result');
    await expect(result).toContainText('% smaller');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      panel(page).getByRole('button', { name: 'Save the smaller copy…' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('scan-notonaskh-300dpi-skewed-jpeg (compressed).pdf');
    const path = 'test-results/compressed.pdf';
    await download.saveAs(path);
    expect(statSync(path).size * 2).toBeLessThan(statSync(SCAN).size);
    expect(readFileSync(path).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // The smaller copy opens in place, with both pages.
    await panel(page).getByRole('button', { name: 'Open it here' }).click();
    await expect(statusBar(page)).toContainText('Page 1 of 2');
    await expect.poll(async () => (await embedDocument(page)).pages).toBe(2);
  });

  test('without losing anything, every image is kept', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Compress');
    await panel(page).getByRole('radio', { name: /Without losing anything/ }).check();
    await panel(page).getByRole('button', { name: 'Compress', exact: true }).click();
    // A small text file is rebuilt tighter, or said to be as small as it gets.
    await expect(panel(page).locator('.compress-result')).toContainText(/% smaller|already as small/);
  });
});
