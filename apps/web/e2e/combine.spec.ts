import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  WORD_EXPORT,
  chooseTool,
  corpus,
  embedDocument,
  enterEditText,
  openPdf,
  test,
} from './helpers';

const THREE = corpus('generated/chrome-notonaskh-justified-3pages.pdf');
const LOCKED = corpus('generated/variant-encrypted-aes256.pdf');

const panel = (page: Page) => page.locator('.pane-end');
const files = (page: Page) =>
  panel(page).getByRole('list', { name: 'Files to combine' }).getByRole('listitem');
const statusBar = (page: Page) => page.getByRole('contentinfo', { name: 'Status bar' });

/** The start of page `n`'s text, as Warraq's own reader sees it in Edit text. */
async function pageStart(page: Page, n: number): Promise<string> {
  const layer = page.locator(`section[data-page="${n}"] .text-layer`);
  await layer.scrollIntoViewIfNeeded();
  await expect(layer).not.toBeEmpty();
  return ((await layer.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

/** Drags `paths` over the window and drops them there, as a person does from Finder. */
async function dropFiles(page: Page, paths: string[], release = true) {
  const files = paths.map((path) => ({
    name: path.split('/').pop()!,
    bytes: [...readFileSync(path)],
  }));
  await page.evaluate(
    ({ files, release }) => {
      const transfer = new DataTransfer();
      for (const f of files)
        transfer.items.add(
          new File([new Uint8Array(f.bytes)], f.name, { type: 'application/pdf' }),
        );
      const fire = (type: string) =>
        window.dispatchEvent(
          new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      fire('dragenter');
      fire('dragover');
      if (release) fire('drop');
    },
    { files, release },
  );
}

test.describe('Combine files makes one file of several', () => {
  test('a PDF dropped on the window opens', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await dropFiles(page, [THREE]);
    await expect(statusBar(page)).toContainText('Page 1 of 3');
  });

  test('with Combine open, dropped PDFs join its list and the open file stays', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await chooseTool(page, 'Combine');
    await expect(files(page)).toHaveCount(1);
    await dropFiles(page, [THREE], false);
    await expect(page.locator('.drop-overlay')).toContainText('Drop PDFs to add them to the list');
    await dropFiles(page, [THREE, LOCKED]);
    await expect(files(page)).toHaveCount(3);
    await expect(files(page).nth(1)).toContainText('3 pages');
    await expect(statusBar(page)).toContainText('Page 1 of 2');
  });

  test('from the home screen: add, reorder, combine, and the pages follow in that order', async ({
    page,
    stayLocal: _,
  }) => {
    // What the first pages of each file read, for checking the result.
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await enterEditText(page);
    const word = await pageStart(page, 1);
    await page.goto('/');
    await openPdf(page, THREE);
    await enterEditText(page);
    const three = await pageStart(page, 1);

    await page.goto('/');
    await page.locator('.tool-cards-grid .tool-card', { hasText: 'Combine' }).click();
    await panel(page).locator('input[type="file"]').setInputFiles([THREE, WORD_EXPORT]);
    await expect(files(page)).toHaveCount(2);
    await expect(files(page).nth(0)).toContainText('3 pages');
    await expect(files(page).nth(1)).toContainText('2 pages');

    // The Word export first.
    await panel(page)
      .getByRole('button', { name: /^Move A_worldbank.* earlier$/ })
      .click();
    await expect(files(page).nth(0)).toContainText('A_worldbank');
    await panel(page).getByRole('button', { name: 'Combine 5 pages' }).click();

    await expect(statusBar(page)).toContainText('Page 1 of 5');
    await expect.poll(async () => (await embedDocument(page)).pages).toBe(5);
    await enterEditText(page);
    expect(await pageStart(page, 1)).toBe(word);
    expect(await pageStart(page, 3)).toBe(three);
  });

  test('starts with the open file, and opens a protected one with its password', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, THREE);
    await chooseTool(page, 'Combine');
    await expect(files(page)).toHaveCount(1);
    await expect(files(page).nth(0)).toContainText('3 pages');
    await panel(page).locator('input[type="file"]').setInputFiles(LOCKED);
    await expect(files(page)).toHaveCount(2);
    const locked = files(page).nth(1);
    await expect(
      panel(page)
        .getByRole('button', { name: /^Combine/ })
        .last(),
    ).toBeDisabled();

    await locked.getByLabel(/Password for/).fill('not-it');
    await locked.getByRole('button', { name: 'Unlock' }).click();
    await expect(locked.getByRole('alert')).toBeVisible();
    await locked.getByLabel(/Password for/).fill('warraq');
    await locked.getByRole('button', { name: 'Unlock' }).click();
    await expect(locked).toContainText('3 pages');

    await panel(page).getByRole('button', { name: 'Combine 6 pages' }).click();
    await expect(statusBar(page)).toContainText('Page 1 of 6');
    await expect.poll(async () => (await embedDocument(page)).pages).toBe(6);
  });
});
