import { copyFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, chooseTool, embedTiles, openPdf, pageBox, pendingRedactions, test, useAction } from './helpers';

/**
 * The home screen's recent grid shows a small picture of each file's first
 * page, kept in this browser's storage. It must never keep what the person
 * redacted or protected: a review found the picture of page 1 as it was
 * before a redaction, a page deletion or a password, still on the home
 * screen after the file was saved over.
 */

const NAME = basename(INVOICE);

/** The pictures the app keeps, by file name. */
const pictures = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('warraq.recentThumbs') ?? '{}') as Record<string, string>);

const kept = async (page: Page, name: string) => name in (await pictures(page));

async function closeDocument(page: Page) {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Close document' }).click();
  await expect(page.locator('.home')).toBeVisible();
}

/** Closes every open tab, back to the home screen. */
async function closeAll(page: Page) {
  const tabs = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab');
  for (let open = await tabs.count(); open > 1; open -= 1) {
    await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Close document' }).click();
    await expect(tabs).toHaveCount(open - 1);
  }
  await closeDocument(page);
}

/** The tile of a recent file on the home screen. */
const tile = (page: Page, name: string) =>
  page.locator('.recent-item', { has: page.locator('.recent-name', { hasText: name.replace(/\.pdf$/i, '') }) });

test('a picture is kept of a plain file’s first page, and forgotten the moment anything is marked for redaction', async ({
  page,
  stayLocal: _,
}) => {
  await page.goto('/');
  await openPdf(page, INVOICE);
  await expect.poll(() => kept(page, NAME)).toBe(true);

  await chooseTool(page, 'Redact');
  await useAction(page, 'Mark an area');
  const box = await pageBox(page);
  await page.mouse.move(box.x + box.width * 0.02, box.y + box.height * 0.03);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.98, box.y + box.height * 0.16, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => pendingRedactions(page)).toBeGreaterThan(0);
  // Marked, not yet applied: the picture of what is under the mark is gone already.
  await expect.poll(() => kept(page, NAME)).toBe(false);

  await page.locator('.pane-end').getByRole('button', { name: 'Apply redactions', exact: true }).click();
  await expect.poll(() => pendingRedactions(page)).toBe(0);
  // Applied but not saved: closing asks first, and this closes without saving.
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Close document' }).click();
  await page.getByRole('dialog', { name: 'Save the changes?' }).getByRole('button', { name: 'Close without saving' }).click();
  await expect(page.locator('.home')).toBeVisible();
  await expect(tile(page, NAME)).toBeVisible();
  await expect(tile(page, NAME).locator('img')).toHaveCount(0);
  expect(await kept(page, NAME)).toBe(false);
});

test('saving forgets the picture, and a file that needs a password never gets one — opening it forgets the old one', async ({
  page,
  stayLocal: _,
}) => {
  const password = 'recent-2026';
  await page.goto('/');
  await openPdf(page, INVOICE);
  await expect.poll(() => kept(page, NAME)).toBe(true);

  await chooseTool(page, 'Protect');
  await page.locator('.pane-end').getByRole('button', { name: 'Set a password', exact: true }).click();
  await page.getByRole('checkbox', { name: /Require password to open/ }).check();
  await page.getByRole('textbox', { name: 'Enter password' }).fill(password);
  await page.getByRole('textbox', { name: 'Confirm password' }).fill(password);
  await page.getByRole('button', { name: 'Apply Protection' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  // The saved file is protected, and may no longer look like the picture.
  await expect.poll(() => kept(page, NAME)).toBe(false);

  // The protected copy, under the same name, after the plain one left a picture again.
  mkdirSync('test-results/recent', { recursive: true });
  const protectedCopy = `test-results/recent/${NAME}`;
  await download.saveAs(`test-results/recent/saved-${NAME}`);
  copyFileSync(`test-results/recent/saved-${NAME}`, protectedCopy);
  await page.goto('/');
  await openPdf(page, INVOICE);
  await expect.poll(() => kept(page, NAME)).toBe(true);
  await page.locator('input.sr-only[type="file"]').setInputFiles(protectedCopy);
  const prompt = page.getByRole('dialog', { name: 'Password required' });
  await prompt.getByLabel('Password').fill(password);
  await prompt.getByRole('button', { name: 'Open' }).click();
  await expect(prompt).toBeHidden();
  await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
  await expect.poll(() => kept(page, NAME)).toBe(false);
  // The protected copy opened in a second tab, beside the plain one.
  await closeAll(page);
  await expect(tile(page, NAME).locator('img')).toHaveCount(0);
});
