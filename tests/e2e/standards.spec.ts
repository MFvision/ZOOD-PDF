import { expect, test, type Page } from '@playwright/test';
import { fixture, fixtureBytes, latin1, openViaCard, pickTool, savedFiles, stubSavePicker, trackExternalRequests, waitForDocument } from './helpers';

const panel = (page: Page) => page.locator('[data-testid=document-view]:visible [data-testid=standards-panel]');

async function checkProfile(page: Page, profile: string) {
  await panel(page).locator(`[data-profile=${profile}]`).click();
  await panel(page).locator('[data-testid=std-check]').click();
}

/** Opens a saved file from disk bytes through the Open card. */
async function reopen(page: Page, name: string, bytes: Buffer) {
  await page.locator('[data-testid=document-view]:visible').getByRole('button', { name: /^(Home|الرئيسية)$/ }).first().click();
  await openViaCard(page, { name, mimeType: 'application/pdf', buffer: bytes });
  await waitForDocument(page);
}

for (const locale of ['en', 'ar'] as const) {
  test(`Standards (${locale}): validate a Chromium PDF, convert to PDF/A-2b, save as a new file, reopen and re-check`, async ({ browser }) => {
    const context = await browser.newContext({ locale });
    await stubSavePicker(context);
    const page = await context.newPage();
    const external = trackExternalRequests(page);
    await page.goto('/');
    const file = locale === 'ar' ? 'sample-ar.pdf' : 'sample-en.pdf';
    await openViaCard(page, fixture(file));

    await pickTool(page, 'standards');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('radio')).toHaveCount(6);

    // 1. Validate: the Chromium file is not PDF/A (no XMP, no output intent, no /ID).
    await checkProfile(page, 'pdfa-2b');
    const report = panel(page).locator('[data-testid=std-report]');
    await expect(report).toHaveAttribute('data-conforms', 'false');
    await expect(report.locator('.std-finding[data-rule=metadata-present]')).toBeVisible();
    await expect(report.locator('.std-finding[data-rule=device-colour]').first()).toBeVisible();
    // Grouped by ISO clause, with the clause cited and object references shown.
    await expect(report.locator('[data-clause="6.6.2.1"] .std-clause')).toContainText('ISO 19005-2:2011');
    await expect(report.locator('[data-clause="6.2.4.3"]')).toBeVisible();
    await expect(report.locator('.std-ref').first()).toContainText(/ R/);
    if (locale === 'ar') {
      await expect(report.locator('.std-verdict')).toHaveText('لا يطابق PDF/A-2b');
      await expect(report.locator('[data-clause="6.6.2.1"] .std-clause')).toContainText('البند');
      await expect(report.locator('.std-finding[data-rule=metadata-present] .std-msg')).toHaveText('المستند بلا بيانات XMP وصفية.');
    } else {
      await expect(report.locator('.std-verdict')).toHaveText('Does not conform to PDF/A-2b');
      await expect(report.locator('.std-finding[data-rule=metadata-present] .std-msg')).toHaveText('The document has no XMP metadata.');
    }

    // 2. Fix automatically → the engine converts and re-validates the new file.
    await panel(page).locator('[data-testid=std-fix]').click();
    const after = panel(page).locator('[data-testid=std-after]');
    await expect(after).toHaveAttribute('data-conforms', 'true', { timeout: 30_000 });
    await expect(after).toHaveAttribute('data-errors', '0');
    await expect(panel(page).locator('[data-action=write-metadata]')).toBeVisible();
    await expect(panel(page).locator('[data-action=add-output-intent]')).toBeVisible();
    await expect(after.locator('.std-verdict')).toHaveText(locale === 'ar' ? 'يطابق PDF/A-2b' : 'Conforms to PDF/A-2b');

    // 3. Save as a new file via the host bridge; the open document is untouched.
    await panel(page).locator('[data-testid=std-save]').click();
    await expect(page.locator('.hud')).toContainText(locale === 'ar' ? 'حُفظ' : 'Saved');
    const saved = await savedFiles(page);
    const expectedName = file.replace('.pdf', '-PDFA-2b.pdf');
    const out = saved.find((s) => s.name === expectedName);
    expect(out, `saved ${saved.map((s) => s.name).join(', ')}`).toBeTruthy();
    const text = latin1(out!.bytes);
    expect(text).toMatch(/^%PDF-1\.7\n%[\x80-\xff]{4}/);
    expect(text).toContain('<pdfaid:part>2</pdfaid:part>');
    expect(text).toContain('<pdfaid:conformance>B</pdfaid:conformance>');
    expect(text).toMatch(/\/S \/GTS_PDFA1/);
    expect(text).toContain('/DestOutputProfile');
    expect(text).toMatch(/\/ID \[<[0-9A-F]{32}> <[0-9A-F]{32}>\]/);
    const original = fixtureBytes(file);
    expect(out!.bytes.subarray(0, original.length).equals(original)).toBe(false); // a whole rewrite, a new file
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).not.toContainText(/Edited|معدَّل/);

    // 4. Reopen the saved bytes in the app and validate them again: zero errors.
    await reopen(page, expectedName, out!.bytes);
    await pickTool(page, 'standards');
    await checkProfile(page, 'pdfa-2b');
    const again = panel(page).locator('[data-testid=std-report]');
    await expect(again).toHaveAttribute('data-conforms', 'true');
    await expect(again).toHaveAttribute('data-errors', '0');
    await expect(again.locator('.std-finding.error')).toHaveCount(0);
    // It is not PDF/A-2u: the identification says level B.
    await checkProfile(page, 'pdfa-2u');
    await expect(panel(page).locator('[data-testid=std-report] .std-finding[data-rule=pdfa-identification]')).toBeVisible();

    expect(external).toEqual([]);
    await context.close();
  });
}

test('Standards: PDF/X-4 conversion and preflight', async ({ context, page }) => {
  await stubSavePicker(context);
  await page.goto('/');
  await openViaCard(page, fixture('sample-en.pdf'));
  await pickTool(page, 'standards');

  await checkProfile(page, 'preflight');
  const pf = panel(page).locator('[data-testid=std-preflight]');
  await expect(pf.locator('[data-section=fonts]')).toContainText('LiberationSans');
  await expect(pf.locator('[data-section=fonts] [data-embedded=true]').first()).toBeVisible();
  await expect(pf.locator('[data-section=boxes]')).toContainText('mediaBox');

  await checkProfile(page, 'pdfx-4');
  const report = panel(page).locator('[data-testid=std-report]');
  await expect(report.locator('.std-finding[data-rule=x4-version]')).toBeVisible();
  await expect(report.locator('.std-finding[data-rule=x4-boxes]').first()).toBeVisible();
  await panel(page).locator('[data-testid=std-fix]').click();
  await expect(panel(page).locator('[data-testid=std-after]')).toHaveAttribute('data-conforms', 'true', { timeout: 30_000 });
  await panel(page).locator('[data-testid=std-save]').click();
  await expect.poll(async () => (await savedFiles(page)).map((s) => s.name)).toContain('sample-en-PDFX-4.pdf');
  const out = (await savedFiles(page)).find((s) => s.name === 'sample-en-PDFX-4.pdf')!;
  const text = latin1(out.bytes);
  expect(text).toContain('<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>');
  expect(text).toMatch(/\/S \/GTS_PDFX/);
  expect(text).toContain('/TrimBox');
  expect(text).toContain('/Trapped /False');

  // Closing the panel returns to the viewer.
  await panel(page).getByRole('button', { name: 'Close Standards' }).click();
  await expect(panel(page)).toHaveCount(0);
});
