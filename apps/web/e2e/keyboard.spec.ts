import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { corpus, openPdf, test } from './helpers';

/**
 * The keyboard in the redesigned shell, as a person without a pointer uses it.
 * A review found the arrow keys in the tool picker sending the focus out to
 * the toolbar behind it, and the Settings sheet's segmented controls taking a
 * Tab stop per option with arrow keys that did nothing.
 */

const THREE_PAGES = corpus('generated/chrome-notonaskh-justified-3pages.pdf');

async function inArabic(page: Page) {
  await page.addInitScript(() => localStorage.setItem('warraq.preferences', JSON.stringify({ lang: 'ar' })));
}

/** Opens the toolbar's tool picker from the keyboard and returns its tiles. */
async function openPicker(page: Page, pickerName: RegExp, galleryName: string) {
  await page.getByRole('toolbar').getByRole('button', { name: pickerName }).focus();
  await page.keyboard.press('Enter');
  const gallery = page.getByRole('dialog', { name: galleryName });
  await expect(gallery).toBeVisible();
  return { gallery, tiles: gallery.getByRole('radio') };
}

test('the tool picker’s arrows, Home and End move between its tiles, and the focus never leaves it', async ({
  page,
  stayLocal: _,
}) => {
  await page.goto('/');
  await openPdf(page, THREE_PAGES);
  const { gallery, tiles } = await openPicker(page, /^Choose a tool/, 'All tools');
  const last = (await tiles.count()) - 1;
  await expect(tiles.nth(0)).toBeFocused();
  for (const [key, index] of [
    ['ArrowRight', 1],
    ['ArrowRight', 2],
    ['ArrowLeft', 1],
    ['ArrowDown', 4],
    ['ArrowUp', 1],
    ['End', last],
    ['Home', 0],
    ['ArrowLeft', last],
    ['ArrowRight', 0],
  ] as const) {
    await page.keyboard.press(key);
    await expect(tiles.nth(index), `after ${key}`).toBeFocused();
    await expect(gallery).toBeVisible();
  }
  // Enter chooses the tile under the focus.
  await page.keyboard.press('ArrowRight');
  const second = (await tiles.nth(1).textContent()) ?? '';
  await page.keyboard.press('Enter');
  await expect(gallery).toBeHidden();
  await expect(page.locator('.pane-end .pane-header h2')).toHaveText(second);
});

test('in Arabic the picker’s arrows follow the reading direction', async ({ page, stayLocal: _ }) => {
  await inArabic(page);
  await page.goto('/');
  await openPdf(page, THREE_PAGES);
  const { gallery, tiles } = await openPicker(page, /^اختيار أداة/, 'كل الأدوات');
  await expect(tiles.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tiles.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tiles.nth(0)).toBeFocused();
  await page.keyboard.press('End');
  await expect(tiles.nth((await tiles.count()) - 1)).toBeFocused();
  await expect(gallery).toBeVisible();
});

test('Settings: each segmented control is one Tab stop, and the arrows choose within it', async ({
  page,
  stayLocal: _,
}) => {
  await page.goto('/');
  // From the app menu: Chrome keeps ⌘, for its own settings.
  await page.getByRole('menubar').getByRole('menuitem', { name: 'محرر PDF' }).click();
  await page.getByRole('menuitem', { name: /^Settings…/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet).toBeVisible();
  const language = sheet.getByRole('radiogroup', { name: 'Language' });
  const theme = sheet.getByRole('radiogroup', { name: 'Appearance' });

  // Tab lands on the chosen option of each group, and leaves it in one step.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(language.getByRole('radio', { name: 'English' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(theme.getByRole('radio', { name: 'System' })).toBeFocused();

  // The arrows move and choose, in the reading direction, wrapping at the ends.
  await page.keyboard.press('ArrowRight');
  await expect(theme.getByRole('radio', { name: 'Light' })).toBeFocused();
  await expect(theme.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('End');
  await expect(theme.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(theme.getByRole('radio', { name: 'System' })).toBeFocused();
  await expect(theme.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');

  // The language, by keyboard: the sheet turns right to left, and so do the arrows.
  await page.keyboard.press('Shift+Tab');
  await expect(language.getByRole('radio', { name: 'English' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const arabic = page.getByRole('dialog', { name: 'الإعدادات' }).getByRole('radiogroup', { name: 'اللغة' });
  await expect(arabic.getByRole('radio', { name: 'العربية' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(language.getByRole('radio', { name: 'English' })).toBeFocused();
});
