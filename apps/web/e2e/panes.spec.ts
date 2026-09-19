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
    await tree.getByRole('button', { name: 'الفصل الثالث: الخصوصية والمزامنة', exact: true }).click();
    await expect.poll(() => embedPage(page)).toBe(3);
    // Closing an entry hides what is under it.
    await tree.getByRole('button', { name: 'Hide what is under الفصل الأول: لماذا وراق؟' }).click();
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
    const tree = navigation(page).getByRole('tree', { name: 'Layers' });
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
});
