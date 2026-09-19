import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  WORD_EXPORT,
  chooseTool,
  corpus,
  documentStatus,
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
const statusBar = (page: Page) => documentStatus(page);

/** The start of page `n`'s text, as Warraq's own reader sees it in Edit text. */
async function pageStart(page: Page, n: number): Promise<string> {
  const layer = page.locator(`section[data-page="${n}"] .text-layer`);
  await layer.scrollIntoViewIfNeeded();
  await expect(layer).not.toBeEmpty();
  return ((await layer.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

/**
 * Drags `paths` over the window and drops them there, as a person does from
 * Finder — over the centre of `onto`, when given, once the overlay shows it.
 */
async function dropFiles(page: Page, paths: string[], release = true, onto?: string) {
  const files = paths.map((path) => ({
    name: path.split('/').pop()!,
    bytes: [...readFileSync(path)],
  }));
  const fire = (types: string[], at: { x: number; y: number } | null) =>
    page.evaluate(
      ({ files, types, at }) => {
        const holder = window as unknown as { __transfer?: DataTransfer };
        if (types.includes('dragenter') || !holder.__transfer) {
          holder.__transfer = new DataTransfer();
          for (const f of files)
            holder.__transfer.items.add(
              new File([new Uint8Array(f.bytes)], f.name, { type: 'application/pdf' }),
            );
        }
        const dataTransfer = holder.__transfer;
        for (const type of types)
          window.dispatchEvent(
            new DragEvent(type, {
              dataTransfer,
              bubbles: true,
              cancelable: true,
              clientX: at?.x ?? 0,
              clientY: at?.y ?? 0,
            }),
          );
        if (types.includes('drop')) delete holder.__transfer;
      },
      { files, types, at },
    );
  if (!onto) {
    await fire(release ? ['dragenter', 'dragover', 'drop'] : ['dragenter', 'dragover'], null);
    return;
  }
  await fire(['dragenter', 'dragover'], null);
  const box = await page.locator(onto).boundingBox();
  if (!box) throw new Error(`${onto} is not on screen`);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await fire(['dragover'], at);
  if (release) await fire(['drop'], at);
}

test.describe('Combine files makes one file of several', () => {
  test('a PDF dropped on the window opens', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await dropFiles(page, [THREE]);
    await expect(statusBar(page)).toContainText('Page 1 of 3');
  });

  test('a PDF dropped on an open file joins it in Combine, not in its place', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await dropFiles(page, [THREE], false);
    const zones = page.locator('.drop-overlay-split .drop-zone');
    await expect(zones).toHaveCount(2);
    await expect(zones.first()).toContainText('Combine with');
    await expect(zones.first()).toHaveClass(/is-active/);
    await expect(zones.nth(1)).toContainText('Open instead');
    await dropFiles(page, [THREE], true, '.drop-zone:first-child');
    await expect(files(page)).toHaveCount(2);
    await expect(files(page).first()).toContainText('2 pages');
    await expect(files(page).nth(1)).toContainText('3 pages');
    await expect(statusBar(page)).toContainText('Page 1 of 2');
    // And the combined file has every page of both.
    await panel(page).getByRole('button', { name: 'Combine 5 pages' }).click();
    await expect(statusBar(page)).toContainText('Page 1 of 5');
  });

  test('several PDFs dropped on the open file all join it', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await dropFiles(page, [THREE, THREE]);
    await expect(files(page)).toHaveCount(3);
  });

  test('a PDF dropped on "Open instead" replaces the open file', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await dropFiles(page, [THREE], false, '.drop-zone-open');
    await expect(page.locator('.drop-zone-open')).toHaveClass(/is-active/);
    await dropFiles(page, [THREE], true, '.drop-zone-open');
    await expect(statusBar(page)).toContainText('Page 1 of 3');
    await expect(page.locator('.pane-end')).not.toContainText('Files to combine');
  });

  test('several PDFs dropped with nothing open go to Combine together', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await dropFiles(page, [THREE, WORD_EXPORT]);
    await expect(files(page)).toHaveCount(2);
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
