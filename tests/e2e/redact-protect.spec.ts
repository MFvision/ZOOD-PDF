import { expect, test } from '@playwright/test';
import { fixture, fixtureBytes, latin1, openViaCard, pageBox, pickTool, savedFiles, stubSavePicker } from './helpers';

test.describe('viewer-backed tools reachable from our tool picker', () => {
  test('Redact: mark an area, apply, save as a whole rewrite; the recents preview is dropped', async ({ context, page }) => {
    await stubSavePicker(context);
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    // the first-page picture exists before redaction
    await page.getByRole('button', { name: 'Home' }).first().click();
    const card = page.locator('[data-testid=recent-card][data-name="sample-en.pdf"]');
    await expect(card.locator('img.thumb-img')).toBeVisible();
    await card.locator('.recent-open').click();

    await pickTool(page, 'redact');
    await expect(page.locator('[data-epdf-i=redaction-toolbar]')).toBeVisible();
    await page.locator('[data-epdf-i=redact]').click();
    const box = await pageBox(page, 0);
    await page.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.145);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.17, { steps: 5 });
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.185, { steps: 5 });
    await page.mouse.up();
    await page.locator('[data-epdf-i=apply-redaction]').click();
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toContainText('Edited');

    await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
    await expect(page.locator('.hud')).toContainText('Saved');
    const [saved] = await savedFiles(page);
    const original = fixtureBytes('sample-en.pdf');
    // Whole rewrite: the original revision (with the redacted text) is not kept as a prefix.
    expect(saved!.bytes.subarray(0, original.length).equals(original)).toBe(false);
    expect(latin1(saved!.bytes)).toMatch(/^%PDF-/);

    await page.getByRole('button', { name: 'Home' }).first().click();
    await expect(card.locator('.thumb-placeholder')).toBeVisible();
    await expect(card.locator('img.thumb-img')).toHaveCount(0);
  });

  test('Protect opens EmbedPDF’s protection sheet', async ({ page }) => {
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    await pickTool(page, 'protect');
    await expect(page.getByText('Require password to open')).toBeVisible();
  });

  test('Fill & sign and Prepare form switch EmbedPDF to its insert and form tool strips', async ({ page }) => {
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    await pickTool(page, 'fill-sign');
    await expect(page.locator('[data-epdf-i=insert-toolbar]')).toBeVisible();
    await pickTool(page, 'prepare-form');
    await expect(page.locator('[data-epdf-i=form-toolbar]')).toBeVisible();
    await pickTool(page, 'view');
    await expect(page.locator('[data-epdf-i=form-toolbar]')).toHaveCount(0);
  });

  test('EmbedPDF speaks Arabic in the Arabic interface', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ar' });
    const page = await context.newPage();
    await page.goto('/');
    await openViaCard(page, fixture('sample-ar.pdf'));
    await pickTool(page, 'protect');
    await expect(page.getByText('طلب كلمة مرور للفتح')).toBeVisible();
    await context.close();
  });
});
