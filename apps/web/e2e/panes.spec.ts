import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { corpus, embedDocument, embedPage, enterEditText, openPdf, test } from './helpers';
import { callOn } from './pdfBytes';

const fixture = (path: string) => fileURLToPath(new URL(`../../../tests/fixtures/${path}`, import.meta.url));
/** Two attachments: the document's own (doc-secret.txt) and one on page 1 (annot-secret.txt). */
const EVERYTHING = fixture('hidden/everything.pdf');
/** Four layers, one named in Arabic, one off, one locked (tests/fixtures/layers/make.py). */
const LAYERS = fixture('layers/layers.pdf');
/** Three pages, with Arabic bookmarks. */
const OUTLINED = corpus('generated/variant-arabic-metadata-outlines-annots.pdf');
/** An outline with a heading that goes nowhere, over a page and a web address (tests/fixtures/panes/make.py). */
const HEADINGS = fixture('panes/headings.pdf');

const navigation = (page: Page) => page.getByRole('complementary', { name: 'Navigation' });

/** Opens a document pane from the View menu, where a person looks for it. */
async function openPane(page: Page, name: 'Bookmarks' | 'Attachments' | 'Layers'): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
  await expect(navigation(page).getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

async function save(page: Page, name: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const path = `test-results/${name}-${download.suggestedFilename()}`;
  await download.saveAs(path);
  return path;
}

/** Pixels of the page EmbedPDF shows that are nearly pure `channel` (the layers draw red, green, blue squares). */
async function colourPixels(page: Page, channel: 'red' | 'green' | 'blue'): Promise<number> {
  return page.evaluate(async (want) => {
    const root = document.querySelector('embedpdf-container')?.shadowRoot;
    const images = root ? [...root.querySelectorAll('img')].filter((img) => img.naturalWidth > 300) : [];
    let count = 0;
    for (const img of images) {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.drawImage(img, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 16) {
        const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
        const hit = want === 'red' ? r > 200 && g < 60 && b < 60 : want === 'blue' ? b > 200 && r < 60 && g < 60 : g > 120 && r < 60 && b < 60;
        if (hit) count += 1;
      }
    }
    return count;
  }, channel);
}

interface Listed {
  layers: { name: string; visible: boolean }[];
}

test.describe('the navigation pane: bookmarks, attachments and layers, in both views', () => {
  test('bookmarks: listed with their levels, and a click goes to the page', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, OUTLINED);
    await openPane(page, 'Bookmarks');
    const tree = navigation(page).getByRole('tree', { name: 'Bookmarks' });
    await expect(tree.getByRole('treeitem')).toHaveCount(6);
    await expect(tree.getByRole('treeitem', { level: 2 })).toHaveCount(3);
    await tree.getByRole('treeitem', { name: 'الفصل الثالث: الخصوصية والمزامنة', exact: true }).click();
    await expect.poll(() => embedPage(page)).toBe(3);
    // The keyboard of a tree: one stop in the Tab order, the arrows move and
    // open and close, Enter goes to the page.
    const first = tree.getByRole('treeitem', { name: 'الفصل الأول: لماذا وراق؟', exact: true });
    await first.focus();
    await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    // Closing an entry hides what is under it; opening shows it again.
    await page.keyboard.press('ArrowLeft');
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await expect(tree.getByRole('treeitem')).toHaveCount(5);
    await page.keyboard.press('ArrowRight');
    await expect(tree.getByRole('treeitem')).toHaveCount(6);
    await page.keyboard.press('ArrowRight');
    const child = tree.getByRole('treeitem', { level: 2 }).first();
    await expect(child).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(first).toBeFocused();
    await page.keyboard.press('End');
    await expect(tree.getByRole('treeitem').last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
    const { result } = await callOn<{ bookmarks: { title: string; page: number | null }[] }>('outline.list', OUTLINED);
    const goesTo = result.bookmarks.find((b) => b.title === 'الفصل الأول: لماذا وراق؟')?.page ?? null;
    expect(goesTo).not.toBeNull();
    await page.keyboard.press('Enter');
    await expect.poll(() => embedPage(page)).toBe((goesTo ?? 0) + 1);
    // Closed again, to be seen so in the editor.
    await first.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tree.getByRole('treeitem')).toHaveCount(5);

    // The same pane, as it was left, in Warraq's editor beside the pages.
    await enterEditText(page);
    await expect(navigation(page).getByRole('tab')).toHaveCount(4);
    await expect(navigation(page).getByRole('tree', { name: 'Bookmarks' }).getByRole('treeitem')).toHaveCount(5);
    await navigation(page).getByRole('tab', { name: 'Thumbnails' }).click();
    await expect(navigation(page).getByRole('tree', { name: 'Bookmarks' })).toHaveCount(0);
  });

  test('attachments: listed, saved (never opened), added and removed; the saved file has the change', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, EVERYTHING);
    await openPane(page, 'Attachments');
    const files = navigation(page).getByRole('list', { name: 'Attachments' }).getByRole('listitem');
    await expect(files).toHaveCount(2);
    await expect(files.first()).toContainText('doc-secret.txt');
    await expect(files.first()).toContainText('18 bytes');
    await expect(files.first()).toContainText('A document attachment');
    await expect(files.nth(1)).toContainText('On page 1');

    // Saved as bytes, through the download the person chooses.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      navigation(page).getByRole('button', { name: 'Save doc-secret.txt…' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('doc-secret.txt');
    await download.saveAs('test-results/doc-secret.txt');
    expect(readFileSync('test-results/doc-secret.txt', 'utf8')).toBe('ATTACH-DOC-SECRET\n');

    // Added, with an Arabic name and a description.
    await navigation(page).getByLabel('Description of the next file (optional)').fill('ملاحظات الاجتماع');
    await navigation(page).getByTestId('attach-input').setInputFiles({
      name: 'ملاحظات.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('نص المرفق'),
    });
    await expect(files).toHaveCount(3);
    await expect(files.filter({ hasText: 'ملاحظات.txt' })).toContainText('ملاحظات الاجتماع');

    // Removed: the one on the page.
    await navigation(page).getByRole('button', { name: 'Remove annot-secret.txt' }).click();
    await expect(files).toHaveCount(2);
    await expect(navigation(page).getByRole('status')).toContainText('Removed.');

    const saved = await save(page, 'attachments');
    const { result } = await callOn<{ attachments: { name: string; description: string | null }[] }>('attachments.list', saved);
    expect(result.attachments.map((a) => a.name)).toEqual(['doc-secret.txt', 'ملاحظات.txt']);
    expect(result.attachments[1]?.description).toBe('ملاحظات الاجتماع');
    const { blobs } = await callOn('attachments.get', saved, { key: 'd1' });
    expect(Buffer.from(blobs[0]!).toString('utf8')).toBe('نص المرفق');
  });

  test('layers: shown and hidden in the view only, until kept with the file', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, LAYERS);
    await openPane(page, 'Layers');
    // Every layer always shown in the list, so a list, not a tree: nothing opens or closes.
    await expect(navigation(page).getByRole('tree')).toHaveCount(0);
    const tree = navigation(page).getByRole('list', { name: 'Layers' });
    const box = (name: string) => tree.getByRole('checkbox', { name, exact: false });
    await expect(box('Text')).toBeChecked();
    await expect(box('طبقة عربية')).toBeChecked();
    await expect(box('Watermark')).not.toBeChecked();
    await expect(box('Locked notes')).toBeDisabled();
    await expect(tree).toContainText('Extras');
    await expect(tree).toContainText('Printed');
    await expect.poll(() => colourPixels(page, 'blue')).toBeGreaterThan(500);
    expect(await colourPixels(page, 'red')).toBe(0);

    // The watermark shown, the Arabic-named layer hidden: the view changes…
    const before = (await embedDocument(page)).id;
    await box('Watermark').check();
    await expect.poll(async () => (await embedDocument(page)).id).not.toBe(before);
    await expect.poll(() => colourPixels(page, 'red')).toBeGreaterThan(500);
    await box('طبقة عربية').uncheck();
    await expect(box('طبقة عربية')).not.toBeChecked();
    await expect.poll(() => colourPixels(page, 'blue')).toBe(0);

    // …the file does not: saved now, it comes back as it was, byte for byte.
    const untouched = await save(page, 'layers-view');
    expect(readFileSync(untouched).equals(readFileSync(LAYERS))).toBe(true);

    // Kept with the file, and saved: now the file says so.
    await navigation(page).getByRole('button', { name: 'Save layer visibility with the file' }).click();
    await expect(navigation(page).getByRole('button', { name: 'Save layer visibility with the file' })).toHaveCount(0);
    const kept = await save(page, 'layers-kept');
    const { result } = await callOn<Listed>('layers.list', kept);
    expect(result.layers.map((l) => [l.name, l.visible])).toEqual([
      ['Text', true],
      ['طبقة عربية', false],
      ['Watermark', true],
      ['Locked notes', true],
    ]);
    // An update of the file: its own bytes are still its first ones.
    const original = readFileSync(LAYERS);
    expect(readFileSync(kept).subarray(0, original.length).equals(original)).toBe(true);
  });

  test('bookmarks: a heading is a heading, and only an entry that leaves the file says so', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, HEADINGS);
    await openPane(page, 'Bookmarks');
    const tree = navigation(page).getByRole('tree', { name: 'Bookmarks' });
    await expect(tree.getByRole('treeitem')).toHaveCount(4);
    const heading = tree.getByRole('treeitem', { name: 'Part one', exact: true });
    const web = tree.getByRole('treeitem', { name: 'On the web', exact: true });
    await expect(heading.locator('.docpane-heading')).toHaveCount(1);
    await expect(heading).not.toHaveAttribute('title');
    await expect(heading.locator('.lucide-external-link')).toHaveCount(0);
    await expect(web).toHaveAttribute('title', 'Goes outside this file');
    await expect(web.locator('.lucide-external-link')).toHaveCount(1);
    // Choosing the heading opens or closes what it heads; the page stays.
    await heading.click();
    await expect(tree.getByRole('treeitem')).toHaveCount(2);
    await tree.getByRole('treeitem', { name: 'Appendix', exact: true }).click();
    await expect.poll(() => embedPage(page)).toBe(2);
  });

  test('the pane switcher is one stop in the Tab order, and the arrows move along it', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, EVERYTHING);
    await openPane(page, 'Bookmarks');
    const tabs = navigation(page).getByRole('tablist');
    await expect(tabs.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
    await navigation(page).getByRole('tab', { name: 'Bookmarks' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(navigation(page).getByRole('tab', { name: 'Attachments' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(navigation(page).getByRole('tab', { name: 'Attachments' })).toHaveAttribute('aria-selected', 'true');
    await expect(navigation(page).getByRole('tab', { name: 'Attachments' })).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('End');
    await expect(navigation(page).getByRole('tab', { name: 'Layers' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(navigation(page).getByRole('tab', { name: 'Bookmarks' })).toBeFocused();
  });

  test('attachments: adding one in Edit text keeps the text edits undoable', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, OUTLINED);
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    await area.fill('فقرة عدّلها الاختبار');
    await area.press('ControlOrMeta+Enter');
    await expect(first.locator('.text-layer')).toContainText('فقرة عدّلها الاختبار');
    const undo = page.locator('.pane-end').getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled();

    await openPane(page, 'Attachments');
    await navigation(page).getByTestId('attach-input').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('note') });
    await expect(navigation(page).getByRole('list', { name: 'Attachments' }).getByRole('listitem')).toHaveCount(1);
    // The attachment moved no text: the edit can still be undone.
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(first.locator('.text-layer')).not.toContainText('فقرة عدّلها الاختبار');
  });

  test('attachment rows sit the same way in Arabic as in English, mirrored', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, EVERYTHING);
    await openPane(page, 'Attachments');
    const inset = () =>
      page.evaluate(() => {
        const row = document.querySelector('.docpane-file');
        const icon = row?.querySelector('.lucide');
        if (!row || !icon) return null;
        const r = row.getBoundingClientRect();
        const i = icon.getBoundingClientRect();
        // From the row's start edge: the left in English, the right in Arabic.
        return document.documentElement.dir === 'rtl' ? r.right - i.right : i.left - r.left;
      });
    const english = await inset();
    expect(english).toBeGreaterThan(0);
    await page.getByRole('menubar').getByRole('combobox', { name: 'Language' }).selectOption({ label: 'العربية' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect.poll(inset).toBe(english);
  });
});
