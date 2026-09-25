import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  ENGINE_BUILT,
  fixture,
  fixtureBytes,
  highlightSecondParagraph,
  latin1,
  openViaCard,
  savedFiles,
  stubSavePicker,
  trackExternalRequests,
  waitForDocument,
  writeTemp,
} from './helpers';

test.describe('open, annotate, save, reopen', () => {
  test('highlight via EmbedPDF, save through the save picker, reopen the saved bytes', async ({ context, page }) => {
    await stubSavePicker(context);
    const external = trackExternalRequests(page);
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    const status = page.locator('[data-testid=document-view]:visible [data-testid=doc-status]');
    await expect(status).toHaveText('Page 1 of 2');
    await expect(page.locator('.doc-name')).toHaveText('sample-en.pdf');

    await highlightSecondParagraph(page);
    await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
    await expect(page.locator('.hud')).toContainText('Saved “sample-en.pdf”');
    await expect(status).not.toContainText('Edited');

    const [saved] = await savedFiles(page);
    expect(saved?.name).toBe('sample-en.pdf');
    const bytes = saved!.bytes;
    const original = fixtureBytes('sample-en.pdf');
    expect(latin1(bytes.subarray(0, 8))).toMatch(/^%PDF-1\.\d/);
    expect(latin1(bytes)).toMatch(/\/Subtype\s*\/Highlight/);
    if (ENGINE_BUILT) {
      // doc.rebase: the saved file is the original file plus one incremental update
      expect(bytes.subarray(0, original.length).equals(original)).toBe(true);
      expect(bytes.length).toBeGreaterThan(original.length);
    } else {
      test.info().annotations.push({ type: 'engine', description: 'warraq-core not built: PDFium rewrite, prefix not checked' });
    }

    // Reopen the saved bytes: the highlight is part of the document.
    const reopened = writeTemp('sample-en-saved.pdf', bytes);
    await page.getByRole('button', { name: 'Home' }).first().click();
    await openViaCard(page, reopened);
    await expect(page.locator('[data-testid=document-view]:visible .doc-name')).toHaveText('sample-en-saved.pdf');
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toHaveText('Page 1 of 2');
    expect(external).toEqual([]);
  });

  test('without the File System Access API, Save downloads the file', async ({ context, page }) => {
    await context.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    await highlightSecondParagraph(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-testid=document-view]:visible [data-testid=save]').click(),
    ]);
    expect(download.suggestedFilename()).toBe('sample-en.pdf');
    const bytes = fs.readFileSync((await download.path())!);
    expect(latin1(bytes)).toMatch(/\/Subtype\s*\/Highlight/);
  });

  test('opens an Arabic PDF and shows Arabic page status in the Arabic interface', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ar' });
    const page = await context.newPage();
    const external = trackExternalRequests(page);
    await page.goto('/');
    await openViaCard(page, fixture('sample-ar.pdf'));
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toHaveText('صفحة ١ من ٢');
    expect(external).toEqual([]);
    await context.close();
  });

  test('rejects a file that is not a PDF', async ({ page }) => {
    await page.goto('/');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-card=open]').click()]);
    await chooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(page.locator('.hud')).toContainText('“notes.txt” is not a PDF');
    await expect(page.locator('[data-testid=home]')).toBeVisible();
  });

  test('a tool picked from the sidebar before any document opens after choosing a file', async ({ page }) => {
    await page.goto('/');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-testid=sidebar-tools] [data-tool=redact]').click()]);
    await chooser.setFiles(fixture('sample-en.pdf'));
    await waitForDocument(page);
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=tool-picker]')).toContainText('Redact');
    await expect(page.locator('[data-epdf-i=redaction-toolbar]')).toBeVisible();
  });
});
