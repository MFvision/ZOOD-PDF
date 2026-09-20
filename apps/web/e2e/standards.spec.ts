import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, corpus, documentStatus, openPdf, test } from './helpers';
import { callOn, textOf } from './pdfBytes';

const INVOICE = corpus('generated/chrome-cairo-mixed-invoice.pdf');
const WORD = corpus('realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf');
const BILEVEL = corpus('generated/scan-arial-200dpi-bilevel.pdf');
const PRESS = new URL('../../../tests/fixtures/icc/test-press-cmyk.icc', import.meta.url).pathname;
const SRGB = new URL('../../../packages/core/warraq-pdf/assets/icc/sRGB-v2-magic.icc', import.meta.url).pathname;

const panel = (page: Page) => page.locator('.pane-end');

interface Validation {
  findings: { total: number; passed: boolean; items: { rule: string }[] };
}

/** Clicks a button that saves a copy, and keeps what was downloaded. */
async function download(page: Page, name: string | RegExp, as: string): Promise<{ path: string; suggested: string }> {
  const [file] = await Promise.all([page.waitForEvent('download'), panel(page).getByRole('button', { name }).click()]);
  const path = `test-results/${as}`;
  await file.saveAs(path);
  return { path, suggested: file.suggestedFilename() };
}

test.describe('Standards: PDF/A and PDF/X-4 copies, checked, and a preflight with page links', () => {
  test.setTimeout(180_000);

  test('in Arabic: an Arabic invoice becomes PDF/A-2b, passes the validator and reads the same', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await page.getByRole('menubar').getByRole('combobox', { name: 'Language' }).selectOption({ label: 'العربية' });
    await openPdf(page, INVOICE);
    await chooseTool(page, 'المعايير');
    const p = panel(page);
    await expect(p.getByRole('tab', { name: 'الأرشفة' })).toHaveAttribute('aria-selected', 'true');
    await expect(p.getByRole('radio', { name: /^PDF\/A-2b/ })).toBeChecked();

    // The file as it is does not meet PDF/A: the validator says why, by rule and clause.
    await p.getByRole('button', { name: 'افحص هذا الملف' }).click();
    await expect(p.getByText(/من المشكلات دون مطابقة هذا الملف/)).toBeVisible();
    await expect(p.locator('.standards-findings li').first()).toContainText('§');

    await p.getByRole('button', { name: 'أنشئ نسخة PDF/A' }).click();
    await expect(p.getByText('تستوفي النسخة PDF/A-2b في كل قاعدة يفحصها محرر PDF.')).toBeVisible();
    const { path, suggested } = await download(page, 'احفظ النسخة', 'invoice-pdfa.pdf');
    expect(suggested).toBe('chrome-cairo-mixed-invoice-PDFA-2b.pdf');

    // The saved bytes, read by Warraq's core in Node: PDF 1.7, valid, the same text.
    expect(readFileSync(path).subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');
    const { result } = await callOn<Validation>('standards.pdfa_validate', path, { level: '2b' });
    expect(result.findings.total).toBe(0);
    expect(await textOf(path)).toBe(await textOf(INVOICE));
    expect(await textOf(path)).toContain('فاتورة ضريبية مبسطة');
  });

  test('a Word file whose fonts are not in it: bundled faces are embedded, and said so', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, WORD);
    await chooseTool(page, 'Standards');
    const p = panel(page);
    await p.getByRole('button', { name: 'Make a PDF/A copy' }).click();
    await expect(p.getByText('The copy meets PDF/A-2b on every rule \u2067محرر PDF\u2069 checks.')).toBeVisible();
    await expect(p.locator('.standards-notes').first()).toContainText('was not in the file');
    await expect(p.locator('.standards-notes').first()).toContainText('Inter');
    // The open file is not changed.
    await expect(documentStatus(page)).not.toContainText('Edited');
  });

  test('PDF/X-4 takes the printer’s profile, refuses a screen profile, and passes', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Standards');
    const p = panel(page);
    await p.getByRole('tab', { name: 'Print' }).click();
    const convert = p.getByRole('button', { name: 'Make a PDF/X-4 copy' });
    await expect(convert).toBeDisabled();

    await p.locator('input[type="file"]').setInputFiles(SRGB);
    await expect(p.getByRole('alert')).toContainText('not a printing press');
    await expect(convert).toBeDisabled();

    await p.locator('input[type="file"]').setInputFiles(PRESS);
    await expect(p.getByText(/Warraq test press/)).toBeVisible();
    await expect(p.getByRole('textbox', { name: 'Printing condition' })).toHaveValue(/Warraq test press/);
    await convert.click();
    await expect(p.getByText('The copy meets PDF/X-4 on every rule \u2067محرر PDF\u2069 checks.')).toBeVisible();
    const { path } = await download(page, 'Save the copy', 'invoice-pdfx.pdf');
    expect(readFileSync(path).subarray(0, 8).toString('latin1')).toBe('%PDF-1.6');
    const { result } = await callOn<Validation>('standards.pdfx_validate', path);
    expect(result.findings.total).toBe(0);
  });

  test('preflight finds a picture too coarse for print, and its link goes to the page', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, BILEVEL);
    await chooseTool(page, 'Standards');
    const p = panel(page);
    await p.getByRole('tab', { name: 'Preflight' }).click();
    await p.getByRole('spinbutton', { name: /Lowest picture resolution/ }).fill('300');
    await p.getByRole('button', { name: 'Run preflight' }).click();
    const coarse = p.locator('.standards-findings li', { hasText: /Pictures at \d+ ppi/ });
    await expect(coarse).toBeVisible();
    await expect(p.locator('.standards-findings li', { hasText: 'No trim box' })).toBeVisible();
    await coarse.getByRole('button', { name: 'Go to page 1' }).click();
    await expect(documentStatus(page)).toContainText('Page 1 of');

    // With a lower bar, the same pictures are fine.
    await p.getByRole('spinbutton', { name: /Lowest picture resolution/ }).fill('100');
    await p.getByRole('button', { name: 'Run preflight' }).click();
    await expect(p.locator('.standards-findings li', { hasText: /Pictures at/ })).toHaveCount(0);
  });
});
