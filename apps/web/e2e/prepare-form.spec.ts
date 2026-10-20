import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, corpus, enterEditText, fieldValues, openPdf, test } from './helpers';

/** A flat Arabic invoice printed by Chrome: no fields at all (tests/fixtures/forms). */
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../tests/fixtures/forms/${name}`, import.meta.url));
const INVOICE = fixture('ar-invoice.pdf');
const FLAT_FORM = corpus('generated/chrome-notosansarabic-form-layout.pdf');

const panel = (page: Page) => page.locator('.pane-end');
const button = (page: Page, name: string | RegExp) => panel(page).getByRole('button', { name, exact: typeof name === 'string' });

async function save(page: Page): Promise<{ path: string; bytes: Buffer }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const path = `test-results/saved-${download.suggestedFilename()}`;
  await download.saveAs(path);
  return { path, bytes: readFileSync(path) };
}

/** Types into one of EmbedPDF's form inputs and commits it, as a person tabs on. */
async function fill(page: Page, name: string, value: string): Promise<void> {
  const input = page.locator(`embedpdf-container input[name="${name}"]`);
  await input.click();
  await input.fill(value);
  await input.press('Tab');
}

test.describe('what a form holds that ورّاق does not run is said, not done', () => {
  test('scripts outside the subset are listed where forms are filled, and never run', async ({ page, stayLocal: _ }) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.goto('/');
    await openPdf(page, fixture('scripts-not-run.pdf'));
    await chooseTool(page, 'Fill & sign');
    const notice = panel(page).locator('details.form-scripts');
    await expect(notice.locator('summary')).toHaveText('Scripts in this form that ZOOD PDF does not run: 2');
    await notice.locator('summary').click();
    await expect(notice).toContainText('When the file opens');
    await expect(notice).toContainText("app.alert('Hello from the file')");
    await expect(notice).toContainText('Field “Amount”');
    // The field's number format is one ورّاق runs: it is not listed.
    await expect(notice).not.toContainText('AFNumber_Format');
    expect(dialogs).toEqual([]);
  });

  test('a static XFA form is said to be one, and can become a plain form', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, fixture('xfa-static.pdf'));
    await chooseTool(page, 'Prepare form');
    const notice = panel(page).getByRole('note').filter({ hasText: 'This is an XFA form' });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Remove the XFA layer' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The XFA layer was removed' })).toBeVisible();
    await expect(notice).toHaveCount(0);
    const saved = await save(page);
    await page.goto('/');
    await openPdf(page, saved.path);
    await chooseTool(page, 'Prepare form');
    await expect(panel(page).getByRole('combobox', { name: 'Field', exact: true })).toBeVisible();
    await expect(panel(page).getByRole('note').filter({ hasText: 'XFA' })).toHaveCount(0);
  });
});

test.describe('Prepare form finds the fields of a flat form, and runs their calculations', () => {
  test('detect on a flat Arabic invoice, accept, add a total, fill, save and reopen', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Prepare form');
    await button(page, 'Detect fields').click();
    await expect(panel(page).getByRole('status').first()).toContainText('Fields found: 14');

    // Drawn on the page where the fields would go, named after their labels.
    const proposals = page.locator('.proposal');
    await expect(proposals).toHaveCount(14);
    await expect(page.locator('.proposal[data-proposal="المجموع"]')).toBeVisible();
    await expect(page.locator('.proposal[data-proposal="سعر الوحدة 2"]')).toBeVisible();

    // Adjusted on the page: nudged with the keyboard, and one removed.
    const client = page.locator('.proposal[data-proposal="اسم العميل"]');
    const top = Number(await client.getAttribute('data-top'));
    await client.focus();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(client).toHaveAttribute('data-top', (top + 10).toFixed(1));
    await page.keyboard.press('Shift+ArrowUp');
    await expect(client).toHaveAttribute('data-top', top.toFixed(1));
    await page.locator('.proposal[data-proposal="الصنف 3"]').focus();
    await page.keyboard.press('Delete');
    await expect(proposals).toHaveCount(13);
    // … and in the list: a name changed there is the field's name.
    await panel(page).getByRole('textbox', { name: 'Field name' }).nth(1).fill('الصنف الأول');
    await expect(page.locator('.proposal[data-proposal="الصنف الأول"]')).toBeVisible();

    await button(page, 'Create fields (13)').click();
    await expect(panel(page).getByText('Fields created: 13.')).toBeVisible();
    await expect(proposals).toHaveCount(0);

    // The first line's total multiplies its quantity by its price …
    const editor = panel(page);
    await editor.getByRole('combobox', { name: 'Field', exact: true }).selectOption('الإجمالي 1');
    await editor.getByRole('combobox', { name: 'Calculated value' }).selectOption({ label: 'Arithmetic expression' });
    await editor.getByRole('textbox', { name: 'Arithmetic expression' }).fill('"الكمية 1" × "سعر الوحدة 1"');
    await button(page, 'Apply to the field').click();
    await expect(editor.getByText('Saved in “الإجمالي 1”.', { exact: false })).toBeVisible();

    // … and the sum is shown in riyals, in Arabic-Indic digits.
    await editor.getByRole('combobox', { name: 'Field', exact: true }).selectOption('المجموع');
    await editor.getByRole('combobox', { name: 'Format' }).selectOption({ label: 'Number' });
    await editor.getByRole('checkbox', { name: /Arabic-Indic digits/ }).check();
    await editor.locator('label', { hasText: 'Currency' }).getByRole('combobox').selectOption({ label: 'ر.س after the number' });
    await editor.getByRole('combobox', { name: 'Calculated value' }).selectOption({ label: 'Sum of fields' });
    const from = editor.getByRole('group', { name: 'Fields to calculate from' });
    await from.getByRole('checkbox', { name: 'الإجمالي 1' }).check();
    await from.getByRole('checkbox', { name: 'الإجمالي 2' }).check();
    await button(page, 'Apply to the field').click();
    await expect(editor.getByText('Saved in “المجموع”.', { exact: false })).toBeVisible();

    // Filling the form recalculates it, with Arabic-Indic digits typed too.
    await chooseTool(page, 'Fill & sign');
    await panel(page).getByRole('button', { name: 'Fill form fields', exact: true }).click();
    await fill(page, 'الكمية 1', '3');
    await fill(page, 'سعر الوحدة 1', '٢٠');
    await fill(page, 'الإجمالي 2', '15');
    await fill(page, 'الصنف الأول', 'قلم رصاص');
    await expect.poll(() => fieldValues(page)).toEqual(expect.arrayContaining(['60', '75', 'قلم رصاص']));

    const saved = await save(page);
    expect(saved.bytes.toString('latin1')).toContain('/WarraqAr');
    expect(saved.bytes.subarray(0, readFileSync(INVOICE).length).equals(readFileSync(INVOICE))).toBe(true);

    // Reopened: the values are in the file, and so is the calculation.
    await page.goto('/');
    await openPdf(page, saved.path);
    await expect.poll(() => fieldValues(page)).toEqual(expect.arrayContaining(['60', '75', 'قلم رصاص']));
    await chooseTool(page, 'Prepare form');
    await panel(page).getByRole('combobox', { name: 'Field', exact: true }).selectOption('المجموع');
    await expect(panel(page).getByRole('combobox', { name: 'Calculated value' })).toHaveValue('SUM');
    await expect(panel(page).getByRole('checkbox', { name: 'الإجمالي 1' })).toBeChecked();

    // And drawn: Warraq's own reader finds the total as the format shows it,
    // in the appearance of the field, beside the Arabic item.
    const first = await enterEditText(page);
    await expect(first.locator('.text-layer')).toContainText('٧٥٫٠٠');
    await expect(first.locator('.text-layer')).toContainText('قلم رصاص');
  });

  test('a value outside its field’s range is refused and the previous one kept', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, FLAT_FORM);
    await chooseTool(page, 'Prepare form');
    await panel(page).getByRole('radio', { name: 'This page' }).click();
    await button(page, 'Detect fields').click();
    await expect(page.locator('.proposal')).toHaveCount(10);
    await expect(page.locator('.proposal[data-proposal="الجنس/ذكر"]')).toBeVisible();
    await button(page, 'Create fields (10)').click();
    await expect(panel(page).getByText('Fields created: 10.')).toBeVisible();

    const editor = panel(page);
    await editor.getByRole('combobox', { name: 'Field', exact: true }).selectOption('رقم الهوية');
    await editor.getByRole('combobox', { name: 'Format' }).selectOption({ label: 'Number' });
    await editor.getByRole('textbox', { name: 'At least' }).fill('1000000000');
    await editor.getByRole('textbox', { name: 'At most' }).fill('2999999999');
    await editor.getByRole('spinbutton', { name: 'Decimal places' }).fill('0');
    await button(page, 'Apply to the field').click();
    await expect(editor.getByText('Saved in “رقم الهوية”.', { exact: false })).toBeVisible();

    await chooseTool(page, 'Fill & sign');
    await panel(page).getByRole('button', { name: 'Fill form fields', exact: true }).click();
    await fill(page, 'رقم الهوية', '1098765432');
    await fill(page, 'رقم الهوية', '42');
    await expect(page.getByRole('status').filter({ hasText: 'outside the field' })).toBeVisible();
    await expect.poll(() => fieldValues(page)).toContain('1098765432');
    await expect.poll(() => fieldValues(page)).not.toContain('42');
  });
});
