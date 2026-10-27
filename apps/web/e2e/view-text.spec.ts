import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { corpus, documentStatus, embedPage, openPdf, pageBox, test } from './helpers';

/**
 * Search and copy in EmbedPDF's view answer with Warraq's reader: Arabic is
 * found with or without its diacritics and whatever form its letters and
 * digits take, and what is selected copies in logical order — where PDFium,
 * on these files, finds nothing and copies the text garbled.
 */

const THREE_PAGES = corpus('generated/chrome-notonaskh-justified-3pages.pdf');
const TASHKEEL = corpus('generated/chrome-amiri-tashkeel-ligatures.pdf');
const DIGITS = corpus('generated/chrome-tajawal-persian-urdu-digits.pdf');
const FORM = corpus('generated/chrome-notosansarabic-form-layout.pdf');
const CONTRACT = fileURLToPath(new URL('../../../tests/fixtures/redact/contract.pdf', import.meta.url));

const truth = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../tests/corpus/arabic/truth/${name}.txt`, import.meta.url)), 'utf8');
/** The words of a text in order, however its lines break. */
const words = (text: string) => text.split(/\s+/).filter(Boolean).join(' ');

const panel = (page: Page) => page.locator('embedpdf-container [data-sidebar-id="search-panel"]');

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** EmbedPDF's search state, and what PDFium alone finds for the same words. */
async function searchState(page: Page, query: string) {
  return page.evaluate(async (words) => {
    const registry: Any = await (document.querySelector('embedpdf-container') as Any).registry;
    const engine = registry.getEngine();
    const doc = registry.getPlugin('document-manager').provides().getActiveDocument();
    // The engine's own search, from its class: what the view had before.
    const pdfium = await Object.getPrototypeOf(engine).searchAllPages.call(engine, doc, words, { flags: [] }).toPromise();
    const state = registry.getPlugin('search').provides().getState();
    const root = document.querySelector('embedpdf-container')!.shadowRoot!;
    const marks = [...root.querySelectorAll<HTMLElement>('div')].filter((div) => div.style.mixBlendMode === 'multiply');
    return {
      total: state.total as number,
      query: state.query as string,
      loading: state.loading as boolean,
      active: state.activeResultIndex as number,
      pages: (state.results as { pageIndex: number }[]).map((result) => result.pageIndex),
      matched: (state.results as { context: { match: string } }[]).map((result) => result.context.match),
      pdfium: pdfium.total as number,
      // The active hit is drawn orange, the others yellow.
      activeMarks: marks.filter((div) => div.style.backgroundColor === 'rgb(255, 191, 0)').length,
      marks: marks.length,
    };
  }, query);
}

/**
 * Types into EmbedPDF's search field and waits until it has searched for
 * exactly that: the panel searches 300 ms after the last key, and a count
 * that did not change ("Matches: 7" for two spellings) is no sign of it.
 */
async function search(page: Page, query: string, count: number): Promise<void> {
  await panel(page).getByPlaceholder('Search').fill(query);
  await expect
    .poll(() =>
      page.evaluate(async (words) => {
        const registry: Any = await (document.querySelector('embedpdf-container') as Any).registry;
        const state = registry.getPlugin('search').provides().getState();
        return state.query === words && !state.loading ? (state.total as number) : -1;
      }, query.trim()),
    )
    .toBe(count);
  await expect(panel(page).getByText(`Matches: ${count}`)).toBeVisible();
}

test.describe("Search in the page view uses Warraq's Arabic-aware engine", () => {
  test('Cmd+F finds Arabic with and without its diacritics, highlighted on the page, with next and previous', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, THREE_PAGES);
    await page.keyboard.press('ControlOrMeta+f');
    await expect(panel(page).getByPlaceholder('Search')).toBeVisible();

    await search(page, 'وراق', 7);
    let state = await searchState(page, 'وراق');
    // PDFium, reading this file out of order, finds none of them.
    expect(state.pdfium).toBe(0);
    expect(state.pages).toEqual([0, 0, 0, 1, 1, 2, 2]);
    expect(state.active).toBe(0);
    await expect.poll(async () => (await searchState(page, 'وراق')).activeMarks).toBeGreaterThan(0);
    expect((await searchState(page, 'وراق')).marks).toBeGreaterThanOrEqual(3);

    // The same word written with its shadda: the same seven.
    await search(page, 'ورّاق', 7);
    state = await searchState(page, 'ورّاق');
    expect(state.pages).toEqual([0, 0, 0, 1, 1, 2, 2]);

    // Next three times reaches the first hit on page 2, and the view goes there.
    for (let step = 0; step < 3; step += 1) await panel(page).getByRole('button', { name: 'Next result' }).click();
    await expect.poll(async () => (await searchState(page, 'وراق')).active).toBe(3);
    await expect.poll(() => embedPage(page)).toBe(2);
    await expect(documentStatus(page)).toContainText('Page 2 of 3');
    await panel(page).getByRole('button', { name: 'Previous result' }).click();
    await expect.poll(async () => (await searchState(page, 'وراق')).active).toBe(2);
    await expect.poll(() => embedPage(page)).toBe(1);
    // A hit in the list goes to it too.
    await panel(page).getByRole('button', { name: /الفصل الأول/ }).first().click();
    await expect.poll(async () => (await searchState(page, 'وراق')).active).toBe(0);
  });

  test('taa marbuta, alef and digit forms are one letter to it; case and whole words on request', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, TASHKEEL);
    await page.keyboard.press('ControlOrMeta+f');
    // Written with haa and no diacritics, and as the page has it.
    await search(page, 'مكتبه', 1);
    expect((await searchState(page, 'مكتبه')).matched).toEqual(['مَكْتَبَةِ']);
    await search(page, 'الْمَكْتَبَةِ', 1);
    await search(page, 'الْعِلْمُ', 1);
    await search(page, 'العلم', 1);

    await page.goto('/');
    await openPdf(page, DIGITS);
    await page.keyboard.press('ControlOrMeta+f');
    // Western, Arabic-Indic and Persian digits alike.
    await search(page, '0123', 3);
    expect((await searchState(page, '0123')).matched).toEqual(['٠١٢٣', '۰۱۲۳', '0123']);
    await search(page, '٤٥٦', 3);

    await page.goto('/');
    await openPdf(page, CONTRACT);
    await page.keyboard.press('ControlOrMeta+f');
    await search(page, 'haddad', 2);
    await panel(page).getByLabel('Case sensitive').check();
    await expect(panel(page).getByText('Matches: 1')).toBeVisible();
    expect((await searchState(page, 'haddad')).matched).toEqual(['haddad']);
    await panel(page).getByLabel('Case sensitive').uncheck();
    await search(page, 'Hadd', 2);
    await panel(page).getByLabel('Whole word').check();
    await expect(panel(page).getByText('Matches: 0')).toBeVisible();
    await search(page, 'Haddad', 2);
  });
});

/**
 * The first and last glyph PDFium has on a page — or on its first line — in
 * points, and the page's width: where a person's drag starts and ends.
 */
async function glyphEnds(page: Page, scope: 'page' | 'first line') {
  return page.evaluate(async (which) => {
    const registry: Any = await (document.querySelector('embedpdf-container') as Any).registry;
    const doc = registry.getPlugin('document-manager').provides().getActiveDocument();
    const geometry = await registry.getEngine().getPageGeometry(doc, doc.pages[0]).toPromise();
    type G = { index: number; x: number; y: number; width: number; height: number };
    let glyphs: G[] = geometry.runs.flatMap((run: Any) =>
      run.glyphs.map((glyph: Any, offset: number) => ({ ...glyph, index: run.charStart + offset })).filter((glyph: Any) => glyph.flags === 0 && glyph.width > 0),
    );
    if (which === 'first line') {
      const top = Math.min(...glyphs.map((g) => g.y + g.height / 2));
      glyphs = glyphs.filter((g) => Math.abs(g.y + g.height / 2 - top) < g.height / 2);
    }
    const first = glyphs.reduce((a, b) => (b.index < a.index ? b : a));
    const last = glyphs.reduce((a, b) => (b.index > a.index ? b : a));
    const centre = (g: G) => ({ x: g.x + g.width / 2, y: g.y + g.height / 2 });
    return { from: centre(first), to: centre(last), width: doc.pages[0].size.width as number, start: first.index, end: last.index };
  }, scope);
}

/** Drags across the text from `from` to `to` (points), as a person selects it, and copies it with Cmd+C. */
async function selectAndCopy(page: Page, scope: 'page' | 'first line'): Promise<{ copied: string; pdfium: string }> {
  const ends = await glyphEnds(page, scope);
  const box = await pageBox(page);
  const scale = box.width / ends.width;
  const at = (p: { x: number; y: number }) => ({ x: box.x + p.x * scale, y: box.y + p.y * scale });
  const from = at(ends.from);
  const to = at(ends.to);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // What PDFium itself gives for the same characters.
  const pdfium = await page.evaluate(async ({ start, end }) => {
    const registry: Any = await (document.querySelector('embedpdf-container') as Any).registry;
    const engine = registry.getEngine();
    const doc = registry.getPlugin('document-manager').provides().getActiveDocument();
    const slices = [{ pageIndex: 0, charIndex: start, charCount: end - start + 1 }];
    return ((await Object.getPrototypeOf(engine).getTextSlices.call(engine, doc, slices).toPromise()) as string[]).join('\n');
  }, ends);
  return { copied, pdfium };
}

test.describe('Copy from the page view reads in logical order', () => {
  test('a whole page copies as the corpus truth reads, where PDFium garbles it', async ({ page, context, stayLocal: _ }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await openPdf(page, FORM);
    const form = await selectAndCopy(page, 'page');
    expect(words(form.copied)).toBe(words(truth('chrome-notosansarabic-form-layout')));
    // PDFium reads this Chrome-made form backwards: what it alone would copy.
    expect(words(form.pdfium)).not.toBe(words(truth('chrome-notosansarabic-form-layout')));

    // Persian and Urdu letters and three digit scripts, as written.
    await page.goto('/');
    await openPdf(page, DIGITS);
    const digits = await selectAndCopy(page, 'page');
    expect(words(digits.copied)).toBe(words(truth('chrome-tajawal-persian-urdu-digits')));
  });

  test('one line copies as that line, nothing more', async ({ page, context, stayLocal: _ }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await openPdf(page, FORM);
    const { copied } = await selectAndCopy(page, 'first line');
    expect(copied.trim()).toBe(truth('chrome-notosansarabic-form-layout').split('\n')[0]);
  });
});
