import { expect } from '@playwright/test';
import { INVOICE, chooseTool, corpus, documentStatus, openPdf, pageOnScreen, test } from './helpers';

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

/**
 * Tab groups and tabs down the side, as a browser has them: a tab put in a
 * new group gets a name and a colour, another joins it, the group folds
 * away and opens again, a tab dragged along the bar moves, and the tabs go
 * down the side from a right click on the bar, and back.
 */
test('tabs gather in a named group, fold, move, and go down the side', async ({ page, stayLocal: _ }) => {
  await page.goto('/');
  await openPdf(page, corpus('generated/chrome-notonaskh-justified-3pages.pdf'));
  const tabs = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab');
  await page.locator('input[type="file"]').first().setInputFiles(corpus('generated/chrome-cairo-mixed-invoice.pdf'));
  await expect(tabs).toHaveCount(2);
  await page.locator('input[type="file"]').first().setInputFiles(INVOICE);
  await expect(tabs).toHaveCount(3);
  const names = () => page.locator('.tab:not(.tab-home) .tab-title').allTextContents();
  const [first, second, third] = await names();

  // A new group from the first tab: its editor opens to name it.
  await page.locator('.tab').filter({ hasText: first! }).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Add tab to a new group' }).click();
  const name = page.getByRole('textbox', { name: 'Name this group' });
  await expect(name).toBeFocused();
  await name.fill('Contracts');
  await page.getByRole('radio', { name: 'Green' }).click();
  await name.press('Enter');
  const chip = page.locator('[data-group-chip]');
  await expect(chip).toHaveText('Contracts');
  await expect(chip).toHaveAttribute('data-colour', 'green');

  // The third tab joins it, beside the first.
  await page.locator('.tab').filter({ hasText: third! }).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Add to group “Contracts”' }).click();
  await expect.poll(names).toEqual([first, third, second]);
  await expect(page.locator('.tab.in-group')).toHaveCount(2);

  // Folded, only the tab on screen of the group stays; opened again, both.
  await chip.click();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.tab.in-group')).toHaveCount(1);
  await chip.click();
  await expect(page.locator('.tab.in-group')).toHaveCount(2);

  // The last tab dragged before the first: it moves there, outside the group.
  const from = (await page.locator('.tab').filter({ hasText: second! }).locator('.tab-name').boundingBox())!;
  const to = (await page.locator('.tab').filter({ hasText: first! }).locator('.tab-name').boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x - 30, from.y + from.height / 2, { steps: 4 });
  // Before the group's label, not inside the group: on the label's own side of the first tab.
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(names).toEqual([second, first, third]);
  await expect(page.locator('.tab.in-group')).toHaveCount(2);

  // Down the side from the bar's own menu, and back to the top.
  await page.locator('.tab').filter({ hasText: first! }).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Show tabs down the side' }).click();
  await expect(page.locator('.tab-bar-side')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Open documents' })).toHaveAttribute('aria-orientation', 'vertical');
  await page.locator('.tab-bar-side .tab').first().click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Show tabs along the top' }).click();
  await expect(page.locator('.tab-bar-side')).toHaveCount(0);
  await expect(tabs).toHaveCount(3);
});

/**
 * The page a tab was left on is the page shown when it comes back, not only
 * the page the box says: EmbedPDF reports a page it is sent to at once, and
 * a file still coming on screen was sent there before its opening zoom,
 * which put the view back on page 1 (Ship's check of 0.4.36, a tab reopened
 * at start). Read from where the pages are scrolled to.
 */
test('a tab comes back on the page it was left on, really shown', async ({ page, stayLocal: _ }) => {
  await page.goto('/');
  await openPdf(page, corpus('generated/perf-text-100-pages.pdf'));
  await expect(documentStatus(page)).toContainText('Page 1 of 100');
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Go to page…' }).click();
  await page.getByLabel('Page number (1–100)').fill('40');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect.poll(() => pageOnScreen(page, 100), { timeout: 15_000 }).toBe(40);

  const tabs = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab');
  await page.locator('input[type="file"]').first().setInputFiles(INVOICE);
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(documentStatus(page)).toContainText('Page 40 of 100', { timeout: 15_000 });
  await expect.poll(() => pageOnScreen(page, 100), { timeout: 15_000 }).toBe(40);
  // And it stays there once the view has settled.
  await page.waitForTimeout(1500);
  expect(await pageOnScreen(page, 100)).toBe(40);
});
