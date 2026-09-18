import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, embedTiles, openPdf, test } from './helpers';

/** EmbedPDF's mode tabs, as its own toolbar names them in each language. */
const MODES = {
  en: ['View', 'Annotate', 'Shapes', 'Insert', 'Form', 'Redact'],
  ar: ['عرض', 'تعليق', 'أشكال', 'إدراج', 'نموذج', 'تنقيح'],
};

/** The tab strip inside EmbedPDF's shadow root; role locators reach into it. */
const modeTabs = (page: Page) =>
  page.locator('embedpdf-container').getByRole('tablist').getByRole('button');
const embedButton = (page: Page, name: string) =>
  page.locator('embedpdf-container').getByRole('button', { name, exact: true });

/** Warraq's Language selector in the menu bar, named in the language on screen. */
const language = (page: Page, name: 'Language' | 'اللغة') =>
  page.getByRole('menubar').getByRole('combobox', { name });

type I18n = {
  getLocale(): string;
  getAvailableLocales(): string[];
  getLocaleInfo(code: string): { translations: Record<string, unknown> } | null;
};
type Registry = { getPlugin(id: string): { provides?: () => unknown } | null };

/** What EmbedPDF's i18n plugin holds, and which document it has open. */
async function embedI18n(page: Page) {
  return page.evaluate(async () => {
    const registry = await (
      document.querySelector('embedpdf-container') as unknown as { registry: Promise<Registry> }
    ).registry;
    const i18n = registry.getPlugin('i18n')?.provides?.() as I18n;
    const manager = registry.getPlugin('document-manager')?.provides?.() as {
      getActiveDocumentId(): string;
    };
    const keys = (tree: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(tree).flatMap(([key, value]) =>
        typeof value === 'string'
          ? [`${prefix}${key}`]
          : keys(value as Record<string, unknown>, `${prefix}${key}.`),
      );
    const english = keys(i18n.getLocaleInfo('en')?.translations ?? {});
    const arabic = keys(i18n.getLocaleInfo('ar')?.translations ?? {});
    return {
      locale: i18n.getLocale(),
      available: i18n.getAvailableLocales(),
      englishKeys: english.length,
      missingInArabic: english.filter((key) => !arabic.includes(key)),
      notInEnglish: arabic.filter((key) => !english.includes(key)),
      documentId: manager.getActiveDocumentId(),
    };
  });
}

test.describe("EmbedPDF's own interface speaks Warraq's language", () => {
  test('switching the Language selector turns its toolbar Arabic, and back to English', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await expect(modeTabs(page)).toHaveText(MODES.en);
    const before = await embedI18n(page);
    expect(before.locale).toBe('en');

    await language(page, 'Language').selectOption({ label: 'العربية' });
    await expect(modeTabs(page)).toHaveText(MODES.ar);
    await expect(embedButton(page, 'تكبير')).toBeVisible();
    await expect(embedButton(page, 'قائمة المستند')).toBeVisible();
    await expect(embedButton(page, 'Zoom In')).toHaveCount(0);

    const arabic = await embedI18n(page);
    expect(arabic.locale).toBe('ar');
    // Added beside EmbedPDF's ten locales, not in place of them.
    expect(arabic.available).toEqual(
      expect.arrayContaining(['en', 'de', 'fr', 'ja', 'zh-CN', 'ar']),
    );
    expect(arabic.available).toHaveLength(11);
    // Every string the running EmbedPDF has in English has an Arabic one: an
    // upgrade that adds keys fails here until the translation catches up.
    expect(arabic.englishKeys).toBeGreaterThan(250);
    expect(arabic.missingInArabic).toEqual([]);
    expect(arabic.notInEnglish).toEqual([]);
    // Switched live: the same document is still open, not reloaded.
    expect(arabic.documentId).toBe(before.documentId);
    expect(await embedTiles(page)).toBeGreaterThan(0);

    await language(page, 'اللغة').selectOption({ label: 'English' });
    await expect(modeTabs(page)).toHaveText(MODES.en);
    await expect(embedButton(page, 'Zoom In')).toBeVisible();
    await expect(embedButton(page, 'تكبير')).toHaveCount(0);
    const english = await embedI18n(page);
    expect(english.locale).toBe('en');
    expect(english.documentId).toBe(before.documentId);
  });

  test('a file opened while Warraq is in Arabic shows EmbedPDF in Arabic from the start', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await language(page, 'Language').selectOption({ label: 'العربية' });
    await openPdf(page, INVOICE);
    await expect(modeTabs(page)).toHaveText(MODES.ar);
    expect((await embedI18n(page)).locale).toBe('ar');
  });
});
