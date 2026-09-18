import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  WORD_EXPORT,
  annotationTypes,
  chooseTool,
  enterEditText,
  openPdf,
  pageBox,
  test,
  useAction,
} from './helpers';

/**
 * Save keeps the file's own bytes: what EmbedPDF changed is appended to them
 * as an update, as Warraq's own edits are — so a signature over them stays
 * valid, and a file nothing was done to comes back as it was.
 */

const original = () => readFileSync(WORD_EXPORT);

async function save(page: Page, name: string): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const path = `test-results/saving-${name}.pdf`;
  await download.saveAs(path);
  return readFileSync(path);
}

async function draw(page: Page): Promise<void> {
  await chooseTool(page, 'Comment');
  await useAction(page, 'Draw');
  const box = await pageBox(page);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => annotationTypes(page)).toContain(15);
}

const startsWith = (saved: Buffer, own: Buffer) => saved.subarray(0, own.length).equals(own);

test.describe('Save keeps the file’s own bytes', () => {
  test('a file nothing was done to is saved exactly as it was', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    const saved = await save(page, 'unchanged');
    expect(saved.equals(original())).toBe(true);
  });

  test('a drawing is appended after the file’s own bytes, and is there when it is reopened', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await draw(page);
    const saved = await save(page, 'drawing');
    expect(startsWith(saved, original()), 'the file’s own bytes first').toBe(true);
    expect(saved.length - original().length).toBeLessThan(20_000);
    await page.goto('/');
    await openPdf(page, 'test-results/saving-drawing.pdf');
    await expect.poll(() => annotationTypes(page)).toContain(15);
  });

  test('a drawing, then an edit in Edit text: both after the file’s own bytes', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await draw(page);
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    await expect(area).toBeVisible();
    await area.fill('عنوان جديد للخطاب');
    await area.press('ControlOrMeta+Enter');
    await expect(first.locator('.text-layer')).toContainText('عنوان جديد للخطاب');
    const saved = await save(page, 'drawing-and-edit');
    expect(startsWith(saved, original())).toBe(true);
    await page.goto('/');
    await openPdf(page, 'test-results/saving-drawing-and-edit.pdf');
    await expect.poll(() => annotationTypes(page)).toContain(15);
    const reopened = await enterEditText(page);
    await expect(reopened.locator('.text-layer')).toContainText('عنوان جديد للخطاب');
  });
});
