import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, corpus, embedTiles, openPdf, test } from './helpers';

/**
 * محرر PDF as an installed web app: a manifest that names it in Arabic, icons
 * a phone can mask, a service worker that keeps the app itself — never a
 * document — so it opens and works with no network, and a phone-width,
 * touch-first layout.
 */

const THREE_PAGES = corpus('generated/chrome-notonaskh-justified-3pages.pdf');

/** A PNG's width and height, from its header. */
const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

test.describe('Installable', () => {
  test('the manifest names محرر PDF, right to left, and every icon it lists is served at its size', async ({
    page,
    request,
    stayLocal: _,
  }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');
    const manifest = await (await request.get(href!)).json();
    expect(manifest).toMatchObject({
      name: 'محرر PDF',
      short_name: 'محرر PDF',
      lang: 'ar',
      dir: 'rtl',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    const icons = manifest.icons as { src: string; sizes: string; type: string; purpose: string }[];
    for (const icon of icons) {
      const response = await request.get(icon.src);
      expect(response.status(), icon.src).toBe(200);
      expect(response.headers()['content-type'], icon.src).toContain(icon.type.split('+')[0]);
      if (icon.type === 'image/png') {
        const [width, height] = icon.sizes.split('x').map(Number);
        expect(pngSize(await response.body()), icon.src).toEqual({ width, height });
      }
    }
    // What a phone's launcher needs: 192 and 512, and a maskable 512.
    const has = (sizes: string, purpose: string) => icons.some((icon) => icon.sizes === sizes && icon.purpose === purpose);
    expect(has('192x192', 'any') && has('512x512', 'any') && has('512x512', 'maskable')).toBe(true);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', /^#/);
  });
});

test.describe('Offline', () => {
  test.use({ serviceWorkers: 'allow' });

  test('after one visit it opens with no network, draws a PDF, searches it and keeps no document', async ({
    page,
    context,
    stayLocal: _,
  }) => {
    await page.goto('/');
    // Installed and in charge of the page: the app's files are in its cache.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    const listed = await page.evaluate(async () => {
      const source = await (await fetch('/sw.js')).text();
      const shell = JSON.parse(/const SHELL = (\[.*\]);/.exec(source)![1]!) as string[];
      const lazy = JSON.parse(/const LAZY = new Set\((\[.*\])\);/.exec(source)![1]!) as string[];
      return { shell, lazy };
    });
    expect(listed.shell).toContain('/index.html');
    expect(listed.shell.some((file) => /warraq_core_bg-.*\.wasm$/.test(file))).toBe(true);
    expect(listed.shell.some((file) => /pdfium-.*\.wasm$/.test(file))).toBe(true);

    await context.setOffline(true);
    const failed: string[] = [];
    page.on('requestfailed', (failure) => failed.push(failure.url()));
    await page.reload();
    await openPdf(page, THREE_PAGES);
    expect(await embedTiles(page)).toBeGreaterThan(0);

    // Warraq's own engine works offline too: the search in the view is its.
    await page.keyboard.press('ControlOrMeta+f');
    await page.locator('embedpdf-container [data-sidebar-id="search-panel"]').getByPlaceholder('Search').fill('وراق');
    await expect(page.locator('embedpdf-container').getByText('7 results found')).toBeVisible();
    expect(failed).toEqual([]);

    // What it keeps is the app's own files, from its list — nothing a person opened.
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const key of await caches.keys()) {
        for (const request of await (await caches.open(key)).keys()) urls.push(request.url);
      }
      return urls;
    });
    const origin = new URL(page.url()).origin;
    expect(cached.length).toBe(listed.shell.length);
    for (const url of cached) {
      expect(url.startsWith(`${origin}/`), url).toBe(true);
      expect([...listed.shell, ...listed.lazy], url).toContain(new URL(url).pathname);
      // The only PDF among them is EmbedPDF's own stamp sheet.
      expect(url, url).not.toContain('chrome-notonaskh');
    }
    await context.setOffline(false);
  });
});

/** Controls in Warraq's own chrome — not EmbedPDF's, not the page — smaller than a finger. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, select, [role="menuitem"], [role="radio"]:not(input), a[href]')]
      .filter((element) => !element.closest('embedpdf-container'))
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      })
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return Math.round(box.width) < 44 || Math.round(box.height) < 44;
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return `${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30)} ${Math.round(box.width)}×${Math.round(box.height)}`;
      }),
  );
}

test.describe('On a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('in Arabic, by touch: open a file, pick a tool from the gallery, use it in the sheet — every target 44 points', async ({
    page,
    stayLocal: _,
  }) => {
    await page.addInitScript(() => localStorage.setItem('warraq.preferences', JSON.stringify({ lang: 'ar' })));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(await smallTargets(page)).toEqual([]);

    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'فتح…' }).tap()]);
    await chooser.setFiles(INVOICE);
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await fits()).toBe(true);
    expect(await smallTargets(page)).toEqual([]);

    // The tool gallery opens inside the screen.
    await page.getByRole('button', { name: /^اختيار أداة/ }).tap();
    const gallery = page.getByRole('dialog', { name: 'كل الأدوات' });
    await expect(gallery).toBeVisible();
    await expect.poll(async () => {
      const box = await gallery.boundingBox();
      return box !== null && box.x >= 0 && box.x + box.width <= 390;
    }).toBe(true);
    await gallery.getByRole('radio', { name: 'ضغط' }).tap();

    // The tool is a sheet from the bottom; its controls take a finger too.
    const sheet = page.locator('.pane-end');
    await expect(sheet.getByRole('heading', { name: 'ضغط' })).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
    await sheet.getByRole('button', { name: 'ضغط', exact: true }).tap();
    await expect(sheet.locator('.compress-result')).toBeVisible();
    expect(await fits()).toBe(true);

    // The menus, by touch.
    await page.getByRole('menubar').getByRole('menuitem', { name: 'ملف' }).tap();
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
  });
});
