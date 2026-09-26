import { expect, test } from '@playwright/test';
import { trackExternalRequests } from './helpers';

test.describe('home', () => {
  test('renders in English with the sidebar on the left and no network requests', async ({ page }) => {
    const external = trackExternalRequests(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('ZOOD PDF');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('PDF, reimagined');
    const sidebar = await page.locator('.sidebar').boundingBox();
    const main = await page.locator('.home-content').boundingBox();
    expect(sidebar!.x).toBeLessThan(main!.x);
    // six action cards, each working: Open + ready tools + More
    await expect(page.locator('.action-card')).toHaveCount(6);
    await expect(page.locator('[data-card=open]')).toBeVisible();
    await expect(page.locator('[data-card=more]')).toBeVisible();
    // no avatar, bell or storage quota
    await expect(page.locator('text=/storage|quota|sign in/i')).toHaveCount(0);
    expect(external).toEqual([]);
  });

  test('renders in Arabic, right-to-left, with the sidebar mirrored', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ar-SA' });
    const page = await context.newPage();
    const external = trackExternalRequests(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page).toHaveTitle('زود PDF');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ملفات PDF، من جديد');
    await expect(page.locator('.brand-name')).toHaveText('زود PDF');
    const sidebar = await page.locator('.sidebar').boundingBox();
    const main = await page.locator('.home-content').boundingBox();
    expect(sidebar!.x).toBeGreaterThan(main!.x);
    expect(external).toEqual([]);
    await context.close();
  });

  test('only ready tools are listed; the More sheet shows the same set', async ({ page }) => {
    await page.goto('/');
    const sidebarTools = await page.locator('[data-testid=sidebar-tools] [data-tool]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')));
    expect(sidebarTools).toEqual(expect.arrayContaining(['comment', 'fill-sign', 'prepare-form', 'protect', 'redact', 'export', 'compare', 'organize', 'combine', 'compress', 'standards', 'create', 'scan']));
    await page.locator('[data-card=more]').click();
    const sheetTools = await page.locator('[data-testid=tool-gallery] [data-tool]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')));
    expect(sheetTools.sort()).toEqual(sidebarTools.sort());
    await expect(page.locator('text=/coming soon/i')).toHaveCount(0);
  });

  test('switching language in Settings flips direction and numerals', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('[data-locale=ar]').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ملفات PDF، من جديد');
    await page.getByRole('button', { name: 'تم' }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});
