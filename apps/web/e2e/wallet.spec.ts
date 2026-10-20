import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { chooseTool, corpus, fieldValues, openPdf, test } from './helpers';
import { installDeviceStub, stubRecord } from './deviceStub';

/**
 * My details: the Wallet's profiles in Settings, Fill & sign filling a form
 * from them and saving a form's details into them — every value shown before
 * anything is typed or kept, by the labels alone, nothing sent anywhere —
 * and the Memory a chat message adds to, which the model then reads.
 */

const ARABIC = corpus('generated/acroform-pdflib-arabic-fields.pdf');

/** A one-page English form: two labelled text fields, empty. */
function englishForm(): string {
  const content = 'BT /F1 12 Tf 50 700 Td (Email address:) Tj ET\nBT /F1 12 Tf 50 660 Td (Passport No:) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 7 0 R >> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> /Annots [5 0 R 6 0 R] >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (email) /Rect [160 695 420 715] /F 4 /P 3 0 R /DA (/Helv 11 Tf 0 g) /MK << /BC [0 0 0] >> >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (pp) /Rect [160 655 420 675] /F 4 /P 3 0 R /DA (/Helv 11 Tf 0 g) /MK << /BC [0 0 0] >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const path = join(tmpdir(), 'wallet-english-form.pdf');
  writeFileSync(path, pdf, 'latin1');
  return path;
}

async function myDetails(page: Page): Promise<Locator> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'ZOOD PDF' }).click();
  await page.getByRole('menuitem', { name: /^Settings…/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('navigation').getByRole('button', { name: 'My details', exact: true }).click();
  return sheet;
}

const tool = (page: Page) => page.locator('.pane-end').getByRole('group', { name: 'My details' });

test.describe('my details fill forms', () => {
  test('an Arabic form is filled from the saved details after review, and its other details are saved back', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    const sheet = await myDetails(page);
    await sheet.getByLabel('Nationality').fill('سعودي');
    await sheet.getByLabel('E-mail').fill('m.ali@example.sa');
    // An ID is hidden until its eye is pressed.
    await sheet.getByLabel('National ID / Iqama number', { exact: true }).fill('1111111111');
    await expect(sheet.getByLabel('National ID / Iqama number', { exact: true })).toHaveAttribute('type', 'password');
    await sheet.getByRole('button', { name: 'Show National ID / Iqama number' }).click();
    await expect(sheet.getByLabel('National ID / Iqama number', { exact: true })).toHaveAttribute('type', 'text');
    await sheet.getByRole('button', { name: 'Save my details' }).click();
    await expect(sheet).toContainText('Saved on this device.');
    await sheet.getByRole('button', { name: 'Close' }).click();

    await openPdf(page, ARABIC);
    await chooseTool(page, 'Fill & sign');
    await tool(page).getByRole('button', { name: 'Fill from my details' }).click();
    const rows = tool(page).getByRole('list', { name: 'Proposed values' }).locator('li');
    // The empty fields only: the name and ID the form already holds are left be.
    await expect(rows).toHaveCount(2);
    await expect(tool(page).getByLabel('Value for الجنسية:')).toHaveValue('سعودي');
    await expect(tool(page).getByLabel('Value for البريد الإلكتروني:')).toHaveValue('m.ali@example.sa');
    expect(await fieldValues(page)).not.toContain('سعودي');
    await tool(page).getByRole('button', { name: 'Fill 2 fields' }).click();
    await expect(tool(page)).toContainText('Filled 2 fields.');
    await expect.poll(() => fieldValues(page)).toContain('سعودي');
    expect(await fieldValues(page)).toContain('m.ali@example.sa');

    // The other way: what the form holds that the profile does not.
    await tool(page).getByRole('button', { name: 'Save these to my details' }).click();
    const learnt = tool(page).getByRole('list', { name: 'Details to save' }).locator('li');
    await expect(learnt).toHaveCount(2);
    await expect(tool(page).getByLabel('Detail for الاسم الكامل:')).toHaveValue('nameAr');
    await expect(tool(page).getByLabel('Value for رقم الهوية:')).toHaveValue('1098765432');
    // Left out: the ID stays as saved.
    await learnt.nth(1).getByRole('checkbox').uncheck();
    await tool(page).getByRole('button', { name: 'Save 1 details' }).click();
    await expect(tool(page)).toContainText('Saved 1 details in “Me”.');

    const again = await myDetails(page);
    await expect(again.getByLabel('Name (Arabic)')).toHaveValue('محمد عبد الله');
    await expect(again.getByLabel('National ID / Iqama number', { exact: true })).toHaveValue('1111111111');
  });

  test('an English form is filled from a second profile, and a line can be moved to another detail', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    const sheet = await myDetails(page);
    await sheet.getByLabel('E-mail').fill('home@example.sa');
    await sheet.getByRole('button', { name: 'Add profile' }).click();
    await sheet.getByLabel('Profile name').fill('Work');
    await sheet.getByLabel('E-mail').fill('m@zood.sa');
    await sheet.getByLabel('Other phone').fill('0112223333');
    await sheet.getByLabel('Passport number').fill('A1234567');
    await sheet.getByRole('button', { name: 'Save my details' }).click();
    await expect(sheet).toContainText('Saved on this device.');
    await expect(sheet.getByRole('tab')).toHaveText(['Me', 'Work']);
    await sheet.getByRole('button', { name: 'Close' }).click();

    await openPdf(page, englishForm());
    await chooseTool(page, 'Fill & sign');
    await tool(page).getByLabel('Use the details of').selectOption({ label: 'Work' });
    await tool(page).getByRole('button', { name: 'Fill from my details' }).click();
    const rows = tool(page).getByRole('list', { name: 'Proposed values' }).locator('li');
    await expect(rows).toHaveCount(2);
    await expect(tool(page).getByLabel('Value for Email address:')).toHaveValue('m@zood.sa');
    await expect(tool(page).getByLabel('Detail for Passport No:')).toHaveValue('passportNo');
    await expect(tool(page).getByLabel('Value for Passport No:')).toHaveValue('A1234567');
    // Moved to another detail by hand, the line takes that detail's value.
    await tool(page).getByLabel('Detail for Passport No:').selectOption('phone2');
    await expect(tool(page).getByLabel('Value for Passport No:')).toHaveValue('0112223333');
    await tool(page).getByRole('button', { name: 'Fill 2 fields' }).click();
    await expect.poll(() => fieldValues(page)).toEqual(['m@zood.sa', '0112223333']);
  });
});

test.describe('the Memory', () => {
  test('"remember that" keeps a note, sends nothing, and the next question carries it to the model', async ({ page, stayLocal: _ }) => {
    await installDeviceStub(page, () => 'An answer [p. 1].');
    await page.goto('/');
    await openPdf(page, ARABIC);
    await chooseTool(page, 'AI');
    const ai = page.locator('.pane-end');
    await ai.getByRole('button', { name: /^Download the on-device model \(491 MB, once\)/ }).click();
    const input = ai.getByLabel('Message');
    await expect(ai).toContainText('Messages stay on this device: the model runs inside the app, and nothing is sent anywhere.');
    await input.fill('Remember that I work in procurement at ZOOD');
    await input.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Saved to your Memory.' })).toBeVisible();
    expect((await stubRecord(page)).requests).toHaveLength(0);

    await input.fill('What is this form for?');
    await input.press('Enter');
    await expect.poll(async () => (await stubRecord(page)).requests.length).toBe(1);
    const sent = (await stubRecord(page)).requests[0]!.messages[1]!.content;
    expect(sent).toContain('<about_the_person>\n- I work in procurement at ZOOD\n</about_the_person>');

    const sheet = await myDetails(page);
    const notes = sheet.getByRole('list', { name: 'Memory' });
    await expect(notes).toContainText('I work in procurement at ZOOD');
    await expect(notes).toContainText('from the chat');
    // Turned off, the model reads nothing of it.
    await sheet.getByRole('switch', { name: 'Use my Memory in AI answers' }).uncheck();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await input.fill('And who signs it?');
    await input.press('Enter');
    await expect.poll(async () => (await stubRecord(page)).requests.length).toBe(2);
    expect((await stubRecord(page)).requests[1]!.messages[1]!.content).not.toContain('about_the_person');
  });
});
