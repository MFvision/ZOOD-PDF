/**
 * Export and Compare through the real interface: pick the tool, choose options, save through the
 * host bridge (File System Access picker stub), then open the saved bytes in the test and inspect
 * them (unzip DOCX/XLSX/ZIP, read the HTML report). English and Arabic.
 */
import path from 'node:path';
import zlib from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { ENGINE_BUILT, ROOT, fixture, openViaCard, pickTool, savedFiles, stubSavePicker, trackExternalRequests } from './helpers';

/** Minimal ZIP reader (stored + deflate) for inspecting saved packages. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  expect(eocd).toBeGreaterThanOrEqual(0);
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const body = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** Paragraph texts of a document.xml (runs concatenated). */
function docxParagraphs(xml: string): { text: string; bidi: boolean }[] {
  return xml
    .split('<w:p>')
    .slice(1)
    .map((p) => {
      const body = p.split('</w:p>')[0] ?? '';
      const text = [...body.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
      return { text, bidi: body.includes('<w:bidi/>') };
    })
    .filter((p) => p.text);
}

const LOCALES = [
  { locale: 'en', browser: 'en-US', exported: /Exported/, saved: /Saved/, reportSuffix: 'comparison' },
  { locale: 'ar', browser: 'ar-SA', exported: /تم تصدير/, saved: /تم حفظ/, reportSuffix: 'مقارنة' },
] as const;

async function exportAs(page: Page, format: string, range?: string) {
  await pickTool(page, 'export');
  await expect(page.locator('[data-testid=export-formats]')).toBeVisible();
  await page.locator(`[data-testid=export-formats] [data-format=${format}]`).click();
  await expect(page.locator(`[data-format=${format}]`)).toHaveAttribute('aria-checked', 'true');
  if (range !== undefined) {
    await page.locator('[data-scope=range]').click();
    await page.locator('[data-testid=export-range]').fill(range);
  }
  await page.locator('[data-testid=export-run]').click();
}

for (const L of LOCALES) {
  test.describe(`export and compare (${L.locale})`, () => {
    test.use({ locale: L.browser });
    test.skip(!ENGINE_BUILT, 'needs the warraq-core engine');

    test('Word export of an Arabic PDF keeps the logical order and marks paragraphs right-to-left', async ({ context, page }) => {
      await stubSavePicker(context);
      const external = trackExternalRequests(page);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', L.locale);
      await openViaCard(page, fixture('sample-ar.pdf'));
      await exportAs(page, 'docx');
      await expect(page.locator('.hud')).toContainText(L.exported);
      const [saved] = await savedFiles(page);
      expect(saved!.name).toBe('sample-ar.docx');
      const files = unzip(saved!.bytes);
      for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) expect(files.has(part), part).toBe(true);
      const xml = files.get('word/document.xml')!.toString('utf8');
      const paras = docxParagraphs(xml);
      const texts = paras.map((p) => p.text);
      expect(texts).toContain('تقرير الربع الأول');
      expect(texts).toContain('هذا ملف اختبار صغير لتطبيق زود PDF، مكتوب باللغة العربية.');
      expect(texts).toContain('العقد رقم ٢٠٢٦ بين الطرفين، والمبلغ ١٥٠٠ ريال سعودي.');
      // page 2 follows a page break, in reading order
      expect(texts.indexOf('الصفحة الثانية')).toBeGreaterThan(texts.indexOf('تقرير الربع الأول'));
      for (const p of paras) expect(p.bidi, p.text).toBe(true);
      expect(xml).toContain('<w:rtl/>');
      expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
      // the document itself is untouched by an export
      await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).not.toContainText(/Edited|معدَّل/);
      expect(external).toEqual([]);
    });

    test('Excel export of an Arabic table gives right-to-left cells in reading order', async ({ context, page }) => {
      await stubSavePicker(context);
      await page.goto('/');
      await openViaCard(page, path.join(ROOT, 'tests/corpus/pdf/chrome-table-cairo.pdf'));
      await exportAs(page, 'xlsx');
      await expect(page.locator('.hud')).toContainText(L.exported);
      const [saved] = await savedFiles(page);
      expect(saved!.name).toBe('chrome-table-cairo.xlsx');
      const files = unzip(saved!.bytes);
      const wb = files.get('xl/workbook.xml')!.toString('utf8');
      expect(wb).toContain(L.locale === 'ar' ? 'name="جدول 1"' : 'name="Table 1"');
      const sheet = files.get('xl/worksheets/sheet1.xml')!.toString('utf8');
      const strings = [...files.get('xl/sharedStrings.xml')!.toString('utf8').matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((m) => m[1]);
      expect(sheet).toContain('rightToLeft="1"');
      const cell = (ref: string) => {
        const m = new RegExp(`<c r="${ref}"( s="\\d+")?( t="s")?><v>([^<]*)</v></c>`).exec(sheet);
        expect(m, ref).not.toBeNull();
        return m![2] ? strings[Number(m![3])] : m![3];
      };
      expect(cell('A1')).toBe('المنتج');
      expect(cell('B1')).toBe('الكمية');
      expect(cell('A2')).toBe('حاسوب محمول');
      expect(cell('B2')).toBe('3');
      expect(cell('D2')).toBe('13500');
      expect(cell('A5')).toBe('لوحة مفاتيح');
    });

    test('pictures export takes a page range in any digits and zips several pages', async ({ context, page }) => {
      await stubSavePicker(context);
      await page.goto('/');
      await openViaCard(page, fixture('sample-ar.pdf'));
      await pickTool(page, 'export');
      await page.locator('[data-format=png]').click();
      await page.locator('[data-scope=range]').click();
      const input = page.locator('[data-testid=export-range]');
      await input.fill('٥');
      await expect(page.locator('.field-error')).toBeVisible();
      await expect(page.locator('[data-testid=export-run]')).toBeDisabled();
      await input.fill(L.locale === 'ar' ? '١-٢' : '1-2');
      await expect(page.locator('[data-testid=export-run]')).toBeEnabled();
      await page.locator('[data-testid=export-run]').click();
      await expect(page.locator('.hud')).toContainText(L.exported);
      const [saved] = await savedFiles(page);
      expect(saved!.name).toBe('sample-ar.zip');
      const files = unzip(saved!.bytes);
      expect([...files.keys()]).toEqual(['sample-ar-1.png', 'sample-ar-2.png']);
      for (const png of files.values()) {
        expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
        // 144 dpi: an A4 page is about 1190 px wide
        expect(png.readUInt32BE(16)).toBeGreaterThan(1100);
      }
    });

    test('compare two versions: the changed word is listed, highlighted and saved in the report', async ({ context, page }) => {
      await stubSavePicker(context);
      const external = trackExternalRequests(page);
      await page.goto('/');
      await openViaCard(page, fixture('compare-v1.pdf'));
      await pickTool(page, 'compare');
      const panel = page.locator('[data-testid=compare-panel]');
      await expect(panel).toBeVisible();
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), panel.locator('[data-testid=compare-choose]').click()]);
      await chooser.setFiles(fixture('compare-v2.pdf'));
      await expect(panel.locator('[data-testid=compare-other]')).toHaveText('compare-v2.pdf');
      const items = panel.locator('[data-testid=compare-change]');
      await expect(items).toHaveCount(1);
      await expect(items.first().locator('del')).toHaveText('ثلاثين');
      await expect(items.first().locator('ins')).toHaveText('عشرين');
      await expect(panel.locator('[data-testid=compare-summary]')).toContainText(L.locale === 'ar' ? 'تعديل واحد' : '1 changed');
      await items.first().click();
      const preview = panel.locator('[data-testid=compare-preview]');
      await expect(preview.locator('.hl-old')).toHaveCount(1);
      await expect(preview.locator('.hl-new')).toHaveCount(1);
      await expect(preview.locator('img')).toHaveCount(2);
      // the visual pass finds the changed area on page 1 only
      const visual = panel.locator('[data-testid=compare-visual] li');
      await expect(visual).toHaveCount(1, { timeout: 30_000 });
      await panel.locator('[data-testid=compare-report]').click();
      await expect(page.locator('.hud')).toContainText(L.saved);
      const [report] = await savedFiles(page);
      expect(report!.name).toBe(`compare-v1-${L.reportSuffix}.html`);
      const html = report!.bytes.toString('utf8');
      expect(html).toContain(`<html lang="${L.locale}" dir="${L.locale === 'ar' ? 'rtl' : 'ltr'}">`);
      expect(html).toContain('<del dir="rtl">ثلاثين</del>');
      expect(html).toContain('<ins dir="rtl">عشرين</ins>');
      expect(html).toContain('data:image/png;base64,');
      expect(html.toLowerCase()).not.toContain('<script');
      expect(external).toEqual([]);
    });

    test('the Convert card opens Export for a chosen PDF', async ({ context, page }) => {
      await stubSavePicker(context);
      await page.goto('/');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-card=convert]').click()]);
      await chooser.setFiles(fixture('sample-en.pdf'));
      await expect(page.locator('[data-testid=export-formats]')).toBeVisible();
      await page.locator('[data-format=text]').click();
      await page.locator('[data-testid=export-run]').click();
      await expect(page.locator('.hud')).toContainText(L.exported);
      const [saved] = await savedFiles(page);
      expect(saved!.name).toBe('sample-en.txt');
      const text = saved!.bytes.toString('utf8');
      expect(text).toContain('Quarterly report');
      expect(text).toContain('Highlight this sentence to test comments and saving.');
    });
  });
}
