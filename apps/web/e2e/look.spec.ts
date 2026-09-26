import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { INVOICE, openPdf, test } from './helpers';

/**
 * How the shell looks after the rename to محرر PDF and the sixteenth tool:
 * the name is Arabic inside an English interface, and every list of tools —
 * the picker's gallery, the home screen's grid, the inspector's list and the
 * Tools menu — holds all of them, in both languages and at phone width.
 */

const tracking = (element: Locator) =>
  element.evaluate((node) => {
    const spacing = getComputedStyle(node).letterSpacing;
    return spacing === 'normal' ? 0 : Number.parseFloat(spacing);
  });

/** Nothing inside the element is cut off or spills sideways. */
const fits = (element: Locator) =>
  element.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return (
      box.left >= -0.5 &&
      box.right <= window.innerWidth + 0.5 &&
      node.scrollWidth <= node.clientWidth + 1 &&
      [...node.querySelectorAll<HTMLElement>('*')].every((child) => child.scrollWidth <= child.clientWidth + 1)
    );
  });

async function start(page: Page, lang: 'en' | 'ar', size?: { width: number; height: number }) {
  if (size) await page.setViewportSize(size);
  await page.addInitScript((chosen) => localStorage.setItem('warraq.preferences', JSON.stringify({ lang: chosen })), lang);
  await page.goto('/');
  await expect(page.locator('.shell')).toBeVisible();
}

test('the app’s name is set as Arabic even inside the English interface, so its letters stay joined', async ({
  page,
  stayLocal: _,
}) => {
  for (const lang of ['en', 'ar'] as const) {
    await start(page, lang);
    const wordmark = page.locator('.home-brand-name bdi');
    await expect(wordmark).toHaveText('محرر PDF');
    expect(await tracking(wordmark), `the home title, in ${lang}`).toBe(0);
    // It reads right to left wherever it is set.
    expect(await wordmark.evaluate((node) => getComputedStyle(node).direction)).toBe('rtl');

    await page.getByRole('menubar').getByRole('menuitem', { name: 'محرر PDF' }).click();
    await page.getByRole('menuitem', { name: /About|حول/ }).click();
    const about = page.getByRole('dialog').locator('.about-name bdi');
    await expect(about).toBeVisible();
    expect(await tracking(about), `About, in ${lang}`).toBe(0);
    await page.keyboard.press('Escape');
  }
});

test('every tool is in the picker, on the home screen, in the inspector and in the Tools menu', async ({
  page,
  stayLocal: _,
}) => {
  for (const [lang, picker, gallery] of [
    ['en', /^Choose a tool/, 'All tools'],
    ['ar', /^اختيار أداة/, 'كل الأدوات'],
  ] as const) {
    await start(page, lang);
    const home = page.locator('.home .tool-cards-grid .tool-card');
    const count = await home.count();
    expect(count, 'every tool the app has').toBeGreaterThanOrEqual(16);
    expect(await fits(page.locator('.home .tool-cards-grid')), `the home grid, in ${lang}`).toBe(true);

    await openPdf(page, INVOICE);
    await page.getByRole('toolbar').getByRole('button', { name: picker }).click();
    const tiles = page.getByRole('dialog', { name: gallery });
    await expect(tiles.getByRole('radio')).toHaveCount(count);
    expect(await fits(tiles), `the gallery, in ${lang}`).toBe(true);
    await page.keyboard.press('Escape');

    await expect(page.locator('.pane-end .tool-card')).toHaveCount(count);
    expect(await fits(page.locator('.pane-end')), `the inspector, in ${lang}`).toBe(true);

    const menu = lang === 'en' ? 'Tools' : 'أدوات';
    await page.getByRole('menubar').getByRole('menuitem', { name: menu, exact: true }).click();
    await expect(page.getByRole('menu', { name: menu }).getByRole('menuitemradio')).toHaveCount(count);
    await page.keyboard.press('Escape');
  }
});

test('in a window too short for the gallery, it stays on screen and scrolls', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', { width: 1000, height: 420 });
  await openPdf(page, INVOICE);
  await page.getByRole('toolbar').getByRole('button', { name: /^Choose a tool/ }).click();
  const gallery = page.getByRole('dialog', { name: 'All tools' });
  const box = (await gallery.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(420);
  // Every tile is still reachable, by scrolling the gallery itself.
  const last = gallery.getByRole('radio').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
});

test('at phone width the gallery holds every tool and nothing scrolls sideways', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', { width: 390, height: 844 });
  const count = await page.locator('.home .tool-cards-grid .tool-card').count();
  await openPdf(page, INVOICE);
  await page.getByRole('toolbar').getByRole('button', { name: /^اختيار أداة/ }).click();
  const gallery = page.getByRole('dialog', { name: 'كل الأدوات' });
  await expect(gallery.getByRole('radio')).toHaveCount(count);
  const box = (await gallery.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
