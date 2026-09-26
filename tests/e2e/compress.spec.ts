import { expect, test, type Page } from '@playwright/test';
import { fixture, fixtureBytes, openViaCard, pickTool, savedFiles, stubSavePicker, trackExternalRequests, waitForDocument } from './helpers';
import { inspectPdf } from './pdf-inspect';

const view = (page: Page) => page.locator('[data-testid=document-view]:visible');

test.describe('Compress', () => {
  test('makes a smaller copy, shows before/after, saves the copy and leaves the document untouched', async ({ context, page }) => {
    await stubSavePicker(context);
    const external = trackExternalRequests(page);
    await page.goto('/');
    await openViaCard(page, fixture('photo-heavy.pdf'));
    await pickTool(page, 'compress');
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('Compress PDF');
    await expect(sheet.locator('[data-preset=balanced]')).toHaveAttribute('aria-checked', 'true');
    await sheet.locator('[data-action=run-compress]').click();
    const result = page.getByTestId('compress-result');
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('size-before')).toHaveText('452.9 KB');
    await expect(result).toContainText(/\d+% smaller/);
    await expect(result).toContainText('1 picture recompressed');

    await sheet.locator('[data-action=save-copy]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [saved] = await savedFiles(page);
    expect(saved!.name).toBe('photo-heavy (compressed).pdf');
    const original = fixtureBytes('photo-heavy.pdf');
    expect(saved!.bytes.length * 4).toBeLessThan(original.length);
    const pdf = await inspectPdf(saved!.bytes);
    expect(pdf.pageCount).toBe(1);
    // a whole rewrite with object streams (not an update of the original)
    expect(saved!.bytes.subarray(0, original.length).equals(original)).toBe(false);
    expect(saved!.bytes.toString('latin1')).toContain('/ObjStm');

    // the open document is not replaced and not marked edited
    await page.keyboard.press('Escape');
    await expect(view(page).locator('[data-testid=doc-status]')).toHaveText('Page 1 of 1');
    expect(external).toEqual([]);
  });

  test('Arabic: presets, «أصغر بنسبة», and opening the compressed copy as a new document', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ar' });
    await stubSavePicker(context);
    const page = await context.newPage();
    await page.goto('/');
    await openViaCard(page, fixture('photo-heavy.pdf'));
    await pickTool(page, 'compress');
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('ضغط الملف');
    await sheet.locator('[data-preset=smallest]').click();
    await expect(sheet.locator('[data-preset=smallest]')).toContainText('أصغر حجم');
    await sheet.locator('[data-action=run-compress]').click();
    await expect(page.getByTestId('compress-result')).toContainText('أصغر بنسبة', { timeout: 30_000 });
    await expect(page.getByTestId('size-before')).toHaveText('٤٥٢٫٩ ك.ب');
    await sheet.locator('[data-action=open-copy]').click();
    await waitForDocument(page);
    await expect(view(page).locator('.doc-name')).toHaveText('photo-heavy (مضغوط).pdf');
    await expect(view(page).locator('[data-testid=doc-status]')).toHaveText('صفحة ١ من ١ · معدَّل');
    await view(page).locator('[data-testid=save]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [saved] = await savedFiles(page);
    expect(saved!.bytes.length * 5).toBeLessThan(fixtureBytes('photo-heavy.pdf').length);
    expect((await inspectPdf(saved!.bytes)).pageCount).toBe(1);
    await context.close();
  });
});
