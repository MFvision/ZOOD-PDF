import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fixture, fixtureBytes, openViaCard, pickTool, savedFiles, stubSavePicker, trackExternalRequests, waitForDocument } from './helpers';
import { inspectPdf, pageNo } from './pdf-inspect';

const view = (page: Page) => page.locator('[data-testid=document-view]:visible');

/** Simulates dropping `file` from the desktop at viewport point (x, y), showing the overlay first. */
async function dropFile(page: Page, file: string, x: number, y: number) {
  const b64 = fs.readFileSync(file).toString('base64');
  const dt = await page.evaluateHandle(
    ({ b64, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
      return dt;
    },
    { b64, name: path.basename(file) },
  );
  await page.dispatchEvent('.docview:not([hidden])', 'dragenter', { dataTransfer: dt, clientX: x, clientY: y });
  await page.dispatchEvent('.docview:not([hidden])', 'dragover', { dataTransfer: dt, clientX: x, clientY: y });
  await expect(page.getByTestId('drop-split')).toBeVisible();
  await page.dispatchEvent('.docview:not([hidden])', 'drop', { dataTransfer: dt, clientX: x, clientY: y });
}

test.describe('Combine', () => {
  test('from Home: pick files, reorder, combine into a new document with one bookmark per file; save and inspect', async ({ context, page }) => {
    await stubSavePicker(context);
    const external = trackExternalRequests(page);
    await page.goto('/');
    await page.locator('[data-testid=sidebar-tools] [data-tool=combine]').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('Combine Files');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), sheet.locator('[data-action=add-files]').click()]);
    await chooser.setFiles([fixture('organize-6.pdf'), fixture('sample-en.pdf')]);
    const items = sheet.getByTestId('combine-list').locator('li');
    await expect(items).toHaveCount(2);
    // reorder with the button alternative: sample-en first
    await items.nth(1).locator('[data-action=up]').click();
    await expect(items.nth(0)).toHaveAttribute('data-name', 'sample-en.pdf');
    await sheet.locator('[data-action=run-combine]').click();
    await waitForDocument(page);
    await expect(view(page).locator('.doc-name')).toHaveText('Combined.pdf');
    await expect(view(page).locator('[data-testid=doc-status]')).toHaveText('Page 1 of 8 · Edited');

    await view(page).locator('[data-testid=save]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [saved] = await savedFiles(page);
    expect(saved!.name).toBe('Combined.pdf');
    const pdf = await inspectPdf(saved!.bytes);
    expect(pdf.pageCount).toBe(8);
    expect(pdf.widths.slice(2).map(pageNo)).toEqual([1, 2, 3, 4, 5, 6]);
    // outline: one entry per file, the file's own bookmarks nested under it
    expect(pdf.outline.map((o) => [o.title, o.page])).toEqual([
      ['sample-en.pdf', 0],
      ['organize-6.pdf', 2],
    ]);
    expect(pdf.outline[1]!.children.map((o) => [o.title, o.page])).toEqual([
      ['Chapter One', 2],
      ['Chapter Two', 4],
      ['Chapter Three', 6],
    ]);
    expect(external).toEqual([]);
  });

  test('Arabic: dropping a PDF on an open document offers «دمج مع …» / «فتح بدلاً منه»; combine appends as an incremental update', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ar' });
    await stubSavePicker(context);
    const page = await context.newPage();
    await page.goto('/');
    await openViaCard(page, fixture('organize-6.pdf'));
    const vw = page.viewportSize()!;
    // RTL: the start half (combine) is on the right
    await dropFile(page, fixture('sample-ar.pdf'), vw.width * 0.75, vw.height / 2);
    const overlay = page.getByTestId('drop-split');
    await expect(overlay).toHaveCount(0);
    await expect(view(page).locator('[data-testid=doc-status]')).toHaveText('صفحة ١ من ٨ · معدَّل', { timeout: 30_000 });
    await expect(page.locator('.hud')).toContainText('أُضيفت صفحتان');

    await view(page).locator('[data-testid=save]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [saved] = await savedFiles(page);
    const original = fixtureBytes('organize-6.pdf');
    expect(saved!.bytes.subarray(0, original.length).equals(original)).toBe(true);
    const pdf = await inspectPdf(saved!.bytes);
    expect(pdf.pageCount).toBe(8);
    expect(pdf.outline.map((o) => o.title)).toEqual(['Chapter One', 'Chapter Two', 'Chapter Three', 'sample-ar.pdf']);
    expect(pdf.outline[3]!.page).toBe(6);
    await context.close();
  });

  test('the other half opens the dropped file as its own document; the overlay names the open file', async ({ page }) => {
    await page.goto('/');
    await openViaCard(page, fixture('organize-6.pdf'));
    const vw = page.viewportSize()!;
    const b64 = fixtureBytes('sample-en.pdf').toString('base64');
    const dt = await page.evaluateHandle((b64) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'sample-en.pdf', { type: 'application/pdf' }));
      return dt;
    }, b64);
    await page.dispatchEvent('.docview:not([hidden])', 'dragenter', { dataTransfer: dt, clientX: vw.width * 0.8, clientY: 300 });
    await page.dispatchEvent('.docview:not([hidden])', 'dragover', { dataTransfer: dt, clientX: vw.width * 0.8, clientY: 300 });
    const overlay = page.getByTestId('drop-split');
    await expect(overlay.locator('[data-drop=combine]')).toContainText('Combine with organize-6.pdf');
    await expect(overlay.locator('[data-drop=open]')).toContainText('Open instead');
    await expect(overlay.locator('[data-drop=open]')).toHaveClass(/hot/);
    await page.dispatchEvent('.docview:not([hidden])', 'drop', { dataTransfer: dt, clientX: vw.width * 0.8, clientY: 300 });
    await waitForDocument(page);
    await expect(view(page).locator('.doc-name')).toHaveText('sample-en.pdf');
    await expect(view(page).locator('[data-testid=doc-status]')).toHaveText('Page 1 of 2');
  });

  test('from the document tool picker: insert files after a chosen page', async ({ context, page }) => {
    await stubSavePicker(context);
    await page.goto('/');
    await openViaCard(page, fixture('organize-6.pdf'));
    await pickTool(page, 'combine');
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('Add files to “organize-6.pdf”');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), sheet.locator('[data-action=add-files]').click()]);
    await chooser.setFiles(fixture('sample-en.pdf'));
    await sheet.locator('[data-position=after]').click();
    await sheet.locator('input[name=after]').fill('2');
    await sheet.locator('[data-action=run-combine]').click();
    await expect(view(page).locator('[data-testid=doc-status]')).toHaveText('Page 1 of 8 · Edited', { timeout: 30_000 });
    await view(page).locator('[data-testid=save]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [saved] = await savedFiles(page);
    expect(saved!.bytes.subarray(0, fixtureBytes('organize-6.pdf').length).equals(fixtureBytes('organize-6.pdf'))).toBe(true);
    const pdf = await inspectPdf(saved!.bytes);
    expect(pdf.widths).toEqual([400, 420, 596, 596, 440, 460, 480, 500]);
  });
});
