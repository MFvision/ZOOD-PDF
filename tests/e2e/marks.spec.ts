/**
 * Page marks through the real interface (English and Arabic): an Arabic diagonal text watermark at
 * 30 % opacity and a footer «صفحة {page} من {pages}» with Arabic-Indic digits on a 3-page file,
 * saved, inspected with the engine (wasm in Node: «صفحة ٢ من ٣» found on page 2, marks listed as
 * ours, the original bytes an exact prefix) and reopened; a picture watermark and Bates numbers,
 * a mark removed (with undo/redo) and gone after saving; the panel at phone width.
 */
import { expect, test, type Page } from '@playwright/test';
import { ENGINE_BUILT, fixture, fixtureBytes, openViaCard, pickTool, savedFiles, stubSavePicker, trackExternalRequests } from './helpers';
import { openInEngine } from './engine';

const view = (page: Page) => page.locator('[data-testid=document-view]:visible');
const panel = (page: Page) => view(page).locator('[data-testid=marks-panel]');
const items = (page: Page) => panel(page).locator('[data-testid=marks-list] li');

const LOCALES = [
  { locale: 'en', browser: 'en-US', added: /Page mark added/, removed: /Page mark removed/ },
  { locale: 'ar', browser: 'ar-SA', added: /أُضيفت علامة الصفحة/, removed: /أُزيلت علامة الصفحة/ },
] as const;

async function openMarks(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await openViaCard(page, file);
  await pickTool(page, 'page-marks');
  await expect(panel(page)).toBeVisible();
}

/** Clicks Apply (or a list action) and waits for the new revision and the reloaded viewer. */
async function commit(page: Page, act: () => Promise<unknown>) {
  const before = Number(await panel(page).getAttribute('data-revision'));
  await act();
  await expect.poll(async () => Number(await panel(page).getAttribute('data-revision')), { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(panel(page)).toHaveAttribute('data-busy', 'false', { timeout: 30_000 });
  await expect(view(page).locator('.viewer-loading')).toHaveCount(0, { timeout: 30_000 });
}

async function saveNow(page: Page) {
  const before = (await savedFiles(page)).length;
  await view(page).locator('[data-testid=save]').click();
  await expect.poll(async () => (await savedFiles(page)).length).toBe(before + 1);
  return (await savedFiles(page))[before]!;
}

interface Listed {
  marks: { id: string; spec: { kind: string; opacity?: number; diagonal?: boolean; text?: string; digits?: string }; pages: number[] }[];
  foreign: unknown[];
}

for (const L of LOCALES) {
  test.describe(`page marks (${L.locale})`, () => {
    test.use({ locale: L.browser });
    test.skip(!ENGINE_BUILT, 'needs the warraq-core engine');

    test('Arabic diagonal watermark at 30 % and «صفحة {page} من {pages}» footer: save, inspect, reopen', async ({ context, page }) => {
      test.setTimeout(180_000);
      await stubSavePicker(context);
      const external = trackExternalRequests(page);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', L.locale);
      await openMarks(page, fixture('marks-3.pdf'));

      // Watermark: Arabic text, diagonal, 30 % opacity; the preview shows the page with the mark.
      await panel(page).locator('[data-tab=watermark]').click();
      await panel(page).getByTestId('marks-text').fill('سري للغاية');
      await expect(panel(page).getByTestId('marks-diagonal')).toBeChecked();
      await panel(page).getByTestId('marks-opacity').fill('30');
      await expect(panel(page).getByTestId('marks-preview').locator('img')).toBeVisible({ timeout: 30_000 });
      await commit(page, () => panel(page).getByTestId('marks-apply').click());
      await expect(page.locator('.hud').last()).toContainText(L.added);
      await expect(items(page)).toHaveCount(1);

      // Footer with the Arabic page-of-pages preset, Arabic-Indic digits.
      await panel(page).locator('[data-tab=header]').click();
      await panel(page).getByTestId('marks-band').locator('[data-value=footer]').click();
      await panel(page).getByTestId('marks-slot-center').fill('صفحة {page} من {pages}');
      await panel(page).getByTestId('marks-digits').selectOption('arabic');
      await commit(page, () => panel(page).getByTestId('marks-apply').click());
      await expect(items(page)).toHaveCount(2);
      await expect(panel(page).locator('li[data-kind=footer]')).toContainText('صفحة {page} من {pages}');

      const saved = await saveNow(page);
      const original = fixtureBytes('marks-3.pdf');
      expect(saved.bytes.subarray(0, original.length).equals(original)).toBe(true);
      expect(saved.bytes.length).toBeGreaterThan(original.length);
      const doc = await openInEngine(saved.bytes);
      try {
        const hits = doc.call<{ hits: { page: number; text: string }[] }>('text.search', { query: 'صفحة ٢ من ٣' }).json.hits;
        expect(hits.map((h) => h.page)).toEqual([1]);
        expect(hits[0]!.text).toBe('صفحة ٢ من ٣');
        const pages = doc.call<{ pages: string[] }>('text.plain').json.pages;
        expect(pages[0]).toContain('صفحة ١ من ٣');
        expect(pages[2]).toContain('صفحة ٣ من ٣');
        expect(pages[1]).toContain('سري للغاية');
        // Excluded from the text of the page itself (pagination artifacts).
        expect(doc.call<{ text: string }>('text.plain', { artifacts: false }).json.text).not.toContain('سري');
        const listed = doc.call<Listed>('marks.list').json;
        expect(listed.foreign).toEqual([]);
        expect(listed.marks).toHaveLength(2);
        for (const m of listed.marks) {
          expect(m.id).toMatch(/^zm[0-9a-f]+$/);
          expect(m.pages).toEqual([0, 1, 2]);
        }
        const wm = listed.marks.find((m) => m.spec.kind === 'watermark')!;
        expect(wm.spec).toMatchObject({ text: 'سري للغاية', diagonal: true, opacity: 0.3 });
        expect(listed.marks.find((m) => m.spec.kind === 'footer')!.spec.digits).toBe('arabic');
        expect(doc.info().revisions).toBe(3);
      } finally {
        doc.close();
      }
      const text = saved.bytes.toString('latin1');
      expect(text).not.toContain('/Direction');

      // Reopen the saved file (fresh start): both marks are listed in the panel.
      await page.goto('/');
      await openMarks(page, { name: 'marks-saved.pdf', mimeType: 'application/pdf', buffer: saved.bytes });
      await expect(items(page)).toHaveCount(2);
      await expect(panel(page).locator('li[data-kind=watermark]')).toContainText('سري للغاية');
      expect(external).toEqual([]);
    });

    test('picture watermark, Bates numbers across pages, remove with undo/redo, gone after saving', async ({ context, page }) => {
      test.setTimeout(180_000);
      await stubSavePicker(context);
      await page.goto('/');
      await openMarks(page, fixture('marks-3.pdf'));

      // Picture watermark (PNG with transparency) behind the content.
      await panel(page).locator('[data-tab=watermark]').click();
      await panel(page).getByTestId('marks-type').locator('[data-value=picture]').click();
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), panel(page).getByTestId('marks-picture').click()]);
      await chooser.setFiles(fixture('logo.png'));
      await expect(panel(page).getByTestId('marks-picture-name')).toContainText('logo.png');
      await panel(page).getByTestId('marks-layer').locator('[data-value=behind]').click();
      await expect(panel(page).getByTestId('marks-preview').locator('img')).toBeVisible({ timeout: 30_000 });
      await commit(page, () => panel(page).getByTestId('marks-apply').click());
      await expect(panel(page).locator('li[data-kind=watermark]')).toHaveCount(1);

      // Bates: prefix, start typed in the locale's digits, 4 digits, Western digits in the file.
      await panel(page).locator('[data-tab=bates]').click();
      await panel(page).getByTestId('marks-bates-prefix').fill('ZD-');
      await panel(page).getByTestId('marks-bates-start').fill(L.locale === 'ar' ? '٧' : '7');
      await panel(page).getByTestId('marks-bates-digits').fill('4');
      await panel(page).getByTestId('marks-digits').selectOption('latin');
      await commit(page, () => panel(page).getByTestId('marks-apply').click());
      await expect(panel(page).locator('li[data-kind=bates]')).toContainText('ZD-0007');

      // Remove the picture watermark, undo brings it back, redo removes it again.
      await commit(page, () => panel(page).locator('li[data-kind=watermark] [data-action=remove]').click());
      await expect(page.locator('.hud').last()).toContainText(L.removed);
      await expect(panel(page).locator('li[data-kind=watermark]')).toHaveCount(0);
      await panel(page).getByTestId('marks-undo').click();
      await expect(panel(page).locator('li[data-kind=watermark]')).toHaveCount(1, { timeout: 30_000 });
      await panel(page).getByTestId('marks-redo').click();
      await expect(panel(page).locator('li[data-kind=watermark]')).toHaveCount(0, { timeout: 30_000 });
      await expect(view(page).locator('.viewer-loading')).toHaveCount(0, { timeout: 30_000 });

      const saved = await saveNow(page);
      const original = fixtureBytes('marks-3.pdf');
      expect(saved.bytes.subarray(0, original.length).equals(original)).toBe(true);
      const doc = await openInEngine(saved.bytes);
      try {
        const listed = doc.call<Listed>('marks.list').json;
        expect(listed.marks.map((m) => m.spec.kind)).toEqual(['bates']);
        const pages = doc.call<{ pages: string[] }>('text.plain').json.pages;
        expect(pages.map((p) => /ZD-\d{4}/.exec(p)?.[0])).toEqual(['ZD-0007', 'ZD-0008', 'ZD-0009']);
      } finally {
        doc.close();
      }
      // The picture was added in an earlier revision; the page no longer draws it.
      expect(saved.bytes.toString('latin1')).toContain('/SMask');
    });
  });
}

test('phone width: the Page marks panel fits and adds a mark', async ({ browser }) => {
  test.skip(!ENGINE_BUILT, 'needs the warraq-core engine');
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar-SA' });
  await stubSavePicker(context);
  const page = await context.newPage();
  await page.goto('/');
  await openMarks(page, fixture('marks-3.pdf'));
  const box = (await panel(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await panel(page).locator('[data-tab=numbers]').click();
  await panel(page).getByTestId('marks-number-preset').selectOption('صفحة {page} من {pages}');
  await expect(panel(page).getByTestId('marks-apply')).toBeInViewport();
  await commit(page, () => panel(page).getByTestId('marks-apply').click());
  await expect(panel(page).locator('li[data-kind=pageNumber]')).toHaveCount(1);
  const saved = await saveNow(page);
  const doc = await openInEngine(saved.bytes);
  try {
    expect(doc.call<{ pages: string[] }>('text.plain').json.pages[1]).toContain('صفحة ٢ من ٣');
  } finally {
    doc.close();
  }
  await context.close();
});
