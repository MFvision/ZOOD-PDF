import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, embedTiles, openPdf, test } from './helpers';
import { readable, spellings } from './pdfBytes';

/** One of every kind of hidden information, each with a string of its own (tests/fixtures/hidden/make.py). */
const EVERYTHING = fileURLToPath(new URL('../../../tests/fixtures/hidden/everything.pdf', import.meta.url));

const MARKERS = [
  'INFO-TITLE-SECRET',
  'INFO-AUTHOR-SECRET',
  'XMP-SECRET',
  'DOCJS-SECRET',
  'OPENACTION-SECRET',
  'PAGE-AA-SECRET',
  'ATTACH-DOC-SECRET',
  'ATTACH-ANNOT-SECRET',
  'COMMENT-SECRET',
  'ANNOT-WRITER-SECRET',
  'FIELDNAME-SECRET',
  'FIELDVALUE-SECRET',
  'XFA-SECRET',
  'LAYER-OFF-SECRET',
  'LAYERNAME-OFF-SECRET',
  'BOOKMARK-SECRET',
  'THUMB-SECRET',
  'PIECEINFO-SECRET',
  'PAGEPIECE-SECRET',
  'link-secret.example',
  'bookmark-uri-secret.example',
  'WHITE-TEXT-SECRET',
  'INVISIBLE-TEXT-SECRET',
  'OFFPAGE-TEXT-SECRET',
  'OLD-REVISION-SECRET',
  'ORPHAN-SECRET',
];

const panel = (page: Page) => page.locator('.pane-end');
const found = (raw: string, text: string) => spellings(text).some((spelling) => raw.includes(spelling));

test.describe('Redact: remove hidden information', () => {
  test('every kind is reported, removed, and gone from the saved file; the page stays', async ({ page, stayLocal: _ }) => {
    const before = readable(readFileSync(EVERYTHING));
    for (const marker of MARKERS) expect(found(before, marker), marker).toBe(true);

    await page.goto('/');
    await openPdf(page, EVERYTHING);
    await chooseTool(page, 'Redact');
    await panel(page).getByRole('button', { name: 'Check the file' }).click();
    const report = panel(page).getByRole('group', { name: 'The file carries' });
    for (const kind of [
      'Document properties and metadata',
      'Scripts and actions',
      'Attached files',
      'Comments and markup',
      'Form fields and their data',
      'Hidden layers and what they draw',
      'Bookmarks',
      'Page thumbnails',
      "Applications' private data",
      'Links and web addresses',
      'Hidden text',
    ]) {
      await expect(report.getByLabel(kind, { exact: false }), kind).toBeVisible();
    }
    await expect(report).toContainText('LAYERNAME-OFF-SECRET');
    await expect(report).toContainText('doc-secret.txt');
    await expect(report).toContainText('1 in white');
    // The file as it stands: its own revision, and the update the viewer's
    // save adds, at the least; and the orphan.
    await expect(panel(page)).toContainText(/earlier versions \(\d+\) and objects nothing uses \(1\)/);
    // Hidden text is a choice (a scan's OCR layer is hidden text): not chosen at first.
    const hiddenText = report.getByLabel('Hidden text', { exact: false });
    await expect(hiddenText).not.toBeChecked();
    await expect(report.getByLabel('Scripts and actions', { exact: false })).toBeChecked();
    await hiddenText.check();

    await panel(page).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(panel(page).getByText('Removed. The file was written anew')).toBeVisible();
    await expect(panel(page).getByText('Nothing hidden was found.')).toBeVisible();
    // The new file is on screen.
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
    ]);
    const path = 'test-results/hidden-removed.pdf';
    await download.saveAs(path);
    const bytes = readFileSync(path);
    const raw = readable(bytes);
    for (const marker of MARKERS) expect(found(raw, marker), `${marker} is still in the saved file`).toBe(false);
    // One revision, and the page as it looked: its text and the field's look.
    expect(bytes.toString('latin1').match(/%%EOF/g)?.length).toBe(1);
    for (const kept of ['VISIBLE-TEXT-KEPT', 'LAYER-ON-TEXT', 'FIELD-SHOWN']) expect(found(raw, kept), kept).toBe(true);

    await page.goto('/');
    await openPdf(page, path);
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
  });

  test('nothing is removed while redaction marks wait to be applied', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, EVERYTHING);
    await chooseTool(page, 'Redact');
    await panel(page).getByLabel('Words to find').fill('Visible again');
    await panel(page).getByRole('button', { name: 'Find', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Mark selected (1)' }).click();
    await panel(page).getByRole('button', { name: 'Check the file' }).click();
    await expect(panel(page).getByText('Apply or clear the redaction marks first.')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
  });
});
