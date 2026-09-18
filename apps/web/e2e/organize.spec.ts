import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, corpus, embedDocument, embedTiles, enterEditText, openPdf, test } from './helpers';

const THREE = corpus('generated/chrome-notonaskh-justified-3pages.pdf');

const grid = (page: Page) => page.getByRole('listbox', { name: 'Pages' });
const tile = (page: Page, n: number) => grid(page).getByRole('option', { name: `Page ${n}`, exact: true });
const control = (page: Page, name: string) => page.locator('.pane-end').getByRole('button', { name, exact: true });
const statusBar = (page: Page) => page.getByRole('contentinfo', { name: 'Status bar' });

/** The start of page `n`'s text, as Warraq's own reader sees it in Edit text. */
async function pageStart(page: Page, n: number): Promise<string> {
  const layer = page.locator(`section[data-page="${n}"] .text-layer`);
  await layer.scrollIntoViewIfNeeded();
  await expect(layer).not.toBeEmpty();
  return ((await layer.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

async function saveAs(page: Page, name: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const path = `test-results/${name}-${download.suggestedFilename()}`;
  await download.saveAs(path);
  return path;
}

test.describe('Organize pages changes the file, not just the grid', () => {
  test('move, rotate, delete, insert, undo and redo; the saved file has the new pages', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, THREE);
    await enterEditText(page);
    const original = [await pageStart(page, 1), await pageStart(page, 2), await pageStart(page, 3)];
    expect(new Set(original).size).toBe(3);

    const before = await embedDocument(page);
    await chooseTool(page, 'Organize pages');
    await expect(grid(page).getByRole('option')).toHaveCount(3);

    // The last page to the front, one step at a time: 3, 1, 2.
    await tile(page, 3).click();
    await control(page, 'Move earlier').click();
    await expect(tile(page, 2)).toHaveAttribute('aria-selected', 'true');
    await control(page, 'Move earlier').click();
    await expect(tile(page, 1)).toHaveAttribute('aria-selected', 'true');

    // Turn it a quarter: the portrait page becomes landscape.
    await control(page, 'Rotate clockwise').click();
    await expect
      .poll(async () => {
        const box = await tile(page, 1).locator('canvas').boundingBox();
        return box ? box.width > box.height : false;
      })
      .toBe(true);

    // Delete what was page 1, now second: 3, 2.
    await tile(page, 2).click();
    await control(page, 'Delete').click();
    await expect(grid(page).getByRole('option')).toHaveCount(2);

    // A blank page after the first, then undo it, redo it, and undo it again.
    await tile(page, 1).click();
    await control(page, 'Insert a blank page').click();
    await expect(grid(page).getByRole('option')).toHaveCount(3);
    await control(page, 'Undo').click();
    await expect(grid(page).getByRole('option')).toHaveCount(2);
    await control(page, 'Redo').click();
    await expect(grid(page).getByRole('option')).toHaveCount(3);
    await page.keyboard.press('ControlOrMeta+Z');
    await expect(grid(page).getByRole('option')).toHaveCount(2);

    // Done: EmbedPDF reopens the file with its new pages — a new document, not
    // the old one still on screen — and that is what gets saved.
    await control(page, 'Done').click();
    await expect(statusBar(page)).toContainText('Page 1 of 2');
    await expect.poll(async () => (await embedDocument(page)).pages).toBe(2);
    expect((await embedDocument(page)).id).not.toBe(before.id);
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    const saved = await saveAs(page, 'organized');

    await page.goto('/');
    await openPdf(page, saved);
    await expect(statusBar(page)).toContainText('Page 1 of 2');
    const first = await enterEditText(page);
    expect(await pageStart(page, 1)).toBe(original[2]);
    expect(await pageStart(page, 2)).toBe(original[1]);
    const box = await first.boundingBox();
    expect(box && box.width > box.height, 'the first page stays turned').toBe(true);
  });

  test('extracting chosen pages writes a new file and leaves the open one alone', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, THREE);
    await enterEditText(page);
    const original = [await pageStart(page, 1), await pageStart(page, 2), await pageStart(page, 3)];

    await chooseTool(page, 'Organize pages');
    await tile(page, 1).click();
    await tile(page, 3).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('.pane-end [role="status"]')).toContainText('2 of 3');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      control(page, 'Extract as a new file').click(),
    ]);
    expect(download.suggestedFilename()).toBe('chrome-notonaskh-justified-3pages (1, 3).pdf');
    const extracted = 'test-results/extracted.pdf';
    await download.saveAs(extracted);
    expect(readFileSync(extracted).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await expect(grid(page).getByRole('option')).toHaveCount(3);

    await page.goto('/');
    await openPdf(page, extracted);
    await expect(statusBar(page)).toContainText('Page 1 of 2');
    await enterEditText(page);
    expect(await pageStart(page, 1)).toBe(original[0]);
    expect(await pageStart(page, 2)).toBe(original[2]);
  });
});
