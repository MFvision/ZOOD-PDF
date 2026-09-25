import { expect, test, type Page } from '@playwright/test';
import { fixture, openViaCard } from './helpers';

async function noHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
}

async function inViewport(page: Page, selector: string) {
  const vp = page.viewportSize()!;
  // Poll: drawers may still be sliding in.
  await expect
    .poll(async () => {
      const box = await page.locator(selector).first().boundingBox();
      return !!box && box.x >= -0.5 && box.x + box.width <= vp.width + 1;
    }, { message: `${selector} inside the viewport` })
    .toBe(true);
}

test.describe('appearance', () => {
  test('dark mode + reduced motion: layout intact (snapshots)', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto('/');
    // dark tokens active: light text on a dark base
    const [r, g, b] = await page.evaluate(() => getComputedStyle(document.body).color.match(/\d+/g)!.map(Number));
    expect(Math.min(r!, g!, b!)).toBeGreaterThan(200);
    await noHorizontalOverflow(page);
    for (const s of ['.sidebar', '.search-field', '.hero-title', '.action-grid', '.plus-btn']) await inViewport(page, s);
    await expect(page).toHaveScreenshot('home-dark.png', { maxDiffPixelRatio: 0.03, animations: 'disabled' });
    await openViaCard(page, fixture('sample-en.pdf'));
    await noHorizontalOverflow(page);
    for (const s of ['.doc-toolbar', '[data-testid=save]', '.pages-panel', '.viewer-area']) await inViewport(page, s);
    await expect(page.locator('.doc-toolbar')).toHaveScreenshot('toolbar-dark.png', { maxDiffPixelRatio: 0.05 });
    await context.close();
  });

  test('light Arabic home snapshot', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ar', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto('/');
    await noHorizontalOverflow(page);
    await expect(page).toHaveScreenshot('home-ar.png', { maxDiffPixelRatio: 0.03, animations: 'disabled' });
    await context.close();
  });

  test('increased contrast makes glass panels opaque', async ({ browser }) => {
    const context = await browser.newContext({ contrast: 'more' });
    const page = await context.newPage();
    await page.goto('/');
    const { glass, surface } = await page.evaluate(() => {
      const bg = (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor;
      const probe = document.createElement('div');
      probe.style.background = 'var(--surface)';
      document.body.append(probe);
      return { glass: bg('.sidebar'), surface: getComputedStyle(probe).backgroundColor };
    });
    expect(glass).toBe(surface);
    await context.close();
  });
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('sidebar collapses to a drawer; nothing overflows', async ({ page }) => {
    await page.goto('/');
    await noHorizontalOverflow(page);
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await inViewport(page, '.sidebar');
    await page.locator('.side-item', { hasText: 'Recents' }).click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recents');
    for (const s of ['.search-field', '.plus-btn']) await inViewport(page, s);
  });

  test('document view fits the phone', async ({ page }) => {
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    await noHorizontalOverflow(page);
    for (const s of ['.doc-toolbar', '[data-testid=save]', '[data-testid=tool-picker]', '.viewer-area']) await inViewport(page, s);
    await expect(page.locator('.pages-panel')).toHaveCount(0);
  });

  test('Arabic drawer slides from the right edge', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ar', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'إظهار الشريط الجانبي' }).click();
    const box = await page.locator('.sidebar').boundingBox();
    expect(box!.x + box!.width).toBeGreaterThan(385);
    await noHorizontalOverflow(page);
    await context.close();
  });
});
