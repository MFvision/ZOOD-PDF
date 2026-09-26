/**
 * Arabic written by ZOOD PDF reads back in logical order everywhere (ADR 0017): Edit an Arabic sentence
 * and Create PDF from an Arabic DOCX through the real interface, save, then read the saved bytes with
 * (a) our engine (`text.plain`, `text.search`), (b) the viewer's own PDFium in Node — what Chrome's
 * viewer and every PDFium-based reader get — and (c) the app's viewer: EmbedPDF's search panel (Ctrl+F)
 * and a text selection copied with Ctrl+C. A Chrome-made Arabic PDF shows why the viewer answers search
 * and copy with the engine: PDFium alone reads its lam-alef as «ال» and cannot find «الاول».
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ENGINE_BUILT, fixture, fixtureBytes, openViaCard, pageBox, pickTool, savedFiles, stubSavePicker, waitForDocument } from './helpers';
import { openInEngine } from './engine';
import { pdfiumText } from './pdfium';

type Rect = { x0: number; y0: number; x1: number; y1: number };
interface ExtractedPage {
  width: number;
  height: number;
  blocks: { paragraphs: { lines: { text: string; bbox: Rect }[] }[] }[];
}

/** Records what the viewer copies (EmbedPDF writes the selection with navigator.clipboard). */
async function stubClipboard(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void w.__copied.push(t), readText: async () => w.__copied.at(-1) ?? '' },
    });
  });
}

/** The engine's box of the line reading `text` on page 0 (points from the top-left). */
async function lineBox(bytes: Buffer, text: string): Promise<{ box: Rect; width: number; height: number }> {
  const doc = await openInEngine(bytes);
  const page = doc.call<{ pages: ExtractedPage[] }>('text.extract', { pages: [0] }).json.pages[0]!;
  doc.close();
  for (const b of page.blocks) for (const p of b.paragraphs) for (const l of p.lines) if (l.text === text) return { box: l.bbox, width: page.width, height: page.height };
  throw new Error(`line not found: ${text}`);
}

/** EmbedPDF's search panel (Ctrl+F): searches `query` and waits for exactly `expected` results (the panel
 * shows "0 results found" while a search is still running, so only the settled count is meaningful). */
async function viewerSearch(page: Page, query: string, expected: number): Promise<void> {
  const container = page.locator('[data-testid=document-view]:visible embedpdf-container');
  const input = container.locator('input[placeholder="Search"]');
  if (!(await input.isVisible())) await page.keyboard.press('Control+f');
  await expect(input).toBeVisible();
  await input.fill(query);
  await expect(container.getByText(/^\d+ results found$/)).toHaveText(`${expected} results found`);
}

/** Selects the whole line `box` of page 0 by dragging across it, copies with Ctrl+C, returns the copy. */
async function copyLine(page: Page, line: { box: Rect; width: number; height: number }): Promise<string> {
  const at = async () => {
    const pb = await pageBox(page, 0);
    const k = pb.width / line.width;
    return {
      key: `${pb.x},${pb.y},${pb.width}`,
      y: pb.y + ((line.box.y0 + line.box.y1) / 2) * k,
      right: pb.x + (line.box.x1 - 0.8) * k,
      left: pb.x + (line.box.x0 + 0.8) * k,
    };
  };
  // The selection layer answers hovering text with an I-beam once the page's glyph geometry is loaded.
  const cursorAt = (x: number, yy: number) =>
    page.evaluate(
      ([px, py]) => {
        const root = document.querySelector('[data-testid=document-view]:not([hidden]) embedpdf-container')!.shadowRoot!;
        const el = root.elementFromPoint(px!, py!);
        return el ? getComputedStyle(el).cursor : '';
      },
      [x, yy],
    );
  // Ready = the page no longer moves (opening the search panel re-centres it and scrolls to the active
  // result) AND hovering the line's first glyph shows the I-beam.
  let nudge = 0;
  let pos = await at();
  await expect
    .poll(async () => {
      nudge = 0.5 - nudge;
      const now = await at();
      const still = now.key === pos.key;
      pos = now;
      await page.mouse.move(pos.right, pos.y + nudge);
      return still && (await cursorAt(pos.right, pos.y + nudge)) === 'text' && (await at()).key === pos.key;
    })
    .toBe(true);
  const { left, right, y } = pos;
  await page.mouse.down();
  await page.mouse.move((left + right) / 2, y, { steps: 6 });
  await page.mouse.move(left, y, { steps: 6 });
  await page.mouse.up();
  const before = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.length);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.length)).toBeGreaterThan(before);
  return page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1)!);
}

async function reopen(page: Page, name: string, bytes: Buffer) {
  await page.goto('/');
  await openViaCard(page, { name, mimeType: 'application/pdf', buffer: bytes });
}

test.describe('Arabic text reads back in logical order: engine, PDFium, viewer search and copy', () => {
  test.skip(!ENGINE_BUILT, 'needs the warraq-core engine');

  test('Edit: an Arabic sentence edited and saved', async ({ context, page }) => {
    test.setTimeout(180_000);
    const ORIGINAL = 'هذه الجملة الأولى سيتم تعديلها في اختبار التحرير.';
    const EDITED = 'هذه جملة جديدة للبحث والنسخ في العارض.';
    await stubSavePicker(context);
    await stubClipboard(context);
    await page.goto('/');
    await openViaCard(page, fixture('edit-ar.pdf'));
    await pickTool(page, 'edit');
    const surface = page.locator('[data-testid=edit-surface]');
    await expect(surface).toHaveAttribute('data-busy', 'false', { timeout: 30_000 });
    await page.locator(`[data-testid=edit-block][data-text="${ORIGINAL}"]`).click();
    await page.locator('[data-testid=edit-textarea]').fill(EDITED);
    await page.locator('[data-testid=edit-apply]').click();
    await expect(page.locator(`[data-testid=edit-block][data-text="${EDITED}"]`)).toHaveCount(1, { timeout: 30_000 });
    await expect(surface).toHaveAttribute('data-busy', 'false', { timeout: 30_000 });
    await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
    await expect.poll(async () => (await savedFiles(page)).length, { timeout: 30_000 }).toBe(1);
    const bytes = (await savedFiles(page))[0]!.bytes;

    // (a) the engine
    const doc = await openInEngine(bytes);
    expect(doc.plain()).toContain(EDITED);
    expect(doc.call<{ hits: unknown[] }>('text.search', { query: 'للبحث' }).json.hits).toHaveLength(1);
    doc.close();
    // (b) PDFium (Chrome's viewer): the edited words carry no ActualText, their glyphs say it.
    const pd = await pdfiumText(bytes);
    expect(pd.pages[0]).toContain(EDITED);
    expect(pd.count('للبحث')).toBe(1);
    expect(pd.count('العارض')).toBe(1);
    pd.close();
    // (c) the app's viewer
    await reopen(page, 'edited.pdf', bytes);
    await viewerSearch(page, 'للبحث', 1);
    expect(await copyLine(page, await lineBox(bytes, EDITED))).toBe(EDITED);
  });

  test('Create PDF: an Arabic DOCX converted and saved', async ({ context, page }) => {
    test.setTimeout(180_000);
    const HEADING = 'تقرير الربع الأول';
    await stubSavePicker(context);
    await stubClipboard(context);
    await page.goto('/');
    await page.locator('[data-card=create]').click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-testid=create-choose]').click()]);
    await chooser.setFiles(fixture('create/report.docx'));
    await page.locator('[data-testid=create-run]').click();
    await waitForDocument(page);
    await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
    await expect.poll(async () => (await savedFiles(page)).length, { timeout: 30_000 }).toBe(1);
    const bytes = (await savedFiles(page))[0]!.bytes;

    const doc = await openInEngine(bytes);
    const text = doc.plain();
    for (const s of [HEADING, 'الرياض', 'النتيجة ممتازة في عام 2024 بنسبة 35%.']) expect(text).toContain(s);
    expect(doc.call<{ hits: unknown[] }>('text.search', { query: 'الرياض' }).json.hits).toHaveLength(1);
    const withoutHamza = doc.call<{ hits: unknown[] }>('redact.find', { query: 'الاول' }).json.hits.length;
    expect(withoutHamza).toBeGreaterThanOrEqual(3);
    doc.close();

    const pd = await pdfiumText(bytes);
    expect(pd.pages[0]).toContain(HEADING);
    expect(pd.pages[0]).toContain('الرياض');
    expect(pd.count('الربع')).toBe(2);
    expect(pd.count('الرياض')).toBe(1);
    pd.close();

    await reopen(page, 'report.pdf', bytes);
    await viewerSearch(page, 'الرياض', 1);
    // Arabic-aware (as the engine): typed without hamza, «الأول» is still found everywhere.
    await viewerSearch(page, 'الاول', withoutHamza);
    expect(await copyLine(page, await lineBox(bytes, HEADING))).toBe(HEADING);
  });

  test('a Chrome-made Arabic PDF: the viewer searches Arabic-aware and copies in logical order where PDFium alone cannot', async ({ context, page }) => {
    const LINE = 'تقرير الربع الأول';
    const bytes = fixtureBytes('sample-ar.pdf');
    // PDFium on its own: lam-alef of «الأول» (one ActualText cluster) comes back reversed.
    const pd = await pdfiumText(bytes);
    expect(pd.pages[0]).not.toContain(LINE);
    expect(pd.count('الأول')).toBe(0);
    pd.close();
    await stubClipboard(context);
    await page.goto('/');
    await openViaCard(page, fixture('sample-ar.pdf'));
    await viewerSearch(page, 'الاول', 1);
    expect(await copyLine(page, await lineBox(bytes, LINE))).toBe(LINE);
  });
});
