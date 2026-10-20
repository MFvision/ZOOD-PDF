import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INVOICE, answer, chooseTool, enterEditText, neverAskedAboutFonts, openPdf, test } from './helpers';
import { readable, textOf } from './pdfBytes';

/**
 * One blue line, "Meeting Intelligence quarterly", in an embedded subset
 * the file calls Montserrat SemiBold: the subset has those letters and no
 * others (written by `warraq-core/tests/edit_own_font.rs`).
 */
const SUBSET = fileURLToPath(new URL('../../../tests/fixtures/edit/own-font-subset.pdf', import.meta.url));

/** The same line in a subset of Tajawal: an open family the app does not carry. */
const TAJAWAL_PAGE = fileURLToPath(new URL('../../../tests/fixtures/edit/tajawal-subset.pdf', import.meta.url));
const TAJAWAL_FONT = fileURLToPath(new URL('../../../tests/fonts/Tajawal-Regular.ttf', import.meta.url));

/** The open font library's two hosts, answered here: nothing reaches them. */
async function fakeLibrary(page: Page) {
  const catalogue = await answer(page, 'https://api.fontsource.org/', () => ({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      id: 'tajawal',
      family: 'Tajawal',
      subsets: ['arabic', 'latin'],
      weights: [200, 300, 400, 500, 700, 800, 900],
      styles: ['normal'],
      license: 'OFL-1.1',
      category: 'sans-serif',
    }),
  }));
  const files = await answer(page, 'https://cdn.jsdelivr.net/', () => ({
    status: 200,
    contentType: 'font/ttf',
    headers: { 'access-control-allow-origin': '*' },
    body: readFileSync(TAJAWAL_FONT),
  }));
  return { catalogue, files, all: () => [...catalogue, ...files].map((request) => request.url()) };
}

/**
 * Edit text on a page with one thin line on it: too little ink for
 * `enterEditText`'s measure of a drawn page, so the paragraph's box is
 * waited for instead.
 */
async function enterEditOnSparsePage(page: Page): Promise<Locator> {
  await chooseTool(page, 'Edit');
  const first = page.locator('section[data-page="1"]');
  await expect(first.locator('.edit-box').first()).toBeVisible();
  return first;
}

/** Opens the first paragraph, types `text` over it and applies. */
async function replaceFirst(first: Locator, text: string) {
  await first.locator('.edit-box').first().click();
  const area = first.locator('.paragraph-editor-area');
  await area.fill(text);
  await area.press(APPLY);
}

const APPLY = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';

/** How many font dictionaries a file's bytes hold, every revision counted. */
const fontObjects = (bytes: Buffer) => (readable(bytes).match(/\/Type\s*\/Font\b(?!Descriptor)/g) ?? []).length;

/** The Edit panel's font control. */
const fontControl = (page: Page) => page.locator('.tool-panel select:has(option[value="auto"])');

async function save(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const saved = await download.path();
  expect(saved).toBeTruthy();
  return saved;
}

test.describe('replaced text keeps the font it was set in', () => {
  test('the font control starts on Automatic and says what it resolves to', async ({ page, stayLocal: _stayLocal }) => {
    await page.goto('/');
    await openPdf(page, SUBSET);
    const first = await enterEditText(page);
    const font = fontControl(page);
    await expect(font).toHaveValue('auto');
    await expect(font.locator('option')).toHaveText(['Automatic', 'Amiri', 'Cairo', 'Inter']);
    const resolved = page.getByTestId('edit-font-resolved');
    await expect(resolved).toHaveText('Each paragraph keeps its own font where it can.');
    await first.locator('.edit-box').first().click();
    await expect(first.locator('.paragraph-editor-area')).toBeVisible();
    await expect(resolved).toContainText("The document's own font");
    await expect(resolved).toContainText('Montserrat SemiBold');
  });

  test('letters the document already has are drawn in its own font: nothing embedded, same size and colour', async ({
    page,
    stayLocal: _stayLocal,
  }) => {
    const original = readFileSync(SUBSET);
    await page.goto('/');
    await openPdf(page, SUBSET);
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    await area.fill('Meeting gently');
    await area.press(APPLY);
    await expect(first.locator('.text-layer')).toContainText('Meeting gently');
    // Nothing was substituted, so nothing is announced.
    await expect(page.locator('.banner-warning')).toHaveCount(0);

    const saved = await save(page);
    expect(await textOf(saved)).toBe('Meeting gently');
    const bytes = readFileSync(saved);
    expect(fontObjects(bytes), 'no font was added to the file').toBe(fontObjects(original));
    const text = readable(bytes);
    // The replacement is the last text object: the page's own resource, at
    // its 14 points, in the blue the line was painted in.
    const drawn = text.slice(text.lastIndexOf('0.2 0.3 0.9 rg'));
    expect(drawn).toMatch(/^0\.2 0\.3 0\.9 rg\s+BT\s+\/FW1 14 Tf/);
    expect(text).not.toContain('Amiri');
  });

  test('a letter the document lacks falls through to the closest face, and the notice says which and why', async ({
    page,
    stayLocal: _stayLocal,
  }) => {
    await neverAskedAboutFonts(page);
    await page.goto('/');
    await openPdf(page, SUBSET);
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    // No b, o or x in the subset.
    await area.fill('Meeting box');
    await area.press(APPLY);
    // Montserrat is an open family: the one-time question is asked, and
    // answered no — nothing is fetched (`stayLocal` would fail the test).
    await page.getByRole('dialog', { name: 'Download matching fonts?' }).getByRole('button', { name: 'No, use the closest font' }).click();
    await expect(first.locator('.text-layer')).toContainText('Meeting box');
    const notice = page.locator('.banner-warning');
    await expect(notice).toContainText('Font substituted.');
    await expect(notice).toContainText('Montserrat');
    // A sans, Latin: Inter, not the Naskh every edit used to come back in.
    await expect(notice).toContainText('Inter');
    await expect(notice).not.toContainText('Amiri');

    const saved = await save(page);
    expect(await textOf(saved)).toBe('Meeting box');
    const text = readable(readFileSync(saved));
    // The subset embedded for it is named for what it is.
    expect(text).toContain('/BaseFont /WARRAQ+Inter');
    expect(text).not.toContain('Amiri');
  });

  test('choosing a face overrides Automatic', async ({ page, stayLocal: _stayLocal }) => {
    await page.goto('/');
    await openPdf(page, SUBSET);
    const first = await enterEditText(page);
    await fontControl(page).selectOption('amiri');
    await expect(page.getByTestId('edit-font-resolved')).toHaveCount(0);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    await area.fill('Meeting gently');
    await area.press(APPLY);
    await expect(first.locator('.text-layer')).toContainText('Meeting gently');
    const notice = page.locator('.banner-warning');
    await expect(notice).toContainText('The face chosen in the Edit panel');
    await expect(notice).toContainText('Amiri');
    expect(readable(readFileSync(await save(page)))).toContain('/BaseFont /WARRAQ+Amiri');
  });

  test('Arabic is never drawn by the document\'s own codes: it is reshaped in the closest face', async ({
    page,
    stayLocal: _stayLocal,
  }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    await expect(area).toBeVisible();
    // Set in a subset of Amiri, which the app carries whole.
    const resolved = page.getByTestId('edit-font-resolved');
    await expect(resolved).toContainText('Amiri');
    await expect(resolved).toContainText('which the app carries in full');
    await expect(resolved).not.toContainText("The document's own font");
    const replacement = 'نص عربي جديد';
    await area.fill(replacement);
    await area.press(APPLY);
    await expect(first.locator('.text-layer')).toContainText(replacement);
    await expect(page.locator('.banner-warning')).toContainText("the app's copy of \u2068Amiri\u2069 was embedded");
    const saved = await save(page);
    expect(await textOf(saved)).toContain(replacement);
    // A new subset was embedded for it, and the file names it truthfully.
    expect(readable(readFileSync(saved))).toContain('WARRAQ+Amiri');
  });

  test('in Arabic the control and the notice read naturally', async ({ page, stayLocal: _stayLocal }) => {
    await neverAskedAboutFonts(page);
    await page.goto('/');
    await openPdf(page, SUBSET);
    const first = await enterEditText(page);
    await page.getByRole('menubar').getByRole('combobox', { name: 'Language' }).selectOption({ label: 'العربية' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const resolved = page.getByTestId('edit-font-resolved');
    await expect(resolved).toHaveText('تحتفظ كل فقرة بخطها حيثما أمكن.');
    await expect(fontControl(page).locator('option').first()).toHaveText('تلقائي');
    await first.locator('.edit-box').first().click();
    await expect(resolved).toContainText('خط المستند نفسه');
    const area = first.locator('.paragraph-editor-area');
    await area.fill('Meeting box');
    await area.press(APPLY);
    // The question, in Arabic, saying what is sent and what is not.
    const question = page.getByRole('dialog', { name: 'تنزيل الخطوط المطابقة؟' });
    await expect(question).toContainText('Montserrat');
    await expect(question).toContainText('لا يُرسَل إلا اسم الخط');
    await expect(question).toContainText('أما المستند ونصه وكل ما عداه فيبقى على هذا الجهاز');
    await question.getByRole('button', { name: 'لا، استخدم أقرب خط' }).click();
    const notice = page.locator('.banner-warning');
    await expect(notice).toContainText('جرى استبدال الخط.');
    await expect(notice).toContainText('أقرب خط يحمله التطبيق');
    await expect(notice).toContainText('Inter');
  });

  test('the open library: asked once, only the font\'s name is sent, and the family is embedded — not Amiri', async ({
    page,
    stayLocal: _stayLocal,
  }) => {
    const library = await fakeLibrary(page);
    await neverAskedAboutFonts(page);
    await page.goto('/');
    await openPdf(page, TAJAWAL_PAGE);
    const first = await enterEditOnSparsePage(page);
    await first.locator('.edit-box').first().click();
    await expect(page.getByTestId('edit-font-resolved')).toContainText("The document's own font (\u2068Tajawal\u2069)");
    const area = first.locator('.paragraph-editor-area');
    // No b, o or x in the document's subset of Tajawal.
    await area.fill('Meeting box');
    await area.press(APPLY);

    // Asked first; until the answer, nothing has been fetched.
    const question = page.getByRole('dialog', { name: 'Download matching fonts?' });
    await expect(question).toContainText('Tajawal');
    await expect(question).toContainText("Only the font's name is sent, to api.fontsource.org and cdn.jsdelivr.net.");
    await expect(question).toContainText('The document, its text and everything else stay on this device.');
    expect(library.all()).toEqual([]);
    await question.getByRole('button', { name: 'Download matching fonts' }).click();

    await expect(first.locator('.text-layer')).toContainText('Meeting box');
    const notice = page.locator('.banner-matched');
    await expect(notice).toContainText('Font matched.');
    await expect(notice).toContainText('downloaded from the open font library');
    await expect(notice).toContainText('Tajawal');
    // Two requests, and the family's name is all there is in them.
    expect(library.all()).toEqual([
      'https://api.fontsource.org/v1/fonts/tajawal',
      'https://cdn.jsdelivr.net/fontsource/fonts/tajawal@latest/latin-400-normal.ttf',
    ]);
    for (const request of [...library.catalogue, ...library.files]) {
      expect(request.method()).toBe('GET');
      expect(request.postData()).toBeNull();
      expect(request.headers().cookie).toBeUndefined();
      expect(request.headers().referer ?? '').toBe('');
    }

    // Another edit of the family asks no one: the font is kept on the device.
    await replaceFirst(first, 'Meeting fox');
    await expect(first.locator('.text-layer')).toContainText('Meeting fox');
    await expect(page.getByRole('dialog', { name: 'Download matching fonts?' })).toHaveCount(0);
    expect(library.all()).toHaveLength(2);

    const saved = await save(page);
    expect(await textOf(saved)).toBe('Meeting fox');
    const text = readable(readFileSync(saved));
    // The family the paragraph was set in is what is embedded.
    expect(text).toContain('/BaseFont /WARRAQ+Tajawal');
    expect(text).not.toContain('Amiri');
    expect(text).not.toContain('WARRAQ+Inter');

    // Settings: the switch is on, the fonts' size is shown, and they can be deleted.
    await page.getByRole('menubar').getByRole('menuitem', { name: 'محرر زود PDF' }).click();
    await page.getByRole('menuitem', { name: /^Settings…/ }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const toggle = settings.getByRole('checkbox', { name: 'Download matching fonts automatically when editing text' });
    await expect(toggle).toBeChecked();
    const usage = settings.getByTestId('font-library-usage');
    await expect(usage).toHaveText(/^Downloaded fonts: 1 \(\u2068\d+ kB\u2069\)$/);
    await settings.getByRole('button', { name: 'Delete downloaded fonts' }).click();
    await expect(usage).toHaveText('No fonts have been downloaded.');
    expect(await page.evaluate(() => caches.has('warraq-fonts-v1'))).toBe(false);
    // Off: the next edit that would need it takes the closest face, and asks no one.
    await toggle.uncheck();
    await settings.getByRole('button', { name: 'Close' }).click();
    await replaceFirst(first, 'Meeting vox');
    await expect(first.locator('.text-layer')).toContainText('Meeting vox');
    expect(library.all()).toHaveLength(2);
  });

  test('answering no is remembered: nothing is ever fetched, and the closest face is used', async ({ page, stayLocal: _stayLocal }) => {
    const library = await fakeLibrary(page);
    await neverAskedAboutFonts(page);
    await page.goto('/');
    await openPdf(page, TAJAWAL_PAGE);
    const first = await enterEditOnSparsePage(page);
    await replaceFirst(first, 'Meeting box');
    await page.getByRole('dialog', { name: 'Download matching fonts?' }).getByRole('button', { name: 'No, use the closest font' }).click();
    await expect(first.locator('.text-layer')).toContainText('Meeting box');
    await expect(page.locator('.banner-warning')).toContainText('Inter');
    // Not asked a second time.
    await replaceFirst(first, 'Meeting fox');
    await expect(first.locator('.text-layer')).toContainText('Meeting fox');
    await expect(page.getByRole('dialog', { name: 'Download matching fonts?' })).toHaveCount(0);
    expect(library.all()).toEqual([]);
    expect(readable(readFileSync(await save(page)))).toContain('/BaseFont /WARRAQ+Inter');
  });
});
