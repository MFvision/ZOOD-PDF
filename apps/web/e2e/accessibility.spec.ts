import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, corpus, documentStatus, embedDocument, embedTiles, openPdf, test } from './helpers';
import { callOn, textOf } from './pdfBytes';

const INVOICE = corpus('generated/coretext-sfarabic-mixed-invoice.pdf');
const SCAN = corpus('generated/scan-notonaskh-300dpi-skewed-jpeg.pdf');

const panel = (page: Page) => page.locator('.pane-end');

interface Check {
  id: string;
  status: string;
  detail: string;
}
interface PlanAnswer {
  source: string;
  plan: { lang: string; pages: { blocks: { role: string; text: string }[] }[] };
}

/**
 * The page as PDFium drew it in EmbedPDF's view (the largest image on
 * screen). The first call keeps its pixels in the page; a later call says
 * how many pixels now differ from them, or -1 when the size changed.
 */
async function embedPixels(page: Page, keep: boolean): Promise<number> {
  return page.evaluate(async (keepThem) => {
    const root = document.querySelector('embedpdf-container')?.shadowRoot;
    const images = root ? [...root.querySelectorAll('img')] : [];
    let best: HTMLImageElement | null = null;
    for (const image of images) {
      const rect = image.getBoundingClientRect();
      const onScreen = rect.width > 0 && rect.top < innerHeight && rect.bottom > 0;
      if (onScreen && (!best || image.naturalWidth * image.naturalHeight > best.naturalWidth * best.naturalHeight)) best = image;
    }
    if (!best) return -2;
    await best.decode().catch(() => undefined);
    const canvas = document.createElement('canvas');
    canvas.width = best.naturalWidth;
    canvas.height = best.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) return -2;
    context.drawImage(best, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const store = globalThis as unknown as { keptPixels?: { w: number; h: number; data: Uint8ClampedArray } };
    if (keepThem) {
      store.keptPixels = { w: canvas.width, h: canvas.height, data };
      return 0;
    }
    const kept = store.keptPixels;
    if (!kept || kept.w !== canvas.width || kept.h !== canvas.height) return -1;
    let differ = 0;
    for (let k = 0; k < data.length; k += 4) {
      if (data[k] !== kept.data[k] || data[k + 1] !== kept.data[k + 1] || data[k + 2] !== kept.data[k + 2]) differ += 1;
    }
    return differ;
  }, keep);
}

async function saveFile(page: Page, as: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: /^(Save|حفظ)$/ }).click(),
  ]);
  const path = `test-results/${as}`;
  await download.saveAs(path);
  return path;
}

test.describe('Accessibility: checked, tagged in a reading order a person can change, and drawn the same', () => {
  test.setTimeout(180_000);

  test('an Arabic invoice: the checker fails it, the reading order is reordered and tagged, the checker passes it', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(await embedPixels(page, true)).toBe(0);
    const before = (await embedDocument(page)).id;

    await chooseTool(page, 'Accessibility');
    const p = panel(page);
    await p.getByRole('button', { name: 'Run the check' }).click();
    const results = p.getByRole('list', { name: 'Results' });
    await expect(results.locator('li', { hasText: 'The document is tagged' })).toContainText('Failed');
    await expect(results.locator('li', { hasText: 'Its language is set' })).toContainText('Failed');
    await expect(results.locator('li', { hasText: 'Text stands out from its background' })).toContainText('Look yourself');

    // The reading order, proposed from Warraq's reading, as numbered boxes on the page.
    await p.getByRole('tab', { name: 'Reading order' }).click();
    const order = p.getByRole('list', { name: 'Reading order' });
    await expect(order.locator('li').first()).toBeVisible();
    await expect(p.locator('.access-overlay rect').first()).toBeVisible();
    const items = order.locator('li');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(3);
    const first = (await items.nth(0).locator('.access-block-text').textContent()) ?? '';
    const second = (await items.nth(1).locator('.access-block-text').textContent()) ?? '';
    expect(first).toContain('فاتورة');

    // Dragging the second item above the first swaps them; the arrows put them back.
    await items.nth(1).dragTo(items.nth(0));
    await expect(items.nth(0).locator('.access-block-text')).toHaveText(second);
    await items.nth(0).getByRole('button', { name: 'Read later' }).click();
    await expect(items.nth(0).locator('.access-block-text')).toHaveText(first);

    // The title line becomes a heading.
    await p.getByRole('combobox', { name: 'Role of item 1', exact: true }).selectOption('H1');
    await expect(p.getByRole('combobox', { name: 'Document language' })).toHaveValue('ar');
    await p.getByRole('button', { name: 'Tag the document' }).click();
    await expect(page.getByText('The document is tagged.')).toBeVisible();
    await expect(documentStatus(page)).toContainText('Edited');

    await p.getByRole('tab', { name: 'Check' }).click();
    await expect(results.locator('li', { hasText: 'The document is tagged' })).toContainText('Passed');
    await expect(results.locator('li', { hasText: 'All content is tagged or marked as decoration' })).toContainText('Passed');
    await expect(results.locator('li', { hasText: 'Its language is set' })).toContainText('ar');

    // PDFium draws the tagged page exactly as before: once the view holds
    // the tagged file (a document of its own), its page is the same pixels.
    await expect.poll(async () => (await embedDocument(page)).id).not.toBe(before);
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await expect.poll(() => embedPixels(page, false), { timeout: 30_000 }).toBe(0);

    // The saved file, read by Warraq's core in Node.
    const path = await saveFile(page, 'invoice-tagged.pdf');
    const { result } = await callOn<{ checks: Check[] }>('accessibility.check', path);
    const status = (id: string) => result.checks.find((c) => c.id === id);
    expect(status('tagged')?.status).toBe('passed');
    expect(status('untagged')?.status).toBe('passed');
    expect(status('language')?.detail).toBe('ar');
    const { result: plan } = await callOn<PlanAnswer>('accessibility.plan', path);
    expect(plan.source).toBe('structure');
    const blocks = plan.plan.pages[0]!.blocks.filter((b) => b.role !== 'Artifact');
    expect(blocks[0]?.role).toBe('H1');
    expect(blocks[0]?.text).toContain('فاتورة');
    expect(await textOf(path)).toBe(await textOf(INVOICE));
  });

  test('in Arabic: a scanned page is a figure, and its text is written into the file', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await page.getByRole('menubar').getByRole('combobox', { name: 'Language' }).selectOption({ label: 'العربية' });
    await openPdf(page, SCAN);
    await chooseTool(page, 'إتاحة الوصول');
    const p = panel(page);
    await p.getByRole('tab', { name: 'ترتيب القراءة' }).click();
    await expect(p.getByRole('combobox', { name: 'دور العنصر 1', exact: true })).toHaveValue('Figure');
    await p.getByRole('textbox', { name: 'نص الصورة 1', exact: true }).fill('صفحة ممسوحة من كتاب مطبوع');
    await p.getByRole('button', { name: 'وسم المستند' }).click();
    await expect(page.getByText('تم وسم المستند.')).toBeVisible();
    await expect(page.getByRole('toolbar').getByRole('status', { name: 'حالة المستند' })).toContainText('مُعدَّل');

    // The picture texts, listed with the pictures cut from their pages.
    // Opening the tab finds them.
    await p.getByRole('tab', { name: 'نصوص الصور' }).click();
    await expect(p.locator('.access-figures li')).toHaveCount(2);
    await expect(p.locator('.access-figures textarea').first()).toHaveValue('صفحة ممسوحة من كتاب مطبوع');
    await p.locator('.access-figures textarea').nth(1).fill('الصفحة الثانية من الكتاب');
    await p.getByRole('button', { name: 'احفظ النصوص' }).click();
    // Written into the file only when the panel says so.
    await expect(page.getByText('حُفظت نصوص الصور في الملف.')).toBeVisible();

    const path = await saveFile(page, 'scan-alt.pdf');
    const { result } = await callOn<{ figures: { alt: string | null }[] }>('accessibility.figures', path);
    expect(result.figures.map((f) => f.alt)).toEqual(['صفحة ممسوحة من كتاب مطبوع', 'الصفحة الثانية من الكتاب']);
  });
});
