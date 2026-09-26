import { expect, test } from '@playwright/test';
import { fixture, fixtureBytes, latin1, openViaCard, drawRedactionMark, pickTool, savedFiles, stubSavePicker, waitForDocument } from './helpers';
import { openInEngine } from './engine';

test.describe('viewer-backed tools reachable from our tool picker', () => {
  test('Redact: mark an area with EmbedPDF, apply through the engine, save as a whole rewrite; the recents preview is dropped', async ({ context, page }) => {
    await stubSavePicker(context);
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    // the first-page picture exists before redaction
    await page.getByRole('button', { name: 'Home' }).first().click();
    const card = page.locator('[data-testid=recent-card][data-name="sample-en.pdf"]');
    await expect(card.locator('img.thumb-img')).toBeVisible();
    // Back to the same (still open) document, not a second copy.
    await card.locator('.recent-open').click();
    await waitForDocument(page);
    await expect(page.locator('[data-testid=document-view]')).toHaveCount(1);

    await pickTool(page, 'redact');
    await expect(page.locator('[data-epdf-i=redaction-toolbar]')).toBeVisible();
    await page.locator('[data-epdf-i=redact]').click();
    await drawRedactionMark(page, [0.08, 0.145], [0.85, 0.185]);
    // EmbedPDF's PDFium "apply" is hidden; our panel applies the mark through the engine.
    await expect(page.locator('[data-epdf-i=apply-redaction]')).toBeHidden();
    await page.locator('[data-testid=redact-apply]').click();
    await page.locator('[data-testid=redact-confirm]').click();
    await waitForDocument(page);
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toContainText('Edited');

    await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
    await expect(page.locator('.hud', { hasText: 'Saved' })).toBeVisible();
    const [saved] = await savedFiles(page);
    const original = fixtureBytes('sample-en.pdf');
    // Whole rewrite: the original revision (with the redacted text) is not kept as a prefix.
    expect(saved!.bytes.subarray(0, original.length).equals(original)).toBe(false);
    expect(latin1(saved!.bytes)).toMatch(/^%PDF-/);
    const reopened = await openInEngine(saved!.bytes);
    expect(reopened.plain()).not.toContain('small two-page fixture');
    expect(reopened.plain()).toContain('Highlight this sentence');
    expect(reopened.info().revisions).toBe(1);
    reopened.close();

    await page.getByRole('button', { name: 'Home' }).first().click();
    await expect(card.locator('.thumb-placeholder')).toBeVisible();
    await expect(card.locator('img.thumb-img')).toHaveCount(0);
  });

  test('Protect opens the engine-backed panel, not EmbedPDF’s protection modal', async ({ page }) => {
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    await pickTool(page, 'protect');
    await expect(page.locator('[data-testid=protect-panel]')).toBeVisible();
    await expect(page.getByText('Require password to open')).toHaveCount(0);
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
    await pickTool(page, 'redact');
    await expect(page.locator('[data-epdf-i=redact]').getByRole('button')).toHaveAccessibleName(/تنقيح/);
    await context.close();
  });
});
