import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INVOICE, enterEditText, openPdf, test } from './helpers';
import { readable, textOf } from './pdfBytes';

/**
 * One blue line, "Meeting Intelligence quarterly", in an embedded subset
 * the file calls Montserrat SemiBold: the subset has those letters and no
 * others (written by `warraq-core/tests/edit_own_font.rs`).
 */
const SUBSET = fileURLToPath(new URL('../../../tests/fixtures/edit/own-font-subset.pdf', import.meta.url));

const APPLY = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';

/** How many font dictionaries a file's bytes hold, every revision counted. */
const fontObjects = (bytes: Buffer) => (readable(bytes).match(/\/Type\s*\/Font\b(?!Descriptor)/g) ?? []).length;

/** The Edit panel's font control. */
const fontControl = (page: import('@playwright/test').Page) => page.locator('.tool-panel select:has(option[value="auto"])');

async function save(page: import('@playwright/test').Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const saved = await download.path();
  expect(saved).toBeTruthy();
  return saved;
}

test.describe('replaced text keeps the font it was set in', () => {
  test('the font control starts on Automatic and says what it resolves to', async ({ page, stayLocal: _stayLocal }) => {
    await page.goto('/');
    await openPdf(page, SUBSET);
    const first = await enterEditText(page);
    const font = fontControl(page);
    await expect(font).toHaveValue('auto');
    await expect(font.locator('option')).toHaveText(['Automatic', 'Amiri', 'Cairo', 'Inter']);
    const resolved = page.getByTestId('edit-font-resolved');
    await expect(resolved).toHaveText('Each paragraph keeps its own font where it can.');
    await first.locator('.edit-box').first().click();
    await expect(first.locator('.paragraph-editor-area')).toBeVisible();
    await expect(resolved).toContainText("The document's own font");
    await expect(resolved).toContainText('Montserrat SemiBold');
  });

  test('letters the document already has are drawn in its own font: nothing embedded, same size and colour', async ({
    page,
    stayLocal: _stayLocal,
  }) => {
    const original = readFileSync(SUBSET);
    await page.goto('/');
    await openPdf(page, SUBSET);
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    await area.fill('Meeting gently');
    await area.press(APPLY);
    await expect(first.locator('.text-layer')).toContainText('Meeting gently');
    // Nothing was substituted, so nothing is announced.
    await expect(page.locator('.banner-warning')).toHaveCount(0);

    const saved = await save(page);
    expect(await textOf(saved)).toBe('Meeting gently');
    const bytes = readFileSync(saved);
    expect(fontObjects(bytes), 'no font was added to the file').toBe(fontObjects(original));
    const text = readable(bytes);
    // The replacement is the last text object: the page's own resource, at
    // its 14 points, in the blue the line was painted in.
    const drawn = text.slice(text.lastIndexOf('0.2 0.3 0.9 rg'));
    expect(drawn).toMatch(/^0\.2 0\.3 0\.9 rg\s+BT\s+\/FW1 14 Tf/);
    expect(text).not.toContain('Amiri');
  });

  test('a letter the document lacks falls through to the closest face, and the notice says which and why', async ({
    page,
    stayLocal: _stayLocal,
  }) => {
    await page.goto('/');
    await openPdf(page, SUBSET);
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    // No b, o or x in the subset.
    await area.fill('Meeting box');
    await area.press(APPLY);
    await expect(first.locator('.text-layer')).toContainText('Meeting box');
    const notice = page.locator('.banner-warning');
    await expect(notice).toContainText('Font substituted.');
    await expect(notice).toContainText('Montserrat');
    // A sans, Latin: Inter, not the Naskh every edit used to come back in.
    await expect(notice).toContainText('Inter');
    await expect(notice).not.toContainText('Amiri');

    const saved = await save(page);
    expect(await textOf(saved)).toBe('Meeting box');
    const text = readable(readFileSync(saved));
    // The subset embedded for it is named for what it is.
    expect(text).toContain('/BaseFont /WARRAQ+Inter');
    expect(text).not.toContain('Amiri');
  });

  test('choosing a face overrides Automatic', async ({ page, stayLocal: _stayLocal }) => {
    await page.goto('/');
    await openPdf(page, SUBSET);
    const first = await enterEditText(page);
    await fontControl(page).selectOption('amiri');
    await expect(page.getByTestId('edit-font-resolved')).toHaveCount(0);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    await area.fill('Meeting gently');
    await area.press(APPLY);
    await expect(first.locator('.text-layer')).toContainText('Meeting gently');
    const notice = page.locator('.banner-warning');
    await expect(notice).toContainText('The face chosen in the Edit panel');
    await expect(notice).toContainText('Amiri');
    expect(readable(readFileSync(await save(page)))).toContain('/BaseFont /WARRAQ+Amiri');
  });

  test('Arabic is never drawn by the document\'s own codes: it is reshaped in the closest face', async ({
    page,
    stayLocal: _stayLocal,
  }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    await expect(area).toBeVisible();
    // Set in a subset of Amiri, which the app carries whole.
    const resolved = page.getByTestId('edit-font-resolved');
    await expect(resolved).toContainText('Amiri');
    await expect(resolved).toContainText('which the app carries in full');
    await expect(resolved).not.toContainText("The document's own font");
    const replacement = 'نص عربي جديد';
    await area.fill(replacement);
    await area.press(APPLY);
    await expect(first.locator('.text-layer')).toContainText(replacement);
    await expect(page.locator('.banner-warning')).toContainText("the app's copy of \u2068Amiri\u2069 was embedded");
    const saved = await save(page);
    expect(await textOf(saved)).toContain(replacement);
    // A new subset was embedded for it, and the file names it truthfully.
    expect(readable(readFileSync(saved))).toContain('WARRAQ+Amiri');
  });

  test('in Arabic the control and the notice read naturally', async ({ page, stayLocal: _stayLocal }) => {
    await page.goto('/');
    await openPdf(page, SUBSET);
    const first = await enterEditText(page);
    await page.getByRole('menubar').getByRole('combobox', { name: 'Language' }).selectOption({ label: 'العربية' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const resolved = page.getByTestId('edit-font-resolved');
    await expect(resolved).toHaveText('تحتفظ كل فقرة بخطها حيثما أمكن.');
    await expect(fontControl(page).locator('option').first()).toHaveText('تلقائي');
    await first.locator('.edit-box').first().click();
    await expect(resolved).toContainText('خط المستند نفسه');
    const area = first.locator('.paragraph-editor-area');
    await area.fill('Meeting box');
    await area.press(APPLY);
    const notice = page.locator('.banner-warning');
    await expect(notice).toContainText('جرى استبدال الخط.');
    await expect(notice).toContainText('أقرب خط يحمله التطبيق');
    await expect(notice).toContainText('Inter');
  });
});
