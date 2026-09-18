import { expect, test } from '@playwright/test';
import { WORD_EXPORT, ink, openPdf } from './helpers';

test.describe('the interface does what it shows', () => {
  test('the tool list admits which tools are not built yet', async ({ page }) => {
    await page.goto('/');
    // One list, not two: the tools pane used to repeat the grid beside it.
    await expect(page.locator('.tool-card')).toHaveCount(13);
    const grid = page.locator('.tool-cards-grid');
    await expect(grid.locator('.tool-card')).toHaveCount(13);
    // Tripwire: when a tool is built, this number has to change with it.
    await expect(grid.locator('.tool-card-pending')).toHaveCount(12);
    await expect(grid.locator('.tool-card-pending .tool-card-later')).toHaveCount(12);
  });

  test('opens an Arabic Word export and puts readable text on the page', async ({ page }) => {
    await page.goto('/');
    const first = await openPdf(page, WORD_EXPORT);
    await expect(first.locator('.text-layer')).toContainText('صباح الخير');
  });

  test('replaces a paragraph and the new text is on the page', async ({ page }) => {
    await page.goto('/');
    const first = await openPdf(page, WORD_EXPORT);
    await page.getByRole('toolbar').getByRole('button', { name: 'Edit text' }).click();
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    await expect(area).toBeVisible();
    const replacement = 'فقرة جديدة كتبها الاختبار';
    await area.fill(replacement);
    await area.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(first.locator('.text-layer')).toContainText(replacement);
  });

  test('adds a line of text where you click', async ({ page }) => {
    await page.goto('/');
    const first = await openPdf(page, WORD_EXPORT);
    await page.getByRole('toolbar').getByRole('button', { name: 'Edit text' }).click();
    // The control lives in the Edit panel of the tools pane.
    await page.getByRole('button', { name: 'Add text' }).click();
    const target = first.locator('.edit-place-target');
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    if (!box) throw new Error('no placement target');
    // Top margin, right-hand side — where an Arabic note would start. A point
    // relative to the element, so Playwright scrolls it into view first.
    await target.click({ position: { x: box.width * 0.8, y: box.height * 0.035 } });
    const input = page.getByRole('textbox', { name: 'New text' });
    await expect(input).toBeVisible();
    const note = 'ملاحظة أضافها الاختبار';
    await input.fill(note);
    await input.press('Enter');
    await expect(first.locator('.text-layer')).toContainText(note);
  });

  test('saves a file that reopens with the edit in it', async ({ page }) => {
    await page.goto('/');
    const first = await openPdf(page, WORD_EXPORT);
    const before = await ink(first.locator('canvas.page-canvas'));
    await page.getByRole('toolbar').getByRole('button', { name: 'Edit text' }).click();
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    const replacement = 'نص محفوظ في الملف';
    await area.fill(replacement);
    await area.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(first.locator('.text-layer')).toContainText(replacement);
    // The text layer updates before the canvas finishes redrawing.
    await expect.poll(() => ink(first.locator('canvas.page-canvas'))).not.toBe(before);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
    ]);
    const saved = await download.path();
    expect(saved).toBeTruthy();

    await page.goto('/');
    const reopened = await openPdf(page, saved as string);
    await expect(reopened.locator('.text-layer')).toContainText(replacement);
  });
});
