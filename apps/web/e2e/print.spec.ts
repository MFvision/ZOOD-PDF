import { writeFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { INVOICE, corpus, openPdf, test } from './helpers';
import { callOn, core, textOf } from './pdfBytes';

/**
 * Print. A browser prints the file itself, through its PDF viewer, as
 * EmbedPDF hands it over. The desktop on Windows and Linux — and macOS on
 * request — prints by pages: each page drawn by Warraq's core at 300 dpi,
 * laid out one to a sheet of paper, and the webview's print dialog run on
 * that (`print/printPages.ts`). That path is the same code in this browser,
 * chosen with `warraq.print`, and is proven here by printing it to a PDF.
 */

const THREE_PAGES = corpus('generated/chrome-notonaskh-justified-3pages.pdf');

/** Chrome's own PDF viewer: built into the browser, loaded from inside it. */
const PDF_VIEWER = ['chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/', 'chrome://resources/'];

// Not `stayLocal`: the browser's PDF viewer loads its own parts from inside
// the browser, which that fixture would count as leaving the app. The same
// check is made here with the viewer set aside.
test('a browser prints the PDF itself: EmbedPDF frames the file for its PDF viewer, and no policy stops it', async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  const outside: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/.test(message.text()) && !/frame-ancestors/.test(message.text())) {
      errors.push(message.text());
    }
  });
  const viewer: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (PDF_VIEWER.some((prefix) => url.startsWith(prefix))) viewer.push(url);
    else if (!url.startsWith(`${new URL(baseURL!).origin}/`) && !/^(blob|data):/.test(url)) outside.push(url);
  });
  await page.goto('/');
  await openPdf(page, INVOICE);
  await page.keyboard.press('ControlOrMeta+p');
  await page.locator('embedpdf-container').getByRole('button', { name: 'Print', exact: true }).click();
  // The file, framed as a blob, is open in the browser's PDF viewer — not an error page.
  await expect.poll(() => page.frames().some((frame) => frame.url().startsWith('blob:'))).toBe(true);
  await expect.poll(() => viewer.length).toBeGreaterThan(0);
  expect(page.frames().some((frame) => frame.url().startsWith('chrome-error:'))).toBe(false);
  expect(errors).toEqual([]);
  expect(outside).toEqual([]);
});

test('by pages: every page at 300 dpi, on paper of its own size, and nothing else of the app', async ({ page, stayLocal: _ }) => {
  await page.addInitScript(() => {
    localStorage.setItem('warraq.print', JSON.stringify('pages'));
    // The print dialog, counted rather than shown: headless Chrome has none.
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
  await page.goto('/');
  await openPdf(page, THREE_PAGES);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /^Print/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);

  // Laid out: three pictures of the pages, drawn at print resolution.
  const drawn = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('.print-sheet img.print-page')].map((image) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
      page: image.style.getPropertyValue('page'),
    })),
  );
  expect(drawn).toHaveLength(3);
  for (const image of drawn) {
    // A4 at 300 dpi.
    expect(image.width).toBeGreaterThan(2400);
    expect(image.height).toBeGreaterThan(3400);
    expect(image.page).toBe('warraq-print-0');
  }

  // What the print dialog gets: printed to a PDF, with the page's own rules.
  const printed = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const path = 'test-results/printed-by-pages.pdf';
  writeFileSync(path, printed);
  const { Document } = await core();
  const original = Document.open(new Uint8Array((await import('node:fs')).readFileSync(THREE_PAGES))) as unknown as {
    page_count(): number;
    page_size(i: number): Float32Array;
    free(): void;
  };
  const out = Document.open(new Uint8Array(printed)) as unknown as typeof original;
  try {
    expect(out.page_count()).toBe(3);
    for (let i = 0; i < 3; i += 1) {
      const [w, h] = original.page_size(i);
      const [pw, ph] = out.page_size(i);
      expect(Math.abs(pw! - w!)).toBeLessThan(1.5);
      expect(Math.abs(ph! - h!)).toBeLessThan(1.5);
    }
  } finally {
    out.free();
    original.free();
  }
  // Each sheet is its page's picture, and nothing of the app: no text at all.
  for (let i = 0; i < 3; i += 1) {
    const { result } = await callOn<{ images: { pixels: [number, number] }[] }>('images.list', path, { page: i });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.pixels[0]).toBeGreaterThan(2400);
  }
  expect((await textOf(path)).trim()).toBe('');

  // The dialog closed: the sheet and its pictures are let go.
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('.print-sheet')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveClass(/print-pages/);
});
