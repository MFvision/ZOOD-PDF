import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export const corpus = (name: string): string =>
  fileURLToPath(new URL(`../../../tests/corpus/arabic/${name}`, import.meta.url));

/** A real Word 2016 Arabic export — the GATE 2 file. */
export const WORD_EXPORT = corpus(
  'realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf',
);
/** A generated Arabic invoice with a clean ToUnicode: every line is checkable. */
export const INVOICE = corpus('generated/raw-amiri-cid-identity-tounicode.pdf');
/** A real Acrobat form with RTL and LTR text fields. */
export const ARABIC_FORM = corpus(
  'realworld/F_pdfjs15546_rtl_acroform_textfields_arabic_digits_acrobat.pdf',
);

/**
 * The slice of EmbedPDF's plugin registry these helpers read. Only a type: the
 * reads run inside the page, where `<embedpdf-container>` exposes the registry.
 */
interface EmbedRegistry {
  getPlugin(id: string): { provides?: () => EmbedPlugin } | null;
  getEngine(): {
    getPageAnnoWidgets(document: unknown, page: unknown): { toPromise(): Promise<{ field?: { value?: string } }[]> };
  };
}
interface EmbedPlugin {
  getActiveDocumentId(): string;
  getActiveDocument(): { pages: unknown[] } | null;
  forDocument(id: string): { getState(): Record<string, unknown>; getActiveMode(): string; getCurrentPage(): number };
}
type EmbedElement = { registry: Promise<EmbedRegistry> };

/**
 * Every test fails if anything leaves the app, or if the app asks for a file
 * it does not have. EmbedPDF reaches for jsDelivr and Google Fonts out of the
 * box; Warraq must not (N1, N7). A request the CSP blocks, or one that comes
 * back 404, is also a feature that silently does not work.
 */
export const test = base.extend<{ stayLocal: string[] }>({
  stayLocal: async ({ page, baseURL }, use) => {
    const outside: string[] = [];
    const home = new URL(baseURL ?? 'http://127.0.0.1').origin;
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(`${home}/`) && !/^(blob|data):/.test(url)) outside.push(url);
    });
    // EmbedPDF's Arabic fallback font and its stamps were 404s once.
    page.on('response', (response) => {
      if (response.status() >= 400) outside.push(`${response.status()} ${response.url()}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error' && /Content Security Policy/.test(message.text()) && !/frame-ancestors/.test(message.text())) {
        outside.push(`blocked by CSP: ${message.text().slice(0, 160)}`);
      }
    });
    await use(outside);
    expect(outside, 'no request may leave the app, and none may go unanswered').toEqual([]);
  },
});

/** Dark pixels on a page canvas, sampled; zero means nothing was drawn. */
export async function ink(canvas: Locator): Promise<number> {
  return canvas.evaluate((node) => {
    const c = node as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx || c.width === 0 || c.height === 0) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 16) if ((data[i] ?? 255) < 128) dark += 1;
    return dark;
  });
}

/** Rendered page tiles inside EmbedPDF's shadow root. */
export async function embedTiles(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.querySelector('embedpdf-container')?.shadowRoot;
    if (!root) return 0;
    return [...root.querySelectorAll('img')].filter((img) => img.naturalWidth > 100).length;
  });
}

/** Opens a PDF the way a person does, and waits until EmbedPDF has drawn it. */
export async function openPdf(page: Page, file: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
}

/** Chooses a tool from the tools pane, as a person does — back to the list first if a tool is open. */
export async function chooseTool(page: Page, name: string): Promise<void> {
  const back = page.getByRole('button', { name: 'Back to all tools' });
  if (await back.isVisible()) await back.click();
  await page.locator('.pane-end .tool-card', { hasText: name }).first().click();
}

/** Switches to Warraq's editor and waits until its page 1 has real ink. */
export async function enterEditText(page: Page): Promise<Locator> {
  await chooseTool(page, 'Edit');
  const first = page.locator('section[data-page="1"]');
  await expect(first).toBeVisible();
  await expect.poll(() => ink(first.locator('canvas.page-canvas'))).toBeGreaterThan(200);
  return first;
}

/**
 * The page itself, for drawing and dragging on: the largest image EmbedPDF
 * shows *on screen*, measured again until it stops moving. The first image is
 * often a sidebar thumbnail, and choosing a tool adds a toolbar row that
 * shifts the page — both made strokes land in the wrong place at first.
 */
export async function pageBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const measure = () =>
    page.evaluate(() => {
      const root = document.querySelector('embedpdf-container')?.shadowRoot;
      const images = root ? [...root.querySelectorAll('img')] : [];
      let best: DOMRect | null = null;
      for (const image of images) {
        const rect = image.getBoundingClientRect();
        const onScreen = rect.width > 0 && rect.top < innerHeight && rect.left < innerWidth && rect.bottom > 0;
        if (onScreen && (!best || rect.width * rect.height > best.width * best.height)) best = rect;
      }
      return best ? { x: best.x, y: best.y, width: best.width, height: best.height } : null;
    });
  // Switching mode shows that mode's toolbar a beat later, which shrinks the
  // viewport and re-fits the zoom: a box that held still for one frame can
  // still be the old layout. Wait until it has held still for 600 ms.
  let previous = await measure();
  let steady = 0;
  for (let attempt = 0; attempt < 40 && steady < 4; attempt += 1) {
    await page.waitForTimeout(150);
    const current = await measure();
    steady = current && previous && JSON.stringify(current) === JSON.stringify(previous) ? steady + 1 : 0;
    previous = current;
  }
  if (!previous) throw new Error('EmbedPDF shows no page');
  return previous;
}

/**
 * What EmbedPDF found in the open document: the annotation subtypes on a page
 * (INK 15, WIDGET 20, FREETEXT 3, HIGHLIGHT 9, …). Asked of its own registry, so
 * after a save-and-reopen this reads the file, not what was left on screen.
 */
export async function annotationTypes(page: Page, pageIndex = 0): Promise<number[]> {
  return page.evaluate(async (index) => {
    type State = { pages?: Record<number, string[]>; byUid?: Record<string, { object?: { type?: number } }> };
    const registry = await (document.querySelector('embedpdf-container') as unknown as EmbedElement).registry;
    const id = registry.getPlugin('document-manager')?.provides?.().getActiveDocumentId() ?? '';
    const state = registry.getPlugin('annotation')?.provides?.().forDocument(id).getState() as State | undefined;
    return (state?.pages?.[index] ?? []).map((uid) => state?.byUid?.[uid]?.object?.type ?? -1);
  }, pageIndex);
}

/** Form field values on a page, read through EmbedPDF's engine. */
export async function fieldValues(page: Page, pageIndex = 0): Promise<string[]> {
  return page.evaluate(async (index) => {
    const registry = await (document.querySelector('embedpdf-container') as unknown as EmbedElement).registry;
    const doc = registry.getPlugin('document-manager')?.provides?.().getActiveDocument();
    if (!doc) return [];
    const widgets = await registry.getEngine().getPageAnnoWidgets(doc, doc.pages[index]).toPromise();
    return (widgets ?? []).map((widget) => widget.field?.value ?? '');
  }, pageIndex);
}

/** EmbedPDF's current interaction mode: "pointerMode", "ink", a redaction or form tool… */
export async function activeMode(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const registry = await (document.querySelector('embedpdf-container') as unknown as EmbedElement).registry;
    const id = registry.getPlugin('document-manager')?.provides?.().getActiveDocumentId() ?? '';
    return String(registry.getPlugin('interaction-manager')?.provides?.().forDocument(id).getActiveMode() ?? '');
  });
}

/**
 * Runs a tool-pane control and waits until EmbedPDF has really switched into
 * it. A stroke in the first frame after the click lands on the pointer tool
 * and draws nothing; a person never draws that fast, a test does.
 */
export async function useAction(page: Page, name: string): Promise<string> {
  await page.locator('.pane-end').getByRole('button', { name, exact: true }).click();
  await expect.poll(() => activeMode(page)).not.toBe('pointerMode');
  return activeMode(page);
}

/** Marked but not yet applied redactions, as EmbedPDF counts them. */
export async function pendingRedactions(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const registry = await (document.querySelector('embedpdf-container') as unknown as EmbedElement).registry;
    const id = registry.getPlugin('document-manager')?.provides?.().getActiveDocumentId() ?? '';
    return Number(registry.getPlugin('redaction')?.provides?.().forDocument(id).getState().pendingCount ?? 0);
  });
}

/** The page at the top of EmbedPDF's view, one-based. */
export async function embedPage(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const registry = await (document.querySelector('embedpdf-container') as unknown as EmbedElement).registry;
    const id = registry.getPlugin('document-manager')?.provides?.().getActiveDocumentId() ?? '';
    return registry.getPlugin('scroll')?.provides?.().forDocument(id).getCurrentPage() ?? 0;
  });
}

/** EmbedPDF's zoom as a scale factor (1 is 100 %). */
export async function embedZoom(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const registry = await (document.querySelector('embedpdf-container') as unknown as EmbedElement).registry;
    const id = registry.getPlugin('document-manager')?.provides?.().getActiveDocumentId() ?? '';
    return Number(registry.getPlugin('zoom')?.provides?.().forDocument(id).getState().currentZoomLevel ?? 0);
  });
}
