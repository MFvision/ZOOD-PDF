import type { RemoteDocument } from '../core/client';

/**
 * Print by pages: how a host with no PDF printer of its own prints the file
 * (Windows and Linux; ADR-0007's desktop). Each page is drawn by Warraq's
 * core at print resolution — natively, with PDFium, on the desktop — and the
 * pictures are laid out one to a sheet of paper, the size of the page, in a
 * sheet that only the print style sheet shows (`print.css`). The webview's
 * own print dialog then prints that and nothing else of the app.
 *
 * What is lost against printing the PDF itself (PDFKit on macOS, a browser's
 * PDF viewer): the pages are pictures at 300 dpi, not vectors — sharp on
 * paper, but a large job for a long file.
 */

/** Print resolution: what an office printer resolves. */
export const PRINT_DPI = 300;

/** The most pixels one page is drawn with: a poster-sized page would otherwise take gigabytes. */
export const MAX_PIXELS = 36_000_000;

/** One page, drawn for print: its size on paper, in points, and its picture. */
export interface PrintedPage {
  width: number;
  height: number;
  url: string;
}

/** Pixels per point for a page of `width` × `height` points: `dpi`, unless that is too many pixels. */
export function printScale(width: number, height: number, dpi = PRINT_DPI): number {
  const scale = dpi / 72;
  const area = Math.max(1, width * height);
  return area * scale * scale <= MAX_PIXELS ? scale : Math.sqrt(MAX_PIXELS / area);
}

const points = (value: number) => Math.round(value * 100) / 100;

/**
 * The page rules for printing `pages`: no margins, and one named page per
 * paper size, so a landscape page goes on landscape paper. `names[i]` is the
 * page rule of page `i`.
 */
export function pageRules(pages: readonly { width: number; height: number }[]): { css: string; names: string[] } {
  const bySize = new Map<string, string>();
  const names = pages.map((page) => {
    const size = `${points(page.width)}pt ${points(page.height)}pt`;
    let name = bySize.get(size);
    if (!name) {
      name = `warraq-print-${bySize.size}`;
      bySize.set(size, name);
    }
    return name;
  });
  const rules = [...bySize].map(([size, name]) => `@page ${name} { size: ${size}; margin: 0; }`);
  return { css: ['@page { margin: 0; }', ...rules].join('\n'), names };
}

/** A drawn page as a PNG. */
async function png(width: number, height: number, rgba: Uint8ClampedArray<ArrayBuffer>): Promise<Blob> {
  const image = new ImageData(rgba, width, height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')?.putImageData(image, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('E_PRINT: no picture'))), 'image/png'));
}

/**
 * Every page of `doc`, drawn for print, in order. `onPage` hears how many
 * are done; an aborted `signal` stops it and lets go of what it made.
 */
export async function drawPages(
  doc: Pick<RemoteDocument, 'pageCount' | 'pageSizes' | 'render_page'>,
  onPage: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<PrintedPage[]> {
  const pages: PrintedPage[] = [];
  const total = doc.pageCount;
  try {
    for (let index = 0; index < total; index += 1) {
      if (signal?.aborted) throw new DOMException('print cancelled', 'AbortError');
      const [width, height] = doc.pageSizes[index] ?? [612, 792];
      const drawn = await doc.render_page(index, printScale(width, height));
      pages.push({ width, height, url: URL.createObjectURL(await png(drawn.width, drawn.height, drawn.rgba)) });
      onPage(index + 1, total);
    }
    return pages;
  } catch (error) {
    pages.forEach((page) => URL.revokeObjectURL(page.url));
    throw error;
  }
}

/**
 * Lays `pages` out for print, one to a sheet of paper, and waits until the
 * pictures are ready. On screen none of it is ever shown. Returns the undo,
 * which also lets go of the pictures.
 */
export async function mountSheet(pages: readonly PrintedPage[]): Promise<() => void> {
  const { css, names } = pageRules(pages);
  const style = document.createElement('style');
  style.dataset.warraqPrint = '';
  style.textContent = css;
  const sheet = document.createElement('div');
  sheet.className = 'print-sheet';
  sheet.setAttribute('aria-hidden', 'true');
  const images = pages.map((page, index) => {
    const image = document.createElement('img');
    image.className = 'print-page';
    image.alt = '';
    image.src = page.url;
    image.style.setProperty('width', `${points(page.width)}pt`);
    image.style.setProperty('height', `${points(page.height)}pt`);
    image.style.setProperty('page', names[index] ?? 'auto');
    sheet.append(image);
    return image;
  });
  document.head.append(style);
  document.body.append(sheet);
  document.documentElement.classList.add('print-pages');
  await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
  return () => {
    document.documentElement.classList.remove('print-pages');
    sheet.remove();
    style.remove();
    pages.forEach((page) => URL.revokeObjectURL(page.url));
  };
}
