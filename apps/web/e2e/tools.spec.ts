import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  ARABIC_FORM,
  INVOICE,
  annotationTypes,
  chooseTool,
  embedTiles,
  enterEditText,
  fieldValues,
  pageBox,
  pendingRedactions,
  openPdf,
  test,
  useAction,
} from './helpers';

/** Clicks Save and returns the bytes of the file the person would get. */
async function save(page: Page): Promise<{ path: string; text: string }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const path = `test-results/saved-${download.suggestedFilename()}`;
  await download.saveAs(path);
  return { path, text: readFileSync(path).toString('latin1') };
}

/** One continuous stroke across the page, between fractions of its size. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await pageBox(page);
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 15 });
  await page.mouse.up();
}

const action = (page: Page, name: string) => page.locator('.pane-end').getByRole('button', { name, exact: true });

test.describe('each tool changes the file, not just the screen', () => {
  test('Comment: a freehand drawing is saved as an ink annotation', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Comment');
    await useAction(page, 'Draw');
    await drag(page, [0.2, 0.6], [0.6, 0.7]);
    // The ink tool turns the stroke into a drawing 800 ms after it ends.
    await expect.poll(() => annotationTypes(page), { message: 'the stroke became a drawing' }).toContain(15);
    const saved = await save(page);
    await page.goto('/');
    await openPdf(page, saved.path);
    await expect.poll(() => annotationTypes(page)).toContain(15);
  });

  test('Redact: marked text is gone from the saved file, the rest is intact', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Redact');
    await useAction(page, 'Mark an area');
    // the invoice's title, number and date sit in the top fifth of the page
    await drag(page, [0.02, 0.03], [0.98, 0.16]);
    // A marked area becomes a pending redaction a moment later; Apply before
    // that has nothing to apply. A person never clicks that fast; a test does.
    await expect.poll(() => pendingRedactions(page)).toBeGreaterThan(0);
    await action(page, 'Apply redactions').click();
    await expect.poll(() => pendingRedactions(page)).toBe(0);
    const saved = await save(page);
    await page.goto('/');
    await openPdf(page, saved.path);
    const first = await enterEditText(page);
    await expect(first.locator('.text-layer')).toContainText('العميل');
    await expect(first.locator('.text-layer')).not.toContainText('فاتورة ضريبية مبسطة');
  });

  test('Prepare form: a new text field is saved as a real AcroForm field', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Prepare form');
    await useAction(page, 'Text field');
    await drag(page, [0.3, 0.8], [0.7, 0.85]);
    const saved = await save(page);
    expect(saved.text).toMatch(/\/AcroForm/);
    await page.goto('/');
    await openPdf(page, saved.path);
    await expect.poll(() => annotationTypes(page)).toContain(20);
  });

  test('Fill & sign: a value typed into a form field is saved in the file', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, ARABIC_FORM);
    await chooseTool(page, 'Fill & sign');
    await action(page, 'Fill form fields').click();
    // EmbedPDF draws each field as a real input named after it — not the first
    // input in the viewer, which is its zoom box.
    const field = page.locator('embedpdf-container input[name="Text2"]');
    await field.click();
    await field.fill('Warraq 123');
    await field.press('Tab');
    const saved = await save(page);
    await page.goto('/');
    await openPdf(page, saved.path);
    await expect.poll(() => fieldValues(page)).toContain('Warraq 123');
  });

  test('Protect: the saved file needs its password, and Warraq opens it with one', async ({ page, stayLocal: _ }) => {
    const password = 'warraq-2026';
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Protect');
    await action(page, 'Set a password').click();
    await page.getByRole('checkbox', { name: /Require password to open/ }).check();
    await page.getByRole('textbox', { name: 'Enter password' }).fill(password);
    await page.getByRole('textbox', { name: 'Confirm password' }).fill(password);
    await page.getByRole('button', { name: 'Apply Protection' }).click();
    const saved = await save(page);
    expect(saved.text).toMatch(/\/Encrypt/);

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(saved.path);
    const prompt = page.getByRole('dialog', { name: 'Password required' });
    await expect(prompt).toBeVisible();
    await prompt.getByLabel('Password').fill('not-the-password');
    await prompt.getByRole('button', { name: 'Open' }).click();
    await expect(prompt.getByRole('alert')).toBeVisible();
    await prompt.getByLabel('Password').fill(password);
    await prompt.getByRole('button', { name: 'Open' }).click();
    await expect(prompt).toBeHidden();
    // Both engines were given it: EmbedPDF draws the page, Warraq's reads its Arabic.
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    const first = await enterEditText(page);
    await expect(first.locator('.text-layer')).toContainText('العميل');
    // Edit text reopens EmbedPDF's copy, which is still protected.
    await expect(page.locator('.banner-error')).toHaveCount(0);
  });
});
