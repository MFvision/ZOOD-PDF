import { expect, test } from '@playwright/test';
import { fixture, openViaCard } from './helpers';

test.describe('installable PWA', () => {
  test('manifest names the app in English and Arabic and lists original icons', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    const m = await res.json();
    expect(m.name).toBe('ZOOD PDF');
    expect(m.translations.ar.name).toBe('زود PDF');
    expect(m.translations.ar.dir).toBe('rtl');
    const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
    for (const icon of m.icons) expect((await request.get(`/${icon.src}`)).ok()).toBe(true);
  });

  test('the production page carries a strict CSP (no unsafe-eval, no inline script)', async ({ page }) => {
    await page.goto('/');
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(await page.locator('script:not([src])').count()).toBe(0);
  });

  test('the app shell works offline after the first load; documents are never cached', async ({ context, page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('PDF, reimagined');
    // The viewer (PDFium wasm, fonts) is part of the shell: opening a PDF works offline too.
    await openViaCard(page, fixture('sample-en.pdf'));
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toHaveText('Page 1 of 2');
    const cached = await page.evaluate(async () => {
      const out: string[] = [];
      for (const key of await caches.keys()) for (const req of await (await caches.open(key)).keys()) out.push(req.url);
      return out;
    });
    expect(cached.length).toBeGreaterThan(5);
    expect(cached.filter((u) => /\.pdf$/i.test(u) && !/stamps/.test(u))).toEqual([]);
    await context.setOffline(false);
  });

  test('"Install app" appears in the + menu only after beforeinstallprompt', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid=plus]').click();
    await expect(page.getByRole('menuitem', { name: 'Install app' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const ev = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
      ev.prompt = async () => {};
      ev.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(ev);
    });
    await page.locator('[data-testid=plus]').click();
    await page.getByRole('menuitem', { name: 'Install app' }).click();
    await expect(page.locator('.hud')).toContainText('ZOOD PDF is installed');
  });
});
