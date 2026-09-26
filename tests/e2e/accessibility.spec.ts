/**
 * Accessibility tool through the real interface, in English and Arabic: open an UNTAGGED Chromium
 * Arabic file → Accessibility → auto-tag → the reading-order list and the page overlay show the
 * elements → move one element (keyboard Alt+↑ in English, drag and drop in Arabic) → Arabic alt text
 * on the figure → run the PDF/UA-style checker → apply its fixes (the title it asks for) → save →
 * inspect the saved bytes with the engine (wasm in Node): tagged, /Lang ar, the figure's /Alt is the
 * Arabic text, the reading order as set, the original file an exact byte prefix → reopen in the app.
 */
import { expect, test, type Page } from '@playwright/test';
import { ENGINE_BUILT, fixture, fixtureBytes, openViaCard, pickTool, savedFiles, stubSavePicker, trackExternalRequests } from './helpers';
import { openInEngine } from './engine';

const LOCALES = [
  { locale: 'en', browser: 'en-US', saved: /Saved/, tagged: 'Tagged', untagged: 'Not tagged', passed: 'No errors found' },
  { locale: 'ar', browser: 'ar-SA', saved: /حُفظ/, tagged: 'موسوم', untagged: 'غير موسوم', passed: 'لم يُعثر على أخطاء' },
] as const;

const TITLE = 'تقرير إمكانية الوصول';
const ALT = 'شعار زود باللونين الأزرق والبرتقالي';

const panel = (page: Page) => page.locator('[data-testid=document-view]:visible [data-testid=a11y-panel]');

/** Waits until the engine applied a change and the viewer and panel reloaded. */
async function settled(page: Page) {
  await expect(panel(page)).toHaveAttribute('data-busy', 'false', { timeout: 30_000 });
  await expect(page.locator('[data-testid=document-view]:visible .viewer-loading')).toHaveCount(0, { timeout: 30_000 });
}

/** Texts of the top-level structure elements (children of the Document) in reading order. */
async function topTexts(page: Page): Promise<string[]> {
  return panel(page)
    .locator('[data-testid=a11y-order] [data-depth="1"] .a11y-text')
    .allTextContents();
}

interface Listing {
  tagged: boolean;
  marked: boolean;
  lang: string | null;
  title: string | null;
  displayDocTitle: boolean;
  elements: { id: number | null; role: string; depth: number; text: string; alt: string | null; lang: string | null }[];
}

for (const L of LOCALES) {
  test.describe(`accessibility (${L.locale})`, () => {
    test.use({ locale: L.browser });
    test.skip(!ENGINE_BUILT, 'needs the warraq-core engine');

    test('auto-tag an untagged Arabic file, reorder, alt text, check + fix, save, reopen', async ({ context, page }) => {
      test.setTimeout(180_000);
      await stubSavePicker(context);
      const external = trackExternalRequests(page);
      await page.goto('/');
      const original = fixtureBytes('a11y-ar.pdf');
      await openViaCard(page, fixture('a11y-ar.pdf'));

      // 1. Open the tool: the file is not tagged; auto-tag it (title left empty on purpose: the
      //    checker asks for it later).
      await pickTool(page, 'accessibility');
      await expect(panel(page)).toBeVisible();
      const status = panel(page).locator('[data-testid=a11y-status]');
      await expect(status).toHaveAttribute('data-tagged', 'false');
      await expect(status).toContainText(L.untagged);
      await panel(page).locator('[data-testid=a11y-title]').fill('');
      await panel(page).locator('[data-testid=a11y-autotag]').click();
      await expect(status).toHaveAttribute('data-tagged', 'true', { timeout: 30_000 });
      await expect(status).toHaveAttribute('data-lang', 'ar');
      await settled(page);
      await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toContainText(/Edited|معدَّل/);

      // 2. The reading-order list shows the structure (types, Arabic in logical order) and the page
      //    overlay numbers the elements.
      const order = panel(page).locator('[data-testid=a11y-order]');
      await expect(order.locator('[data-role=H1] .a11y-text')).toHaveText(TITLE);
      await expect(order.locator('[data-role=Table]')).toHaveCount(1);
      await expect(order.locator('[data-role=Figure]')).toHaveCount(1);
      await expect(order.locator('[data-role=Span]').filter({ hasText: 'PDF' }).first()).toBeVisible();
      await expect(order.locator('[data-role=LBody]').first()).toContainText('البند الأول في القائمة');
      const overlay = page.locator('[data-testid=document-view]:visible [data-testid=a11y-overlay]');
      await expect(overlay).toBeVisible();
      expect(await overlay.locator('.a11y-box').count()).toBeGreaterThan(4);
      if (L.locale === 'ar') await expect(overlay.locator('.a11y-box-n').first()).toHaveText('١');
      else await expect(overlay.locator('.a11y-box-n').first()).toHaveText('1');

      // 3. Move the English paragraph above the Arabic one.
      const before = await topTexts(page);
      const en = before.findIndex((t) => t.startsWith('This paragraph'));
      const ar = before.findIndex((t) => t.startsWith('يشرح'));
      expect(en).toBe(ar + 1);
      const enRow = order.locator('[data-depth="1"]').filter({ hasText: 'This paragraph' });
      const arRow = order.locator('[data-depth="1"]').filter({ hasText: 'يشرح هذا المستند' });
      if (L.locale === 'en') {
        await enRow.click();
        await expect(panel(page).locator('[data-testid=a11y-editor]')).toBeVisible();
        await enRow.press('Alt+ArrowUp');
      } else {
        await enRow.dragTo(arRow);
      }
      await expect.poll(async () => (await topTexts(page)).findIndex((t) => t.startsWith('This paragraph')), { timeout: 30_000 }).toBe(ar);
      await settled(page);
      const after = await topTexts(page);
      expect(after[ar + 1]).toMatch(/^يشرح/);

      // 4. Alt text on the figure, in Arabic, with /Lang ar.
      await panel(page).locator('.a11y-tab[data-tab=alt]').click();
      const card = panel(page).locator('[data-testid=a11y-figure]');
      await expect(card).toHaveCount(1);
      await card.locator('[data-testid=a11y-alt-text]').fill(ALT);
      await card.locator('[data-testid=a11y-alt-lang]').selectOption('ar');
      await card.locator('[data-testid=a11y-alt-save]').click();
      await settled(page);
      await expect(panel(page).locator('[data-testid=a11y-figure] [data-testid=a11y-alt-text]')).toHaveValue(ALT);

      // 5. Check: the title rule asks for a title; give it and fix automatically → no errors.
      await panel(page).locator('.a11y-tab[data-tab=check]').click();
      await panel(page).locator('[data-testid=a11y-run-check]').click();
      const report = panel(page).locator('[data-testid=a11y-report]');
      await expect(report).toHaveAttribute('data-passed', 'false', { timeout: 30_000 });
      await expect(report.locator('.std-finding[data-rule=title]')).toBeVisible();
      await expect(report.locator('.std-finding[data-rule=display-doc-title]')).toBeVisible();
      await expect(report.locator('.std-finding[data-rule=figure-alt]')).toHaveCount(0);
      await expect(report.locator('[data-rule=title] .std-ref').first()).toContainText('14289-1');
      await expect(panel(page).locator('[data-testid=a11y-not-certified]')).toContainText(L.locale === 'ar' ? 'ليس مدقِّقًا معتمدًا' : 'not a certified PDF/UA validator');
      await panel(page).locator('[data-testid=a11y-check-title]').fill(TITLE);
      await panel(page).locator('[data-testid=a11y-fix-all]').click();
      await expect(report).toHaveAttribute('data-passed', 'true', { timeout: 30_000 });
      await expect(report).toHaveAttribute('data-errors', '0');
      await expect(report.locator('.std-verdict')).toHaveText(L.passed);
      await settled(page);

      // 6. Save (an incremental update) and inspect the bytes with the engine.
      await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
      await expect(page.locator('.hud')).toContainText(L.saved);
      const [saved] = await savedFiles(page);
      expect(saved, 'saved file').toBeTruthy();
      expect(saved!.bytes.subarray(0, original.length).equals(original)).toBe(true);
      expect(saved!.bytes.length).toBeGreaterThan(original.length);
      const d = await openInEngine(saved!.bytes);
      const l = d.call<Listing>('a11y.structure').json;
      expect(l.tagged && l.marked).toBe(true);
      expect(l.lang).toBe('ar');
      expect(l.title).toBe(TITLE);
      expect(l.displayDocTitle).toBe(true);
      const fig = l.elements.find((e) => e.role === 'Figure')!;
      expect(fig.alt).toBe(ALT);
      expect(fig.lang).toBe('ar');
      const tops = l.elements.filter((e) => e.depth === 1).map((e) => e.text);
      expect(tops.findIndex((t) => t.startsWith('This paragraph'))).toBe(ar);
      expect(tops[ar + 1]).toMatch(/^يشرح/);
      const check = d.call<{ passed: boolean; errorCount: number; certified: boolean }>('a11y.check').json;
      expect(check.passed).toBe(true);
      expect(check.certified).toBe(false);
      expect(saved!.bytes.toString('latin1')).not.toMatch(/\/Direction\s*\/R2L/);
      d.close();

      // 7. Reopen the saved file in the app: tagged, and the reading order as set.
      await page.locator('[data-testid=document-view]:visible .doc-toolbar .icon-btn').first().click();
      await openViaCard(page, { name: 'tagged.pdf', mimeType: 'application/pdf', buffer: saved!.bytes });
      await pickTool(page, 'accessibility');
      await expect(panel(page).locator('[data-testid=a11y-status]')).toHaveAttribute('data-tagged', 'true', { timeout: 30_000 });
      await expect(panel(page).locator('[data-testid=a11y-status]')).toContainText(L.tagged);
      const reopened = await topTexts(page);
      expect(reopened.findIndex((t) => t.startsWith('This paragraph'))).toBe(ar);
      expect(external).toEqual([]);
    });
  });
}
