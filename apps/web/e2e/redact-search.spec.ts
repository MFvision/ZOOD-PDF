import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, openPdf, pendingRedactions, test } from './helpers';
import { readable, spellings, textOf } from './pdfBytes';

/** English in a standard font (its words literally in the content stream) and Arabic written by Warraq's core. */
const CONTRACT = fileURLToPath(new URL('../../../tests/fixtures/redact/contract.pdf', import.meta.url));

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
