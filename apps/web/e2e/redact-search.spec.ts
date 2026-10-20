import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, embedDocument, embedTiles, enterEditText, openPdf, pendingRedactions, test } from './helpers';
import { callOn, core, readable, spellings, textOf } from './pdfBytes';

const fixture = (path: string) => fileURLToPath(new URL(`../../../tests/fixtures/${path}`, import.meta.url));
/** English in a standard font (its words literally in the content stream) and Arabic written by Warraq's core. */
const CONTRACT = fixture('redact/contract.pdf');
/**
 * "Nadia Haddad keeps the rest" on pages turned by /Rotate 0, 90, 180, 270, on a
 * page whose lines all slant 8°, and up a margin; a footer marked as an artifact
 * with the name and a phone number (tests/fixtures/redact/make_turned.py).
 */
const TURNED = fixture('redact/turned.pdf');
/** Opens without a password; its permissions forbid changing its content (make_locked.py). */
const LOCKED = fixture('redact/locked.pdf');
/** Four layers, one named in Arabic (tests/fixtures/layers/make.py); "Always shown" is in none. */
const LAYERS = fixture('layers/layers.pdf');

const panel = (page: Page) => page.locator('.pane-end');

async function find(page: Page, words: string, patterns: string[] = []): Promise<void> {
  const query = panel(page).getByLabel('Words to find');
  await query.fill(words);
  for (const name of ['Email addresses', 'Phone numbers', 'National ID and Iqama numbers', 'IBANs', 'Card numbers', 'Dates']) {
    await panel(page).getByLabel(name, { exact: true }).setChecked(patterns.includes(name));
  }
  await panel(page).getByRole('button', { name: 'Find', exact: true }).click();
  await expect(panel(page).getByText(/^Found: \d+$|^Nothing found\.$/)).toBeVisible();
}

const results = (page: Page) => panel(page).getByRole('list', { name: 'Matches' }).getByRole('listitem');

async function save(page: Page, name: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const path = `test-results/${name}-${download.suggestedFilename()}`;
  await download.saveAs(path);
  return path;
}

test.describe('Redact: find and redact', () => {
  test('Arabic and English words and an email are found, marked, applied and gone from the saved file', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, CONTRACT);
    await chooseTool(page, 'Redact');

    // The ready-made patterns find what the page holds, in either digit script.
    await find(page, '', ['Phone numbers']);
    await expect(results(page)).toHaveCount(2);
    await expect(results(page).nth(1)).toContainText('٠٥٠١٢٣٤٥٦٧');
    await find(page, '', ['IBANs', 'Card numbers', 'National ID and Iqama numbers', 'Dates']);
    await expect(results(page)).toHaveCount(5);

    // An Arabic word, written without the shadda, and the email addresses.
    await find(page, 'وراق', ['Email addresses']);
    await expect(results(page)).toHaveCount(3);
    await expect(results(page).filter({ hasText: 'ورّاق' })).toHaveCount(1);
    // Only the Arabic word and the long address; the short one stays.
    await results(page).filter({ hasText: 'nadia@example.sa' }).getByRole('checkbox').uncheck();
    await panel(page).getByRole('button', { name: 'Mark selected (2)' }).click();
    await expect(panel(page).getByText('2 marked for redaction.', { exact: false })).toBeVisible();
    await expect.poll(() => pendingRedactions(page)).toBe(2);

    // An English word, in either case: also in the address, already marked.
    await find(page, 'Haddad');
    await expect(results(page)).toHaveCount(2);
    await panel(page).getByRole('button', { name: 'Select none' }).click();
    await results(page).first().getByRole('checkbox').check();
    await panel(page).getByRole('button', { name: 'Mark selected (1)' }).click();
    await expect.poll(() => pendingRedactions(page)).toBe(3);

    await panel(page).getByRole('button', { name: 'Apply redactions', exact: true }).click();
    await expect.poll(() => pendingRedactions(page)).toBe(0);
    const saved = await save(page, 'redact-search');

    // Written whole: an update would keep the words in the revision before.
    const original = readFileSync(CONTRACT);
    const bytes = readFileSync(saved);
    expect(bytes.subarray(0, original.length).equals(original)).toBe(false);

    // Warraq's reader no longer finds them; everything else reads as it did.
    const text = await textOf(saved);
    for (const gone of ['ورّاق', 'Haddad', 'nadia.haddad@example.com']) expect(text).not.toContain(gone);
    for (const kept of ['Contract between Warraq Labs and Nadia', 'Keep this line: the rest stays readable.', 'يبقى هذا السطر كما هو.', 'nadia@example.sa', 'IBAN SA03 8000 0000 6080 1016 7519']) {
      expect(text).toContain(kept);
    }

    // Nor are they anywhere in the bytes, a content stream inflated or not:
    // not as the literal strings the English was drawn with, nor as the
    // text the Arabic carried.
    const raw = readable(bytes);
    for (const gone of ['Haddad', 'nadia.haddad@example.com', 'ورّاق']) {
      for (const spelling of spellings(gone)) expect(raw, `${gone} as ${spelling}`).not.toContain(spelling);
    }
    // The check can see: what was kept is there, spelled one of those ways.
    expect(spellings('Keep this line').some((spelling) => raw.includes(spelling))).toBe(true);
    expect(spellings('شركة').some((spelling) => raw.includes(spelling))).toBe(true);
  });

  test('on turned pages, slanting and upright lines and in a footer, only the word is marked, and it is gone', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, TURNED);
    await chooseTool(page, 'Redact');
    await find(page, 'Haddad');
    // Four turned pages, the crooked one, the margin, and the footer another
    // program marked as an artifact.
    await expect(results(page)).toHaveCount(7);
    await expect(results(page).filter({ hasText: 'Prepared for Nadia' })).toHaveCount(1);
    await panel(page).getByRole('button', { name: 'Mark selected (7)' }).click();
    await expect(panel(page).getByText('7 marked for redaction.', { exact: false })).toBeVisible();
    await expect.poll(() => pendingRedactions(page)).toBe(7);
    await panel(page).getByRole('button', { name: 'Apply redactions', exact: true }).click();
    await expect.poll(() => pendingRedactions(page)).toBe(0);
    const saved = await save(page, 'redact-turned');

    // The name is gone from every page; its neighbours, on its line and the
    // lines about it, are all there.
    const text = await textOf(saved);
    expect(text).not.toContain('Haddad');
    const times = (needle: string) => text.split(needle).length - 1;
    // Six lines and the footer.
    expect(times('Nadia')).toBe(7);
    expect(times('keeps the rest')).toBe(6);
    expect(times('Line above stays')).toBe(5);
    expect(times('Line below stays')).toBe(5);
    expect(times('Text beside it stays')).toBe(1);
    expect(text).toContain('Prepared for Nadia');
    expect(text).toContain('+966 50 123 4567');
    const raw = readable(readFileSync(saved));
    for (const spelling of spellings('Haddad')) expect(raw, spelling).not.toContain(spelling);
  });

  test('a page mark محرر زود PDF drew is found, said to be one, and redacted', async ({ page, stayLocal: _ }) => {
    // A header written by Page marks, as the core writes it.
    const { call_static } = await core();
    const amiri = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../tests/fonts/Amiri-Regular.ttf', import.meta.url))));
    const reply = call_static(
      'marks.add',
      JSON.stringify({ mark: { kind: 'header', slots: ['', 'Prepared by Samir Qasim', ''], size: 10 }, fontBlob: 1 }),
      [new Uint8Array(readFileSync(CONTRACT)), amiri],
    );
    const marked = 'test-results/redact-page-mark-input.pdf';
    writeFileSync(marked, reply.blobs[0]!);

    await page.goto('/');
    await openPdf(page, marked);
    await chooseTool(page, 'Redact');
    await find(page, 'Qasim');
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first()).toContainText('In a page mark');
    await panel(page).getByRole('button', { name: 'Mark selected (1)' }).click();
    await panel(page).getByRole('button', { name: 'Apply redactions', exact: true }).click();
    await expect.poll(() => pendingRedactions(page)).toBe(0);
    const saved = await save(page, 'redact-page-mark');
    const { result } = await callOn<{ marks: string; page: string }>('marks.text', saved, { page: 0 });
    expect(result.marks).not.toContain('Qasim');
    expect(await textOf(saved)).not.toContain('Qasim');
    expect(await textOf(saved)).toContain('Keep this line: the rest stays readable.');
  });

  test('what was found in one file is not offered for the next one opened', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, CONTRACT);
    await chooseTool(page, 'Redact');
    await find(page, 'Haddad');
    await expect(results(page)).toHaveCount(2);
    await panel(page).getByRole('button', { name: 'Check the file' }).click();
    await expect(panel(page).getByRole('button', { name: 'Remove', exact: true })).toBeVisible();

    // Another file, opened from the viewer with the Redact tool still open.
    await page.locator('input[type="file"]').first().setInputFiles(TURNED);
    await expect.poll(async () => (await embedDocument(page)).pages).toBe(6);
    await expect(panel(page).getByRole('list', { name: 'Matches' })).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: /^Mark selected/ })).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
    expect(await pendingRedactions(page)).toBe(0);
  });

  test('on a file that forbids changing its content, nothing is said to be marked', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, LOCKED);
    await chooseTool(page, 'Redact');
    await find(page, 'Haddad');
    await expect(results(page)).toHaveCount(1);
    await panel(page).getByRole('button', { name: 'Mark selected (1)' }).click();
    await expect(panel(page).getByRole('alert')).toHaveText("Nothing was marked: this file's permissions do not allow its content to be changed.");
    await expect(panel(page).getByText('marked for redaction.', { exact: false })).toHaveCount(0);
    expect(await pendingRedactions(page)).toBe(0);
  });

  test('a redaction made with layers shown by choice stays out of the file after a round trip through Edit text', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, LAYERS);
    // A layer hidden by choice: the view draws a copy, the file keeps its own.
    await page.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Layers', exact: true }).click();
    const before = (await embedDocument(page)).id;
    await page.getByRole('complementary', { name: 'Navigation' }).getByRole('checkbox', { name: 'طبقة عربية', exact: false }).uncheck();
    await expect.poll(async () => (await embedDocument(page)).id).not.toBe(before);

    await chooseTool(page, 'Redact');
    await find(page, 'Always shown');
    await panel(page).getByRole('button', { name: 'Mark selected (1)' }).click();
    await panel(page).getByRole('button', { name: 'Apply redactions', exact: true }).click();
    await expect.poll(() => pendingRedactions(page)).toBe(0);

    // An edit in Edit text, and back to the view: the file is handed round twice.
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    await area.fill('EDITED-AFTER-REDACTION');
    await area.press('ControlOrMeta+Enter');
    await expect(first.locator('.text-layer')).toContainText('EDITED-AFTER-REDACTION');
    await chooseTool(page, 'Redact');
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);

    const saved = await save(page, 'redact-layers-edit');
    // Nowhere in the file, in no revision: the redaction is not undone by
    // keeping the file's bytes from before it.
    const raw = readable(readFileSync(saved));
    for (const spelling of spellings('Always shown')) expect(raw, spelling).not.toContain(spelling);
    expect(await textOf(saved)).toContain('EDITED-AFTER-REDACTION');
    // And the layers are the file's own, not the view's choice.
    const { result } = await callOn<{ layers: { name: string; visible: boolean }[] }>('layers.list', saved);
    expect(result.layers.find((l) => l.name === 'طبقة عربية')?.visible).toBe(true);
  });

  test('a pattern that is not one is refused, and nothing is marked', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, CONTRACT);
    await chooseTool(page, 'Redact');
    await panel(page).getByLabel('Your own pattern (regular expression)').fill('(unclosed');
    await panel(page).getByRole('button', { name: 'Find', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toHaveText('This pattern cannot be used: it is not valid, or it is too large.');
    await panel(page).getByLabel('Your own pattern (regular expression)').fill('Warraq \\w+');
    await panel(page).getByRole('button', { name: 'Find', exact: true }).click();
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first()).toContainText('Warraq Labs');
    expect(await pendingRedactions(page)).toBe(0);
  });
});
