import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { PRESENTATION, SPREADSHEET, validate } from '../../../packages/ui/src/export/ooxml.testing';
import { WORD_EXPORT, chooseTool, corpus, openPdf, test } from './helpers';

/** A Chrome print of an Arabic invoice: its items are an HTML table, drawn with rules. */
const INVOICE = corpus('generated/chrome-cairo-mixed-invoice.pdf');

const panel = (page: Page) => page.locator('.pane-end');

async function exportAs(page: Page, format: string, option?: [string, string]): Promise<{ name: string; files: Record<string, Uint8Array> }> {
  await panel(page).getByRole('radio', { name: format }).check();
  if (option) await panel(page).getByRole('combobox', { name: option[0] }).selectOption({ label: option[1] });
  const [download] = await Promise.all([page.waitForEvent('download'), panel(page).getByRole('button', { name: 'Export', exact: true }).click()]);
  const name = download.suggestedFilename();
  const path = `test-results/office-${name}`;
  await download.saveAs(path);
  await expect(panel(page).getByRole('status')).toHaveText(`Exported “${name}”.`);
  return { name, files: unzipSync(new Uint8Array(readFileSync(path))) };
}

/** Every XML part: accepted by the browser's own parser, and in the order ECMA-376 sets. */
async function checkParts(page: Page, files: Record<string, Uint8Array>, models: Parameters<typeof validate>[1]) {
  for (const [path, bytes] of Object.entries(files)) {
    if (!/\.(xml|rels)$/.test(path)) continue;
    const xml = strFromU8(bytes);
    const parsed = await page.evaluate((source) => new DOMParser().parseFromString(source, 'application/xml').getElementsByTagName('parsererror').length, xml);
    expect(parsed, `${path} is well formed`).toBe(0);
    expect(validate(xml, models), path).toEqual([]);
  }
}

test.describe('Export to Excel and PowerPoint', () => {
  test('an Arabic invoice’s table becomes a right-to-left sheet, cell for cell, numbers as numbers', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Export');
    await expect(panel(page).getByText('Each table on the pages')).toBeVisible();
    const { name, files } = await exportAs(page, 'Excel (.xlsx)');
    expect(name).toBe('chrome-cairo-mixed-invoice.xlsx');
    await checkParts(page, files, SPREADSHEET);
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('rightToLeft="1"');
    // The table's first column, the description, is column A; its header row reads in order.
    // Its rules are borders, so its cells carry a style.
    const row = (text: string) => new RegExp(`<row r="\\d+"><c r="A\\d+" s="\\d+" t="inlineStr"><is><t xml:space="preserve">${text}</t>`);
    expect(sheet).toMatch(row('الوصف'));
    expect(sheet).toMatch(/<t xml:space="preserve">الوصف<\/t><\/is><\/c><c r="B\d+" s="\d+" t="inlineStr"><is><t xml:space="preserve">الكمية<\/t>/);
    // 1,200.00 is the number 1200, shown with its grouping and decimals.
    expect(sheet).toMatch(/<c r="[C-D]\d+" s="\d+"><v>1200<\/v><\/c>/);
    expect(strFromU8(files['xl/styles.xml']!)).toContain('numFmtId="4"');
    expect(sheet).toContain('اشتراك سنوي في خدمة Warraq Pro');
    // Brackets face each other, as written.
    expect(sheet).toContain('دعم فني (Premium Support)');
    expect(strFromU8(files['xl/styles.xml']!)).toContain('<left style="thin">');
    // The lines around the table are rows of their own.
    expect(sheet).toContain('فاتورة ضريبية مبسطة');

    const byTable = await exportAs(page, 'Excel (.xlsx)', ['Sheets', 'One for each table (each page’s when there is none)']);
    const workbook = strFromU8(byTable.files['xl/workbook.xml']!);
    expect(workbook).toContain('name="Table 1"');
    expect(strFromU8(byTable.files['xl/worksheets/sheet1.xml']!)).not.toContain('فاتورة ضريبية مبسطة');
  });

  test('each page a slide: the page without its text behind editable Arabic text boxes, or text alone', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await chooseTool(page, 'Export');
    const { name, files } = await exportAs(page, 'PowerPoint (.pptx)');
    expect(name).toBe('A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pptx');
    await checkParts(page, files, PRESENTATION);
    const slides = Object.keys(files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
    expect(slides.length).toBe(Number((await page.getByRole('toolbar').getByRole('status', { name: 'Document status' }).textContent())?.match(/of (\d+)/)?.[1]));
    const first = strFromU8(files['ppt/slides/slide1.xml']!);
    // In reading order, as Warraq reads it, not PDFium's visual order.
    expect(first).toContain('صباح الخير');
    expect(first).toContain('rtl="1"');
    // A page of text without its text is blank paper: no picture is put behind it.
    expect(files['ppt/media/page1.png']).toBeUndefined();
    expect(first).not.toContain('r:embed');

    const textOnly = await exportAs(page, 'PowerPoint (.pptx)', ['Slides', 'Text only']);
    expect(Object.keys(textOnly.files).some((p) => p.startsWith('ppt/media/'))).toBe(false);
    expect(strFromU8(textOnly.files['ppt/slides/slide1.xml']!)).toContain('صباح الخير');
  });
});
