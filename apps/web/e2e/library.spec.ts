import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { corpus, documentStatus, embedTiles, test } from './helpers';

/**
 * The Library, driven the way a person drives it: files added, read into the
 * index on this device, one word searched across all of them, and a hit
 * opened — which brings its document up at the page the match is on.
 *
 * The Arabic word is searched WITHOUT its tashkeel while the document carries
 * it with tashkeel, because that is the promise: the find bar's normalization,
 * over every document at once. Nothing leaves the app (`stayLocal`).
 */

/** Tashkeel on almost every letter: "الْمَكْتَبَةِ" is only ever written marked here. */
const TASHKEEL = corpus('generated/chrome-amiri-tashkeel-ligatures.pdf');
/** Three chapters, one page each: "الفصل الثالث" is on page 3 and nowhere else. */
const THREE_PAGES = corpus('generated/chrome-notonaskh-justified-3pages.pdf');
/** Two invoices in different fonts: "فاتورة" is in both, so one search crosses files. */
const INVOICE_A = corpus('generated/chrome-cairo-mixed-invoice.pdf');
const INVOICE_B = corpus('generated/raw-amiri-cid-identity-tounicode.pdf');

const panel = (page: Page) => page.locator('.pane-end');

async function openLibrary(page: Page): Promise<Locator> {
  await page.goto('/');
  // From the home screen: the Library needs no document open.
  await page.locator('.tool-cards-grid .tool-card', { hasText: 'Library' }).click();
  const library = panel(page);
  // The panel is there whichever state it is in; wait until the index has
  // been opened (or refused), so what it says next is what it means.
  await expect(library.locator('.library-panel')).toBeVisible();
  await expect(library.getByText('Opening the index…')).toHaveCount(0);
  return library;
}

/**
 * The index lives in the core, and the core operations behind it are another
 * part of this feature. Until they are in the build the panel says so on its
 * face rather than pretending; the spec says so too instead of failing.
 */
async function needsEngine(library: Locator): Promise<void> {
  const missing = library.getByText('This build has no Library engine');
  test.skip(await missing.isVisible(), 'this build has no library.* operations in the core yet');
  await expect(library.getByRole('heading', { name: 'Folders and files' })).toBeVisible();
}

async function addFiles(library: Locator, files: string[]): Promise<void> {
  await library.locator('input[type="file"][accept]').setInputFiles(files);
}

/** The summary line the run leaves behind: "Added: 4. Unchanged: 0. …". */
const summary = (library: Locator) => library.getByText(/^Added: \d+\./);

async function search(library: Locator, word: string): Promise<Locator> {
  await library.getByRole('searchbox', { name: 'Search the library' }).fill(word);
  await library.getByRole('button', { name: 'Search', exact: true }).click();
  return library.getByRole('list', { name: 'Results' });
}

test.describe('The Library searches across every document that was added', () => {
  test.setTimeout(240_000);

  test('finds an Arabic word searched without the tashkeel the document carries', async ({ page, stayLocal: _ }) => {
    const library = await openLibrary(page);
    await needsEngine(library);

    await addFiles(library, [TASHKEEL, THREE_PAGES, INVOICE_A, INVOICE_B]);
    await expect(summary(library)).toContainText('Added: 4.', { timeout: 180_000 });
    await expect(library.getByText(/Documents: 4 ·/)).toBeVisible();

    // The files write الْمَكْتَبَةِ; the person types المكتبة. Two of the four
    // carry that sentence, and only those two come back.
    const hits = await search(library, 'المكتبة');
    await expect(hits.locator('li')).toHaveCount(2);
    await expect(hits.locator('li').first()).toContainText('chrome-amiri-tashkeel-ligatures.pdf');
    await expect(hits.locator('li').first()).toContainText('Page 1');

    // The word is marked inside the line, and the marked word is the one
    // the document really carries — with every mark the query left out. A
    // span read as letters instead of bytes marks the wrong half of it.
    const marked = await hits.locator('mark').first().innerText();
    expect(marked).toMatch(/[ً-ْ]/);
    expect(marked.replace(/[ً-ْـ]/g, '')).toBe('المكتبة');

    // The line reads in its own direction, whatever the interface language is.
    await expect(hits.locator('.library-snippet').first()).toHaveAttribute('dir', 'auto');

    // One word, hits in more than one file: what the Library is for.
    const invoices = await search(library, 'فاتورة');
    await expect(invoices.locator('li').first()).toBeVisible();
    const named = await invoices.locator('.library-hit-name').allInnerTexts();
    expect(new Set(named).size).toBeGreaterThan(1);
  });

  test('opens a hit at the page the match is on, and reads a file only once', async ({ page, stayLocal: _ }) => {
    const library = await openLibrary(page);
    await needsEngine(library);

    await addFiles(library, [TASHKEEL, THREE_PAGES, INVOICE_A]);
    await expect(summary(library)).toContainText('Added: 3.', { timeout: 180_000 });

    // The same files again: nothing is read a second time.
    await addFiles(library, [TASHKEEL, THREE_PAGES, INVOICE_A]);
    await expect(summary(library)).toContainText('Added: 0. Unchanged: 3.', { timeout: 120_000 });

    // "الفصل الثالث" heads page 3 of the three-chapter file and appears nowhere else.
    const hits = await search(library, 'الثالث');
    const first = hits.locator('li').first();
    await expect(first).toContainText('chrome-notonaskh-justified-3pages.pdf');
    await expect(first).toContainText('Page 3');

    await first.locator('.library-hit-open').click();
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    await expect(documentStatus(page)).toContainText('Page 3 of 3', { timeout: 60_000 });
  });

  test('deletes the index when asked, and says the files were not touched', async ({ page, stayLocal: _ }) => {
    const library = await openLibrary(page);
    await needsEngine(library);

    await addFiles(library, [INVOICE_A]);
    await expect(summary(library)).toContainText('Added: 1.', { timeout: 120_000 });

    await library.getByRole('button', { name: 'Delete the index' }).click();
    await page.getByRole('button', { name: 'Delete it' }).click();
    await expect(library.getByText('Nothing has been indexed yet.')).toBeVisible();
    await expect(library.getByText('No folder has been added yet.')).toBeVisible();

    // And it is really gone: a reload finds an empty index, not the old one.
    await page.reload();
    await page.locator('.tool-cards-grid .tool-card', { hasText: 'Library' }).click();
    await expect(panel(page).getByText('Nothing has been indexed yet.')).toBeVisible();
  });
});
