/**
 * Redact through the engine (true removal): find with an Arabic tashkeel variant, personal-data patterns,
 * "Remove hidden information", marks drawn in EmbedPDF — each applied, saved through the host bridge,
 * reopened from the saved bytes and inspected with the engine. English and Arabic interfaces.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixture, fixtureBytes, latin1, openViaCard, drawRedactionMark, pickTool, savedFiles, stubSavePicker, waitForDocument } from './helpers';
import { openInEngine } from './engine';

const utf16 = (s: string) => Buffer.from([...s].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff]));

async function setup(browser: Browser, locale: 'en' | 'ar'): Promise<Page> {
  const context = await browser.newContext({ locale });
  await stubSavePicker(context);
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

async function applyAndSave(page: Page): Promise<Buffer> {
  const panel = page.locator('[data-testid=redact-panel]');
  await panel.locator('[data-testid=redact-apply]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('[data-testid=redact-confirm]').click();
  await waitForDocument(page);
  await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toContainText(/Edited|معدَّل/);
  const before = (await savedFiles(page)).length;
  await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
  await expect.poll(async () => (await savedFiles(page)).length, { timeout: 30_000 }).toBeGreaterThan(before);
  const saved = await savedFiles(page);
  expect(saved.length).toBeGreaterThan(0);
  return saved[saved.length - 1]!.bytes;
}

for (const locale of ['en', 'ar'] as const) {
  test.describe(`Redact through the engine (${locale})`, () => {
    test('find an Arabic word typed with tashkeel, mark, apply, save: gone from text and bytes, one revision', async ({ browser }) => {
      const page = await setup(browser, locale);
      await openViaCard(page, fixture('redact-ar.pdf'));
      await pickTool(page, 'redact');
      const panel = page.locator('[data-testid=redact-panel]');
      await expect(panel).toBeVisible();
      // EmbedPDF's own "apply" (PDFium) is not offered: the engine applies.
      await expect(page.locator('[data-epdf-i=redaction-toolbar]')).toBeVisible();
      await expect(page.locator('[data-epdf-i=apply-redaction]')).toBeHidden();
      await panel.locator('[data-testid=redact-query]').fill('مُحَمَّد');
      await panel.locator('[data-testid=redact-find]').click();
      await expect(panel.locator('[data-testid=redact-results]')).toHaveAttribute('data-count', '2');
      await expect(panel.locator('.hit-text').first()).toHaveText('محمد');
      await panel.locator('[data-testid=redact-mark]').click();
      await expect(panel.locator('[data-testid=redact-marks]')).toHaveAttribute('data-count', '2');

      const bytes = await applyAndSave(page);
      expect(latin1(bytes)).toMatch(/^%PDF-/);
      const original = fixtureBytes('redact-ar.pdf');
      expect(bytes.subarray(0, original.length).equals(original)).toBe(false);
      const doc = await openInEngine(bytes);
      const text = doc.plain();
      expect(text).not.toContain('محمد');
      expect(text).toContain('عبدالله');
      expect(text).toContain('هذا السطر يبقى كما هو');
      expect(doc.info().revisions).toBe(1);
      expect(doc.call<{ hits: unknown[] }>('redact.find', { query: 'محمد' }).json.hits).toHaveLength(0);
      expect(bytes.includes(Buffer.from('محمد'))).toBe(false);
      expect(bytes.includes(utf16('محمد'))).toBe(false);
      doc.close();

      // Recents: the first-page picture of the unredacted file is gone.
      await page.locator('[data-testid=document-view]:visible').getByRole('button', { name: /Home|الرئيسية/ }).first().click();
      const card = page.locator('[data-testid=recent-card][data-name="redact-ar.pdf"]');
      await expect(card.locator('.thumb-placeholder')).toBeVisible();
      await expect(card.locator('img.thumb-img')).toHaveCount(0);
      await page.context().close();
    });

    test('patterns: email, Saudi ID (Arabic-Indic digits too) and IBAN are found, applied and gone', async ({ browser }) => {
      const page = await setup(browser, locale);
      await openViaCard(page, fixture('pii.pdf'));
      await pickTool(page, 'redact');
      const panel = page.locator('[data-testid=redact-panel]');
      for (const k of ['email', 'saudiId', 'iban']) await panel.locator(`[data-pattern=${k}]`).check();
      await panel.locator('[data-testid=redact-find]').click();
      await expect(panel.locator('[data-testid=redact-results]')).toHaveAttribute('data-count', '4');
      await expect(panel.locator('[data-kind=iban] .hit-text')).toHaveText('SA03 8000 0000 6080 1016 7519');
      // Applied straight from the selected results (no marks drawn).
      const bytes = await applyAndSave(page);
      const doc = await openInEngine(bytes);
      const text = doc.plain();
      for (const gone of ['sara.k@example.com', '1010101010', 'SA03', '6080 1016', '٢٠٠٠٠٠٠٠٠٦']) expect(text).not.toContain(gone);
      expect(text).toContain('Customer record');
      expect(text).toContain('1000000009'); // fails the check digit: kept
      expect(doc.info().revisions).toBe(1);
      expect(latin1(bytes)).not.toContain('sara.k@example.com');
      doc.close();
      await page.context().close();
    });

    test('remove hidden information: scripts, attachment, XMP, info, comments, hidden layer and invisible text', async ({ browser }) => {
      const page = await setup(browser, locale);
      await openViaCard(page, fixture('hidden-info.pdf'));
      await pickTool(page, 'redact');
      await page.locator('[data-testid=sanitize-open]').click();
      const sheet = page.getByRole('dialog');
      for (const k of ['metadata', 'xmp', 'javascript', 'actions', 'attachments', 'comments', 'hiddenLayers', 'hiddenText']) {
        await expect(sheet.locator(`[data-sanitize=${k}]`)).toBeChecked();
      }
      await expect(sheet.locator('[data-sanitize=links]')).not.toBeChecked();
      await expect(sheet.locator('[data-sanitize=bookmarks]')).not.toBeChecked();
      await sheet.locator('[data-testid=sanitize-run]').click();
      const report = page.locator('[data-testid=sanitize-report]');
      await expect(report).toBeVisible();
      for (const k of ['javascript', 'attachments', 'xmp', 'metadata', 'comments', 'hiddenLayers', 'hiddenText']) {
        await expect(report.locator(`[data-item=${k}]`)).toBeVisible();
      }
      if (locale === 'ar') await expect(report).toContainText(/[٠-٩]/);
      await page.locator('[data-testid=sanitize-done]').click();
      await waitForDocument(page);
      await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
      await expect.poll(async () => (await savedFiles(page)).length, { timeout: 30_000 }).toBeGreaterThan(0);
      const [saved] = await savedFiles(page);
      const bytes = saved!.bytes;
      const raw = latin1(bytes);
      for (const gone of ['/JavaScript', '/JS', 'ATTACHMENT PAYLOAD', 'XMP SECRET', 'SECRET AUTHOR', '/EmbeddedFiles', 'Reviewer comment', '/OpenAction']) {
        expect(raw, gone).not.toContain(gone);
      }
      const doc = await openInEngine(bytes);
      const text = doc.plain();
      expect(text).toContain('This paragraph is visible and stays.');
      expect(text).not.toContain('HIDDEN LAYER SECRET');
      expect(text).not.toContain('INVISIBLE OCR SECRET');
      expect(doc.info().revisions).toBe(1);
      doc.close();
      await page.context().close();
    });
  });
}

test('marks drawn with EmbedPDF are applied by the engine (drag across the first paragraph)', async ({ browser }) => {
  const page = await setup(browser, 'en');
  await openViaCard(page, fixture('sample-en.pdf'));
  await pickTool(page, 'redact');
  await page.locator('[data-epdf-i=redact]').click();
  await drawRedactionMark(page, [0.08, 0.145], [0.85, 0.185]);
  const bytes = await applyAndSave(page);
  const doc = await openInEngine(bytes);
  const text = doc.plain();
  expect(text).not.toContain('small two-page fixture');
  expect(text).toContain('Quarterly report');
  expect(text).toContain('Highlight this sentence');
  expect(doc.info().revisions).toBe(1);
  doc.close();
  await page.context().close();
});
