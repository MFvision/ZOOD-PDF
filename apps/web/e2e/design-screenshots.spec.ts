import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORD_EXPORT, chooseTool, corpus, openPdf, test } from './helpers';

/**
 * The screenshots in docs/design/screenshots, taken from the production build
 * the rest of the suite runs against. Not a test of behaviour — every state
 * shown here is proven elsewhere — so it runs only when asked for:
 *
 *   WARRAQ_SCREENSHOTS=1 pnpm --filter @warraq/web exec playwright test e2e/design-screenshots.spec.ts
 */
const OUT = fileURLToPath(new URL('../../../docs/design/screenshots/', import.meta.url));
const THREE_PAGES = corpus('generated/chrome-notonaskh-justified-3pages.pdf');
const INVOICE = corpus('generated/chrome-cairo-mixed-invoice.pdf');

test.skip(!process.env.WARRAQ_SCREENSHOTS, 'screenshots are taken on request only');
test.describe.configure({ mode: 'serial' });

type Theme = 'light' | 'dark';

async function start(page: Page, lang: 'en' | 'ar', theme: Theme, size = { width: 1440, height: 900 }) {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(
    ([l]) => {
      // Once per test: the script also runs in frames the viewer makes later.
      if (localStorage.getItem('warraq.recent')) return;
      localStorage.setItem('warraq.preferences', JSON.stringify({ lang: l, theme: 'system' }));
      localStorage.setItem('warraq.recent', JSON.stringify(['التقرير السنوي ٢٠٢٥.pdf', 'Quarterly review.pdf', 'عقد الإيجار.pdf', 'Invoice 0412.pdf']));
    },
    [lang],
  );
  await page.goto('/');
  await expect(page.locator('.shell')).toBeVisible();
}

/** Lets fonts, thumbnails and any settling motion finish before the picture. */
async function shoot(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}${name}.png` });
}

/** Opens two real files and closes them, so the recent grid shows their first pages. */
async function withRecents(page: Page, close: string) {
  await openPdf(page, INVOICE);
  // With a file open EmbedPDF has file fields of its own: Warraq's is the hidden one.
  await page.locator('input.sr-only[type="file"]').setInputFiles(THREE_PAGES);
  await expect(page.getByRole('toolbar')).toContainText('chrome-notonaskh-justified-3pages.pdf');
  await page.getByRole('menubar').getByRole('menuitem', { name: close.split('|')[0], exact: true }).click();
  await page.getByRole('menuitem', { name: close.split('|')[1] }).click();
  await expect(page.locator('.recent-page img').first()).toBeVisible();
}

test('home, English, light', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', 'light');
  await withRecents(page, 'File|Close document');
  await shoot(page, 'home-en-light');
});

test('home, Arabic, dark', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'dark');
  await withRecents(page, 'ملف|إغلاق المستند');
  await shoot(page, 'home-ar-dark');
});

test('document, English, light', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', 'light');
  await openPdf(page, WORD_EXPORT);
  await shoot(page, 'document-en-light');
});

test('document, Arabic, light', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'light');
  await openPdf(page, INVOICE);
  await shoot(page, 'document-ar-light');
});

test('document, Arabic, dark', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'dark');
  await openPdf(page, THREE_PAGES);
  await shoot(page, 'document-ar-dark');
});

test('home: the search field, with results', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', 'light');
  await withRecents(page, 'File|Close document');
  await page.getByRole('searchbox', { name: 'Search' }).fill('invoice');
  await expect(page.getByRole('region', { name: 'Search results' })).toBeVisible();
  await shoot(page, 'home-search-en-light');
});

test('home: Starred, Arabic, dark', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'dark');
  await withRecents(page, 'ملف|إغلاق المستند');
  await page.getByRole('button', { name: /^مزيد من الإجراءات لـ chrome-cairo/ }).click();
  await page.getByRole('menuitem', { name: /^تمييز/ }).click();
  await page.getByRole('navigation', { name: 'أقسام الرئيسية' }).getByRole('button', { name: 'المميّزة بنجمة' }).click();
  await expect(page.locator('.recent-card')).toHaveCount(1);
  await shoot(page, 'home-starred-ar-dark');
});

test('Organize: a page’s context menu', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', 'light');
  await openPdf(page, THREE_PAGES);
  await chooseTool(page, 'Organize');
  const tile = page.getByRole('listbox', { name: 'Pages' }).getByRole('option', { name: 'Page 2', exact: true });
  await expect(tile).toBeVisible();
  await tile.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Page 2' })).toBeVisible();
  await shoot(page, 'organize-menu-en-light');
});

test('home: the tools', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'light');
  await page.locator('.home-section', { has: page.locator('#home-tools') }).scrollIntoViewIfNeeded();
  await shoot(page, 'home-tools-ar-light');
});

test('the tool picker’s gallery', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', 'light');
  await openPdf(page, WORD_EXPORT);
  await page.getByRole('toolbar').getByRole('button', { name: /^Choose a tool/ }).click();
  await expect(page.getByRole('dialog', { name: 'All tools' })).toBeVisible();
  await shoot(page, 'gallery-en-light');
});

test('the tool picker’s gallery, Arabic, dark', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'dark');
  await openPdf(page, INVOICE);
  await page.getByRole('toolbar').getByRole('button', { name: /^اختيار أداة/ }).click();
  await expect(page.getByRole('dialog', { name: 'كل الأدوات' })).toBeVisible();
  await shoot(page, 'gallery-ar-dark');
});

test('About', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', 'dark');
  await page.getByRole('menubar').getByRole('menuitem', { name: 'محرر PDF' }).click();
  await page.getByRole('menuitem', { name: /^About/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shoot(page, 'about-en-dark');
});

test('Settings', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'light');
  await page.getByRole('menubar').getByRole('menuitem', { name: 'محرر PDF' }).click();
  await page.getByRole('menuitem', { name: /^الإعدادات/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shoot(page, 'settings-ar-light');
});

test('inspector: Organize', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', 'light');
  await openPdf(page, THREE_PAGES);
  await chooseTool(page, 'Organize');
  await expect(page.locator('.organize-tile').first()).toBeVisible();
  await shoot(page, 'inspector-organize-en-light');
});

test('inspector: Compress', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', 'dark');
  await openPdf(page, WORD_EXPORT);
  await chooseTool(page, 'Compress');
  await shoot(page, 'inspector-compress-en-dark');
});

test('sheet dialog', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', 'light');
  await openPdf(page, THREE_PAGES);
  await page.keyboard.press('ControlOrMeta+Shift+N');
  await expect(page.getByRole('dialog')).toBeVisible();
  await shoot(page, 'sheet-goto-en-light');
});

test('drop overlay', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'light');
  await openPdf(page, THREE_PAGES);
  // A drag of a file over the window, as the browser reports it.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['%PDF-1.7'], 'ملحق.pdf', { type: 'application/pdf' }));
    const at = { clientX: innerWidth * 0.3, clientY: innerHeight * 0.5, dataTransfer: data, bubbles: true };
    window.dispatchEvent(new DragEvent('dragenter', at));
    window.dispatchEvent(new DragEvent('dragover', at));
  });
  await expect(page.locator('.drop-overlay')).toBeVisible();
  await shoot(page, 'drop-overlay-ar-light');
});

test('phone: home', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'light', { width: 375, height: 812 });
  await shoot(page, 'phone-home-ar-light');
});

test('phone: document', async ({ page, stayLocal: _ }) => {
  await start(page, 'en', 'light', { width: 375, height: 812 });
  await openPdf(page, THREE_PAGES);
  await shoot(page, 'phone-document-en-light');
});

test('phone: a tool’s sheet', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'light', { width: 375, height: 812 });
  await openPdf(page, INVOICE);
  await page.getByRole('toolbar').getByRole('button', { name: /^اختيار أداة/ }).click();
  await page.getByRole('dialog', { name: 'كل الأدوات' }).getByRole('radio', { name: 'ضغط' }).click();
  await expect(page.locator('.pane-end')).toBeVisible();
  await shoot(page, 'phone-sheet-ar-light');
});

test('tablet: document with inspector', async ({ page, stayLocal: _ }) => {
  await start(page, 'ar', 'dark', { width: 820, height: 1180 });
  await openPdf(page, THREE_PAGES);
  await chooseTool(page, 'ضغط');
  await shoot(page, 'tablet-document-ar-dark');
});
