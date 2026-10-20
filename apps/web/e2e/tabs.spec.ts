import { expect } from '@playwright/test';
import { chooseTool, corpus, openPdf, test } from './helpers';

/**
 * Document tabs: a second PDF opens beside the first, and pages dragged
 * from Organize onto the other tab are copied to the end of its document.
 */
test('two PDFs open as tabs, and pages dragged onto a tab are copied there', async ({ page, stayLocal: _ }) => {
  await page.goto('/');
  await openPdf(page, corpus('generated/chrome-notonaskh-justified-3pages.pdf'));
  // With a document open, File → Open's input is the first of several.
  await page.locator('input[type="file"]').first().setInputFiles(corpus('generated/chrome-cairo-mixed-invoice.pdf'));
  const tabs = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await chooseTool(page, 'Organize');
  const tiles = page.locator('.organize-tile');
  await expect(tiles).toHaveCount(3);

  // Drag page 1 onto the other tab, with the pointer as a person does.
  const from = (await tiles.nth(0).boundingBox())!;
  const to = (await page.locator('[data-tab-drop]').first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 40, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await expect(page.locator('.organize-drag-ghost')).toHaveText('Pages: 1');
  await page.mouse.up();
  await expect(page.getByText('The pages were copied to the end of that document.', { exact: false })).toBeVisible();
  // The other tab is marked changed, and has the page at its end.
  await expect(tabs.nth(1)).toContainText('•');
  await tabs.nth(1).click();
  await expect(tiles).toHaveCount(2);
});
