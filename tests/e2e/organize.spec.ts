import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fixture, fixtureBytes, openViaCard, pickTool, savedFiles, stubSavePicker, trackExternalRequests } from './helpers';
import { inspectPdf, pageNo, unzip } from './pdf-inspect';

const view = (page: Page) => page.locator('[data-testid=document-view]:visible');
const organize = (page: Page) => view(page).locator('[data-testid=organize]');
const cards = (page: Page) => organize(page).locator('[role=option]');
const card = (page: Page, n: number) => organize(page).locator(`[role=option][data-index="${n - 1}"]`);
const action = (page: Page, id: string) => organize(page).locator(`.org-bar [data-action="${id}"]`);

async function idle(page: Page) {
  await expect(organize(page).locator('[role=listbox]')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  await expect(view(page).locator('[data-testid=doc-status]')).toHaveText(/(Page|صفحة) \S+ (of|من) \S+/);
}

/** Runs `act` and waits until the document was replaced (one more revision) and has reloaded. */
async function op(page: Page, act: () => Promise<unknown>) {
  const before = Number(await organize(page).getAttribute('data-revision'));
  await act();
  await expect.poll(async () => Number(await organize(page).getAttribute('data-revision')), { timeout: 30_000 }).toBeGreaterThan(before);
  await idle(page);
}

async function openOrganize(page: Page, file: string, pages: number) {
  await openViaCard(page, fixture(file));
  await pickTool(page, 'organize');
  await expect(organize(page)).toBeVisible();
  await expect(cards(page)).toHaveCount(pages);
  await idle(page);
}

async function saveNow(page: Page) {
  const before = (await savedFiles(page)).length;
  await view(page).locator('[data-testid=save]').click();
  await expect.poll(async () => (await savedFiles(page)).length).toBe(before + 1);
  return (await savedFiles(page))[before]!;
}

test.describe('Organize', () => {
  test('rotate, drag to reorder, delete from the context menu, add a page, move with the keyboard, undo/redo, save incrementally', async ({ context, page }) => {
    await stubSavePicker(context);
    const external = trackExternalRequests(page);
    await page.goto('/');
    await openOrganize(page, 'organize-6.pdf', 6);

    // rotate page 2 with the organize menu
    await card(page, 2).click();
    await expect(page.getByTestId('organize-selection')).toHaveText('1 page selected');
    await op(page, () => action(page, 'rotate-right').click());
    await expect(view(page).locator('[data-testid=doc-status]')).toContainText('Edited');

    // drag page 6 before page 1
    const first = await card(page, 1).boundingBox();
    await op(page, () => card(page, 6).dragTo(card(page, 1), { targetPosition: { x: 8, y: first!.height / 2 } }));

    // delete page 4 (the original page 3) from its context menu (right-click)
    await card(page, 4).click({ button: 'right' });
    const menu = page.getByTestId('page-menu');
    await expect(menu).toBeVisible();
    await op(page, () => menu.locator('[data-action=delete]').click());
    await expect(cards(page)).toHaveCount(5);

    // add a blank page after page 2 (size of its neighbour)
    await card(page, 2).click();
    await op(page, () => action(page, 'add-page').click());
    await expect(cards(page)).toHaveCount(6);

    // keyboard alternative to dragging: Alt+→ moves the selected page one place later
    await card(page, 1).click();
    await op(page, () => card(page, 1).press('Alt+ArrowRight'));
    await expect(card(page, 2)).toHaveAttribute('aria-selected', 'true');

    // undo, then redo, the keyboard move
    await op(page, () => organize(page).locator('[data-action=undo]').click());
    await expect(cards(page)).toHaveCount(6);
    await op(page, () => organize(page).locator('[data-action=redo]').click());

    const saved = await saveNow(page);
    const original = fixtureBytes('organize-6.pdf');
    expect(saved.bytes.subarray(0, original.length).equals(original)).toBe(true);
    const pdf = await inspectPdf(saved.bytes);
    expect(pdf.pageCount).toBe(6);
    // [1, 6, blank(=size of 1), 2, 4, 5]
    expect(pdf.widths).toEqual([400, 500, 400, 420, 460, 480]);
    expect(pdf.pages.map((p) => p.rotate)).toEqual([0, 0, 0, 90, 0, 0]);
    expect(pdf.revisions).toBe(6); // original + rotate, move, delete, insert, move
    expect(external).toEqual([]);

    // reopen the saved bytes: the viewer shows six pages
    await page.getByRole('button', { name: 'Home' }).first().click();
    const reopened = test.info().outputPath('organized.pdf');
    fs.writeFileSync(reopened, saved.bytes);
    await openViaCard(page, reopened);
    await expect(view(page).locator('[data-testid=doc-status]')).toHaveText('Page 1 of 6');
  });

  test('Arabic: RTL grid; insert from file and pictures, replace, crop by margins and trim — saved and inspected', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ar' });
    await stubSavePicker(context);
    const page = await context.newPage();
    await page.goto('/');
    await openOrganize(page, 'organize-6.pdf', 6);
    await expect(action(page, 'rotate-right')).toContainText('تدوير لليمين');
    await expect(page.getByTestId('organize-selection')).toHaveText('صفحة واحدة محددة');
    // RTL: page 1 sits to the right of page 2
    const b1 = await card(page, 1).boundingBox();
    const b2 = await card(page, 2).boundingBox();
    expect(b1!.x).toBeGreaterThan(b2!.x);

    // insert a PDF after page 6 through the ⋯ menu of that page
    await card(page, 6).hover();
    await card(page, 6).getByTestId('page-more').click();
    const [pdfChooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('page-menu').locator('[data-action=insert-file]').click()]);
    await op(page, () => pdfChooser.setFiles(fixture('sample-ar.pdf')));
    await expect(cards(page)).toHaveCount(8);
    await expect(page.locator('.hud')).toContainText('أُضيفت صفحتان');

    // insert two pictures (JPEG passthrough + PNG with transparency) after the selection (page 7–8)
    await expect(card(page, 7)).toHaveAttribute('aria-selected', 'true');
    const [picChooser] = await Promise.all([page.waitForEvent('filechooser'), action(page, 'insert-picture').click()]);
    await op(page, () => picChooser.setFiles([fixture('photo.jpg'), fixture('logo.png')]));
    await expect(cards(page)).toHaveCount(10);

    // replace page 1 with the first page of sample-en.pdf
    await card(page, 1).click();
    const [repChooser] = await Promise.all([page.waitForEvent('filechooser'), action(page, 'replace').click()]);
    await op(page, () => repChooser.setFiles(fixture('sample-en.pdf')));

    // crop page 2 by typing margins (points)
    await card(page, 2).click();
    await action(page, 'crop').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('قص الصفحات');
    await sheet.locator('input[name=top]').fill('50');
    await sheet.locator('input[name=left]').fill('40');
    await op(page, () => sheet.locator('[data-action=apply-crop]').click());

    // trim the margins of page 3 to its content
    await card(page, 3).click();
    await op(page, () => action(page, 'trim').click());
    await expect(page.locator('.hud').last()).toContainText('قُلِّمت صفحة واحدة');

    await view(page).locator('[data-testid=save]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [saved] = await savedFiles(page);
    const original = fixtureBytes('organize-6.pdf');
    expect(saved!.bytes.subarray(0, original.length).equals(original)).toBe(true);
    const pdf = await inspectPdf(saved!.bytes);
    expect(pdf.pageCount).toBe(10);
    // replaced page 1 is A4 (sample-en); pictures take the size of their neighbour (sample-ar, A4)
    expect(pdf.widths).toEqual([596, 420, 440, 460, 480, 500, 596, 596, 596, 596]);
    expect(pdf.pages[1]!.cropBox).toEqual([40, 0, 420, 550]);
    const trimmed = pdf.pages[2]!.cropBox!;
    expect(trimmed[0]).toBeGreaterThan(20);
    expect(trimmed[2]).toBeLessThan(440);
    expect(trimmed[3]).toBeLessThan(600);
    // the inserted file brought its pages; the JPEG is embedded unchanged (DCTDecode passthrough)
    const jpeg = fixtureBytes('photo.jpg');
    expect(saved!.bytes.indexOf(jpeg)).toBeGreaterThan(original.length);
    await context.close();
  });

  test('extract pages to a new file and split by ranges (Arabic-Indic digits) and by bookmarks into ZIPs', async ({ context, page }) => {
    await stubSavePicker(context);
    await page.goto('/');
    await openOrganize(page, 'organize-6.pdf', 6);

    // multi-select pages 2–3 (click + shift-click) and extract them
    await card(page, 2).click();
    await card(page, 3).click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('organize-selection')).toHaveText('2 pages selected');
    await action(page, 'extract').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    let files = await savedFiles(page);
    expect(files[0]!.name).toBe('organize-6 (pages 2-3).pdf');
    expect((await inspectPdf(files[0]!.bytes)).widths).toEqual([420, 440]);
    // extracting does not change the document
    await expect(view(page).locator('[data-testid=doc-status]')).not.toContainText('Edited');

    // split by typed ranges
    await action(page, 'split').click();
    const sheet = page.getByRole('dialog');
    await sheet.locator('[data-mode=ranges]').click();
    await sheet.locator('input[name=ranges]').fill('٢-١');
    await expect(sheet.getByRole('alert')).toContainText('runs backwards');
    await sheet.locator('input[name=ranges]').fill('١-٢، ٥');
    await expect(page.getByTestId('split-summary')).toContainText('2 files');
    await sheet.locator('[data-action=run-split]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(2);
    files = await savedFiles(page);
    expect(files[1]!.name).toBe('organize-6 (split).zip');
    let parts = unzip(files[1]!.bytes);
    expect(parts.map((p) => p.name)).toEqual(['organize-6 part 1.pdf', 'organize-6 part 2.pdf']);
    expect((await inspectPdf(parts[0]!.bytes)).widths.map(pageNo)).toEqual([1, 2]);
    expect((await inspectPdf(parts[1]!.bytes)).widths.map(pageNo)).toEqual([5]);

    // split by top-level bookmarks: one file per chapter, named after it, with its bookmark
    await action(page, 'split').click();
    await sheet.locator('[data-mode=bookmarks]').click();
    await sheet.locator('[data-action=run-split]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(3);
    parts = unzip((await savedFiles(page))[2]!.bytes);
    expect(parts.map((p) => p.name)).toEqual(['Chapter One.pdf', 'Chapter Two.pdf', 'Chapter Three.pdf']);
    const two = await inspectPdf(parts[1]!.bytes);
    expect(two.widths.map(pageNo)).toEqual([3, 4]);
    expect(two.outline[0]!.title).toBe('Chapter Two');
  });

  test('crop by drawing the area to keep on the page preview', async ({ context, page }) => {
    await stubSavePicker(context);
    await page.goto('/');
    await openOrganize(page, 'organize-6.pdf', 6);
    await card(page, 1).click();
    await action(page, 'crop').click();
    const preview = page.getByTestId('crop-preview').locator('img');
    await expect(preview).toBeVisible();
    // the sheet opens with a scale animation: wait until the preview stops moving
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    let box = (await preview.boundingBox())!;
    await expect
      .poll(async () => {
        const b = (await preview.boundingBox())!;
        const same = b.x === box.x && b.y === box.y && b.width === box.width && b.height === box.height;
        box = b;
        return same;
      })
      .toBe(true);
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 });
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.8, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByRole('dialog').locator('input[name=left]')).not.toHaveValue('0');
    await op(page, () => page.getByRole('dialog').locator('[data-action=apply-crop]').click());
    const saved = await saveNow(page);
    const crop = (await inspectPdf(saved.bytes)).pages[0]!.cropBox!;
    // page 1 is 400×600 pt: kept area ≈ x 40–360, y (from the bottom) 120–540
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(6);
    near(crop[0], 40);
    near(crop[1], 120);
    near(crop[2], 360);
    near(crop[3], 540);
  });

  test('phone width: the grid fits, the menu scrolls inside its bar, the ⋯ menu works', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await stubSavePicker(context);
    const page = await context.newPage();
    await page.goto('/');
    await openOrganize(page, 'organize-6.pdf', 6);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // at least two pages per row
    const a = (await card(page, 1).boundingBox())!;
    const b = (await card(page, 2).boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(a.x + a.width).toBeLessThanOrEqual(390);
    await card(page, 3).getByTestId('page-more').click();
    const menu = page.getByTestId('page-menu');
    await expect(menu).toBeVisible();
    const m = (await menu.boundingBox())!;
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x + m.width).toBeLessThanOrEqual(390);
    await op(page, () => menu.locator('[data-action=rotate-left]').click());
    const saved = await saveNow(page);
    expect((await inspectPdf(saved.bytes)).pages[2]!.rotate).toBe(270);
    await context.close();
  });
});
