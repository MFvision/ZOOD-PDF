import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  WORD_EXPORT,
  annotationTypes,
  chooseTool,
  corpus,
  embedPage,
  enterEditText,
  openPdf,
  pageBox,
  test,
  useAction,
} from './helpers';

const THREE = corpus('generated/chrome-notonaskh-justified-3pages.pdf');
/** The same three pages, encrypted with the password "warraq". */
const LOCKED = corpus('generated/variant-encrypted-aes256.pdf');

const panel = (page: Page) => page.locator('.pane-end');
const results = (page: Page) => panel(page).getByRole('region', { name: 'Comparison results' });
const summary = (page: Page) => results(page).getByRole('status');
const compareButton = (page: Page) =>
  panel(page).getByRole('button', { name: 'Compare', exact: true });
const revisionList = (page: Page) =>
  panel(page).getByRole('group', { name: 'Revisions of this file' });

/** What the tests type over the Word export's title, a paragraph of two lines. */
const SENTENCE = 'هذه جملة جديدة كتبها اختبار المقارنة';
const WITH_TASHKEEL = 'هَذِهِ جُمْلَةٌ جَدِيدَةٌ كَتَبَهَا اخْتِبَارُ الْمُقَارَنَةِ';
/** Words of that title: "كلمة رئيس مجموعة البنك الدولي ديفيد مالباس في جلسة …". */
const TITLE_WORDS = 'ديفيد مالباس';

/**
 * Makes a changed version the way a person does: opens `file`, types `text`
 * over its first paragraph in Edit text, and saves. Returns the saved file.
 */
async function editAndSave(page: Page, file: string, text: string, name: string): Promise<string> {
  await page.goto('/');
  await openPdf(page, file);
  const first = await enterEditText(page);
  await first.locator('.edit-box').first().click();
  const area = first.locator('.paragraph-editor-area');
  await expect(area).toBeVisible();
  await area.fill(text);
  await area.press('ControlOrMeta+Enter');
  await expect(first.locator('.text-layer')).toContainText(text.split(' ').slice(0, 2).join(' '));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const path = `test-results/compare-${name}.pdf`;
  await download.saveAs(path);
  return path;
}

test.describe('Compare shows what changed in the text, for Arabic', () => {
  test('a saved edit against the file’s own earlier revision', async ({ page, stayLocal: _ }) => {
    const saved = await editAndSave(page, WORD_EXPORT, SENTENCE, 'sentence');
    await page.goto('/');
    await openPdf(page, saved);
    await chooseTool(page, 'Compare');
    await expect(
      panel(page).getByRole('radio', { name: 'An earlier revision of it' }),
    ).toBeChecked();
    // Every save before the edit is offered, and the latest one is chosen.
    await expect(revisionList(page).getByRole('radio').last()).toBeChecked();
    await expect(revisionList(page)).toContainText(/Revision \d+ is the file as it stands now\./);
    await compareButton(page).click();

    await expect(summary(page)).toContainText('Pages changed: 1');
    await expect(summary(page)).toContainText('Words added: 6');
    await expect(results(page).getByRole('heading', { name: 'Page 1', exact: true })).toBeVisible();
    await expect(results(page).getByRole('heading', { name: 'Page 2', exact: true })).toHaveCount(
      0,
    );
    await expect(results(page).locator('ins', { hasText: SENTENCE })).toHaveCount(1);
    await expect(results(page).locator('del', { hasText: TITLE_WORDS })).toHaveCount(1);
    // Each passage finds its own direction: Arabic runs right to left.
    const passage = results(page).locator('.compare-passage').first();
    await expect(passage).toHaveAttribute('dir', 'auto');
    expect(await passage.evaluate((element) => getComputedStyle(element).direction)).toBe('rtl');

    // Go to page brings the changed page back into view.
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Go to page…' }).click();
    await page.getByLabel('Page number (1–2)').fill('2');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect.poll(() => embedPage(page)).toBe(2);
    await results(page).getByRole('button', { name: 'Go to page 1' }).click();
    await expect.poll(() => embedPage(page)).toBe(1);

    // The report: one small page, UTF-8, no script, the same marks.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      panel(page).getByRole('button', { name: 'Save the comparison (HTML)…' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('compare-sentence (comparison).html');
    const html = readFileSync((await download.path()) as string, 'utf8');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toMatch(new RegExp(`<ins><span[^>]*>added: </span>${SENTENCE}<`));
    expect(html).toMatch(new RegExp(`<del><span[^>]*>removed: </span>[^<]*${TITLE_WORDS}`));
    expect(html).toContain('<p dir="auto">');
    expect(html).not.toMatch(/<script|\shref=/i);
    // Its only pictures are its own: the pages that look different, drawn into it.
    for (const [, src] of html.matchAll(/\ssrc="([^"]*)"/g))
      expect(src).toMatch(/^data:image\/png;base64,/);
  });

  test('the original against the saved edit chosen as another PDF: the same change', async ({
    page,
    stayLocal: _,
  }) => {
    const saved = await editAndSave(page, WORD_EXPORT, SENTENCE, 'chosen');
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await chooseTool(page, 'Compare');
    // The Word export was saved in one piece, and the panel says so.
    await expect(panel(page)).toContainText('This file has only one revision');
    await expect(compareButton(page)).toBeDisabled();

    await panel(page).getByRole('radio', { name: 'Another PDF' }).check();
    await panel(page).locator('input[type="file"]').setInputFiles(saved);
    await expect(panel(page).locator('.compare-file')).toContainText('compare-chosen.pdf');
    await expect(panel(page).locator('.compare-file')).toContainText('Pages: 2');
    await compareButton(page).click();

    await expect(summary(page)).toContainText('Pages changed: 1');
    await expect(results(page).getByRole('heading', { name: 'Page 1', exact: true })).toBeVisible();
    await expect(results(page).locator('ins', { hasText: SENTENCE })).toHaveCount(1);
    await expect(results(page).locator('del', { hasText: TITLE_WORDS })).toHaveCount(1);

    // Either file can be the older one.
    await panel(page).getByRole('button', { name: 'Swap older and newer' }).click();
    await expect(results(page).locator('del', { hasText: SENTENCE })).toHaveCount(1);
    await expect(results(page).locator('ins', { hasText: TITLE_WORDS })).toHaveCount(1);
  });

  test('with diacritics ignored, a version that differs only in tashkeel shows no change', async ({
    page,
    stayLocal: _,
  }) => {
    const plain = await editAndSave(page, WORD_EXPORT, SENTENCE, 'plain');
    const marked = await editAndSave(page, plain, WITH_TASHKEEL, 'tashkeel');
    await page.goto('/');
    await openPdf(page, marked);
    await chooseTool(page, 'Compare');
    // The latest earlier revision is the plain sentence, saved just before.
    await expect(revisionList(page).getByRole('radio').last()).toBeChecked();
    await compareButton(page).click();

    // Counted exactly, the marks are a change…
    await expect(summary(page)).toContainText('Pages changed: 1');
    await expect(results(page).locator('ins', { hasText: 'جُمْلَةٌ' })).toHaveCount(1);
    // …and with diacritics ignored there is none.
    await panel(page).getByRole('checkbox', { name: 'Ignore diacritics and tatweel' }).check();
    await expect(summary(page)).toContainText('No differences in the text.');
    // The marks are drawn, though: the page does look different.
    await expect(summary(page)).toContainText(
      'The words are the same, but some pages look different (pages: 1)',
    );
    await expect(results(page).locator('.compare-page')).toHaveCount(0);
  });

  test('another PDF behind a password is asked for, and the same text encrypted is no change', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, THREE);
    await chooseTool(page, 'Compare');
    await panel(page).getByRole('radio', { name: 'Another PDF' }).check();
    await panel(page).locator('input[type="file"]').setInputFiles(LOCKED);
    const file = panel(page).locator('.compare-file');
    await expect(file.getByLabel(/Password for/)).toBeVisible();
    await expect(compareButton(page)).toBeDisabled();

    await file.getByLabel(/Password for/).fill('not-it');
    await file.getByRole('button', { name: 'Unlock' }).click();
    await expect(file.getByRole('alert')).toBeVisible();
    await file.getByLabel(/Password for/).fill('warraq');
    await file.getByRole('button', { name: 'Unlock' }).click();
    await expect(file).toContainText('Pages: 3');

    await compareButton(page).click();
    await expect(summary(page)).toContainText('No differences in the text.');
    await expect(summary(page)).toContainText('No page looks different.');
  });

  test('a drawing, which the text cannot show, is found by how the page looks', async ({
    page,
    stayLocal: _,
  }) => {
    // A freehand drawing on page 1 of the three pages, saved.
    await page.goto('/');
    await openPdf(page, THREE);
    await chooseTool(page, 'Comment');
    await useAction(page, 'Draw');
    const box = await pageBox(page);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 15 });
    await page.mouse.up();
    await expect.poll(() => annotationTypes(page)).toContain(15);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
    ]);
    const drawn = 'test-results/compare-drawn.pdf';
    await download.saveAs(drawn);

    await page.goto('/');
    await openPdf(page, drawn);
    await chooseTool(page, 'Compare');
    await panel(page).getByRole('radio', { name: 'Another PDF' }).check();
    await panel(page).locator('input[type="file"]').setInputFiles(THREE);
    await compareButton(page).click();
    await expect(summary(page)).toContainText('No differences in the text.');
    await expect(summary(page)).toContainText(
      'The words are the same, but some pages look different (pages: 1)',
    );

    await results(page).getByRole('radio', { name: 'Appearance' }).check();
    await expect(results(page).getByRole('heading', { name: 'Page 1', exact: true })).toBeVisible();
    await expect(results(page).getByRole('heading', { name: 'Page 2', exact: true })).toHaveCount(
      0,
    );
    const picture = results(page).getByRole('img', {
      name: 'Page 1, with what looks different outlined',
    });
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(100);

    const [report] = await Promise.all([
      page.waitForEvent('download'),
      results(page).getByRole('button', { name: 'Save the comparison' }).click(),
    ]);
    const html = readFileSync(await report.path(), 'utf8');
    expect(html).toContain('Pages that look different');
    expect(html).toContain('<img src="data:image/png;base64,');
  });
});
