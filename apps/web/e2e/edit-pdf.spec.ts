import { readFileSync, writeFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { corpus, enterEditText, ink, openPdf, pageBox, test } from './helpers';

const THREE = corpus('generated/chrome-notonaskh-justified-3pages.pdf');
const SCAN = corpus('generated/scan-arial-200dpi-bilevel.pdf');
const panel = (page: Page) => page.locator('.pane-end');

/** A 16×16 red PNG, and an 8×4 blue one. */
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGN4JiJCEmIY1TCqYfhqAABdUg4Qd2gTGgAAAABJRU5ErkJggg==';
const BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGMQ0biDFTFQTwIAvb4jAYiYMMcAAAAASUVORK5CYII=';

type Core = {
  default(options: { module_or_path: Buffer }): Promise<unknown>;
  call_static(op: string, args: string, blobs: Uint8Array[]): { json: string; free(): void };
  Document: { open(bytes: Uint8Array): { call(op: string, args: string, blobs: Uint8Array[]): { free(): void }; save(): Uint8Array; free(): void } };
};
let loaded: Core | null = null;

/** Warraq's own core, the same WASM the app runs, here in Node. */
async function core(): Promise<Core> {
  if (loaded) return loaded;
  const root = new URL('../../../packages/ui/src/core-wasm/', import.meta.url);
  const module = (await import(new URL('warraq_core.js', root).href)) as Core;
  await module.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', root)) });
  loaded = module;
  return loaded;
}

async function inspect<T>(op: string, file: string, page = 0): Promise<T> {
  const reply = (await core()).call_static(op, JSON.stringify({ page }), [new Uint8Array(readFileSync(file))]);
  try {
    return JSON.parse(reply.json) as T;
  } finally {
    reply.free();
  }
}

type Image = { id: string; matrix: number[]; clip: number[]; pixels: [number, number] };
type Link = { id: string; rect: number[]; to: { uri?: string; page?: number } };

async function saveAs(page: Page, name: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const path = `test-results/${name}-${download.suggestedFilename()}`;
  await download.saveAs(path);
  return path;
}

/** Points on the page as shown → the screen, for page 1 of Warraq's view. */
async function screenOf(section: Locator, pageWidthPt: number) {
  const box = (await section.boundingBox())!;
  const scale = box.width / pageWidthPt;
  return { box, scale, at: (x: number, y: number) => ({ x: box.x + x * scale, y: box.y + y * scale }) };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, shift = false) {
  await page.mouse.move(from.x, from.y);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

/** Waits until `box` covers x0–x1, y0–y1 points on the page: the core has made the change and the page is drawn again. */
async function expectAt(box: Locator, at: (x: number, y: number) => { x: number; y: number }, [x0, y0, x1, y1]: number[]) {
  const a = at(x0!, y0!);
  const b = at(x1!, y1!);
  await expect
    .poll(async () => {
      const r = await box.boundingBox();
      return r ? Math.max(Math.abs(r.x - a.x), Math.abs(r.y - a.y), Math.abs(r.x + r.width - b.x), Math.abs(r.y + r.height - b.y)) : 999;
    })
    .toBeLessThan(3);
}

const close = (a: number[], b: number[], within = 1.5) => b.forEach((v, k) => expect(Math.abs(a[k]! - v), `${a} vs ${b}`).toBeLessThan(within));

test.describe('Edit PDF: pictures and links, like a drawing program, saved into the file', () => {
  test.setTimeout(180_000);

  test('a picture is placed, moved, resized, turned, cropped and replaced; the saved file has it there', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, THREE);
    const first = await enterEditText(page);
    const p = panel(page);
    await p.getByRole('radio', { name: 'Pictures' }).click();
    await p.getByLabel('Add a picture…').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(RED_PNG, 'base64') });
    await expect(p.getByRole('status')).toContainText('red.png');

    // Dragged out on page 1, from (100, 100) to (220, 180) points: a square picture fits 80 × 80.
    const { at } = await screenOf(first, 595.28);
    const before = await ink(first.locator('canvas.page-canvas'));
    await drag(page, at(100, 100), at(220, 180));
    const pictures = first.locator('.edit-pdf-image');
    await expect(pictures).toHaveCount(1);
    await expect.poll(() => ink(first.locator('canvas.page-canvas'))).not.toBe(before);
    await expect(p.getByText('Picture 1 on page 1: 16 × 16 pixels')).toBeVisible();
    await expectAt(pictures.first(), at, [120, 100, 200, 180]);

    // Moved 50 points right and 40 down, by dragging it.
    await drag(page, at(160, 140), at(210, 180));
    await expectAt(pictures.first(), at, [170, 140, 250, 220]);
    // Resized from its bottom-right corner, Shift keeping it square: 120 points wide.
    await expect(first.locator('.edit-pdf-handle')).toHaveCount(8);
    await drag(page, at(250, 220), at(290, 250), true);
    await expectAt(pictures.first(), at, [170, 140, 290, 260]);
    // Turned a quarter about its centre.
    await p.getByRole('button', { name: 'Turn 90°' }).click();
    await expect(p.getByRole('button', { name: 'Turn 90°' })).toBeEnabled();
    await p.getByRole('button', { name: 'Crop' }).click();
    const saved = await saveAs(page, 'edit-pdf-picture');
    let [image] = (await inspect<{ images: Image[] }>('images.list', saved)).images;
    expect(image!.pixels).toEqual([16, 16]);
    // A square turned about its centre covers the same box: x 170–290, y 140–260.
    const corners = [
      [image!.matrix[4]!, image!.matrix[5]!],
      [image!.matrix[0]! + image!.matrix[2]! + image!.matrix[4]!, image!.matrix[1]! + image!.matrix[3]! + image!.matrix[5]!],
    ];
    const xs = corners.map((c) => c[0]!).sort((a, b) => a - b);
    const ys = corners.map((c) => c[1]!).sort((a, b) => a - b);
    close([xs[0]!, ys[0]!, xs[1]!, ys[1]!], [170, 140, 290, 260], 3);
    // Turned: the unit square's x axis now runs down the page.
    expect(Math.abs(image!.matrix[0]!)).toBeLessThan(0.5);

    // Crop: the handle on one side dragged to the middle.
    const handles = first.locator('.edit-pdf-crop-handle');
    await expect(handles).toHaveCount(8);
    const handle = (await handles.nth(7).boundingBox())!;
    await drag(page, { x: handle.x + 5, y: handle.y + 5 }, at(210, 200));
    await expect(p.getByRole('button', { name: 'Crop' })).toBeEnabled();
    const cropped = await saveAs(page, 'edit-pdf-cropped');
    [image] = (await inspect<{ images: Image[] }>('images.list', cropped)).images;
    close(image!.clip, [0.5, 0, 1, 1], 0.03);

    // Replaced by an 8 × 4 blue picture, fitted inside what showed.
    await p.getByLabel('Replace…').setInputFiles({ name: 'blue.png', mimeType: 'image/png', buffer: Buffer.from(BLUE_PNG, 'base64') });
    await expect(p.getByText('Picture 1 on page 1: 8 × 4 pixels')).toBeVisible();
    const replaced = await saveAs(page, 'edit-pdf-replaced');
    [image] = (await inspect<{ images: Image[] }>('images.list', replaced)).images;
    expect(image!.pixels).toEqual([8, 4]);
    expect(image!.clip).toEqual([0, 0, 1, 1]);
    // The page's text is untouched by any of it.
    const text = (file: string) => inspect<{ page: string }>('marks.text', file);
    expect((await text(replaced)).page).toBe((await text(THREE)).page);
  });

  test("a scan's own picture is found and deleted", async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, SCAN);
    const first = await enterEditText(page);
    const p = panel(page);
    await p.getByRole('radio', { name: 'Pictures' }).click();
    const picture = first.locator('.edit-pdf-image');
    await expect(picture).toHaveCount(1);
    await picture.click();
    await expect(p.getByText(/Picture 1 on page 1: \d+ × \d+ pixels/)).toBeVisible();
    const before = await ink(first.locator('canvas.page-canvas'));
    await p.getByRole('button', { name: 'Delete' }).click();
    await expect(picture).toHaveCount(0);
    await expect.poll(() => ink(first.locator('canvas.page-canvas'))).toBeLessThan(before);
    const saved = await saveAs(page, 'edit-pdf-deleted');
    expect((await inspect<{ images: Image[] }>('images.list', saved)).images).toEqual([]);
    expect((await inspect<{ images: Image[] }>('images.list', SCAN)).images).toHaveLength(1);
  });

  test('links to an address and to a page are drawn, saved, and an address asks before it opens — in both views', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, THREE);
    const first = await enterEditText(page);
    const p = panel(page);
    await p.getByRole('radio', { name: 'Links' }).click();
    const { at } = await screenOf(first, 595.28);

    // Drawn, then given an Arabic address.
    await drag(page, at(100, 100), at(400, 160));
    await expect(p.getByRole('group', { name: 'New link' })).toBeVisible();
    await p.getByRole('textbox', { name: 'Address' }).fill('https://example.org/دليل');
    await p.getByRole('button', { name: 'Add the link' }).click();
    await expect(first.locator('.edit-pdf-link')).toHaveCount(1);

    // A second, to page 3.
    await drag(page, at(100, 300), at(300, 340));
    await p.getByRole('radio', { name: 'A page of this file' }).check();
    await p.getByLabel('Page (1–3)').fill('3');
    await p.getByRole('button', { name: 'Add the link' }).click();
    await expect(first.locator('.edit-pdf-link')).toHaveCount(2);

    // Picked, its address reads in letters, as it was typed.
    await first.locator('.edit-pdf-link').first().click();
    await expect(p.getByRole('textbox', { name: 'Address' })).toHaveValue('https://example.org/دليل');
    // Following the address asks first, shows it whole — and the site it
    // really opens — and opens nothing on Cancel.
    await p.getByRole('button', { name: 'Open the address…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Open this link?' });
    await expect(dialog.locator('.link-address')).toHaveText('https://example.org/دليل');
    await expect(dialog.locator('.link-host')).toContainText('example.org');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // Moved by its body.
    await drag(page, at(250, 130), at(250, 180));
    await expectAt(first.locator('.edit-pdf-link').first(), at, [100, 150, 400, 210]);

    const saved = await saveAs(page, 'edit-pdf-links');
    const links = (await inspect<{ links: Link[] }>('links.list', saved)).links;
    expect(links).toHaveLength(2);
    expect(links[0]!.to.uri).toBe('https://example.org/%D8%AF%D9%84%D9%8A%D9%84');
    close(links[0]!.rect, [100, 150, 300, 60], 2);
    expect(links[1]!.to.page).toBe(2);
    close(links[1]!.rect, [100, 300, 200, 40], 2);

    // In EmbedPDF's view, the same file: Go to Link on the address asks too.
    await page.goto('/');
    await openPdf(page, saved);
    const box = await pageBox(page);
    const scale = box.width / 595.28;
    await page.mouse.click(box.x + 250 * scale, box.y + 180 * scale);
    await page.locator('embedpdf-container').getByRole('button', { name: 'Go to Link' }).click();
    await expect(page.getByRole('dialog', { name: 'Open this link?' }).locator('.link-address')).toHaveText('https://example.org/دليل');
    await page.getByRole('dialog', { name: 'Open this link?' }).getByRole('button', { name: 'Cancel' }).click();
  });

  test('a link is added from the panel, moved and resized from the keyboard and by a handle, re-pointed and removed', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, THREE);
    const first = await enterEditText(page);
    const p = panel(page);
    await p.getByRole('radio', { name: 'Links' }).click();
    const { at } = await screenOf(first, 595.28);
    const links = first.locator('.edit-pdf-link');

    // No pointer needed: an area in the middle of the page, then where it goes.
    await p.getByRole('button', { name: 'Add a link on this page' }).click();
    await p.getByRole('textbox', { name: 'Address' }).fill('https://example.org/a');
    await p.getByRole('button', { name: 'Add the link' }).click();
    await expect(links).toHaveCount(1);
    // 200 × 24 points in the middle of A4.
    const [x0, y0] = [(595.28 - 200) / 2, (841.89 - 24) / 2];
    await expectAt(links.first(), at, [x0, y0, x0 + 200, y0 + 24]);

    // The arrows move it (the box keeps the focus between presses); with Alt they resize it.
    await links.first().focus();
    for (const key of ['ArrowRight', 'ArrowRight', 'Shift+ArrowDown', 'Shift+Alt+ArrowRight']) {
      await expect(links.first()).not.toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press(key);
      await expect(links.first()).toBeFocused();
    }
    await expectAt(links.first(), at, [x0 + 2, y0 + 10, x0 + 212, y0 + 34]);

    // A handle drags its corner: 40 points more each way.
    const handle = (await first.locator('.edit-pdf-link-handle').nth(4).boundingBox())!;
    await drag(page, { x: handle.x + 5, y: handle.y + 5 }, at(x0 + 252, y0 + 74));
    await expectAt(links.first(), at, [x0 + 2, y0 + 10, x0 + 252, y0 + 74]);

    // Pointed at page 2 instead.
    await p.getByRole('radio', { name: 'A page of this file' }).check();
    await p.getByLabel('Page (1–3)').fill('2');
    await p.getByRole('button', { name: 'Save where it goes' }).click();
    await expect(links.first()).toHaveAttribute('aria-label', 'Link 1 to page 2');
    const saved = await saveAs(page, 'edit-pdf-link-moved');
    const [link] = (await inspect<{ links: Link[] }>('links.list', saved)).links;
    expect(link!.to).toEqual({ page: 1 });
    close(link!.rect, [x0 + 2, y0 + 10, 250, 64], 2);

    // And taken off.
    await links.first().click();
    await p.getByRole('button', { name: 'Remove the link' }).click();
    await expect(links).toHaveCount(0);
    const removed = await saveAs(page, 'edit-pdf-link-removed');
    expect((await inspect<{ links: Link[] }>('links.list', removed)).links).toEqual([]);
  });

  test('picture changes are undone in their turn with text edits, the arrows nudge the picked picture, and Edit text opens text again', async ({ page, stayLocal: _ }) => {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.goto('/');
    await openPdf(page, THREE);
    const first = await enterEditText(page);
    const p = panel(page);

    // A text edit first.
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    const replacement = 'فقرة عدّلها الاختبار';
    await area.fill(replacement);
    await area.press(`${mod}+Enter`);
    await expect(first.locator('.text-layer')).toContainText(replacement);

    // Then a picture.
    await p.getByRole('radio', { name: 'Pictures' }).click();
    await p.getByLabel('Add a picture…').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(RED_PNG, 'base64') });
    const { at } = await screenOf(first, 595.28);
    await drag(page, at(100, 100), at(220, 180));
    const pictures = first.locator('.edit-pdf-image');
    await expect(pictures).toHaveCount(1);

    // Undo takes back the picture — not the text before it; Redo puts it back.
    await pictures.first().focus();
    await page.keyboard.press(`${mod}+z`);
    await expect(pictures).toHaveCount(0);
    await expect(first.locator('.text-layer')).toContainText(replacement);
    await page.keyboard.press(`${mod}+Shift+z`);
    await expect(pictures).toHaveCount(1);
    await expect(first.locator('.text-layer')).toContainText(replacement);

    // Picked, the arrows nudge it a point at a time, and the box keeps the focus.
    const placed = await saveAs(page, 'edit-pdf-placed');
    const [before] = (await inspect<{ images: Image[] }>('images.list', placed)).images;
    await pictures.first().click();
    await expect(pictures.first()).toHaveAttribute('aria-pressed', 'true');
    for (let k = 0; k < 2; k += 1) {
      await expect(pictures.first()).not.toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('ArrowRight');
      await expect(pictures.first()).toBeFocused();
    }
    await expect(pictures.first()).not.toHaveAttribute('aria-disabled', 'true');
    const nudged = await saveAs(page, 'edit-pdf-nudged');
    const [image] = (await inspect<{ images: Image[] }>('images.list', nudged)).images;
    close(image!.matrix, [...before!.matrix.slice(0, 4), before!.matrix[4]! + 2, before!.matrix[5]!], 0.05);

    // Undo again: the nudges, then the picture, then the text — in that order.
    for (let k = 0; k < 3; k += 1) {
      await expect(page.getByRole('toolbar').getByRole('button', { name: 'Undo' })).toBeEnabled();
      await page.getByRole('toolbar').getByRole('button', { name: 'Undo' }).click();
    }
    await expect(pictures).toHaveCount(0);
    await expect(first.locator('.text-layer')).toContainText(replacement);
    await page.getByRole('toolbar').getByRole('button', { name: 'Undo' }).click();
    await expect(first.locator('.text-layer')).not.toContainText(replacement);

    // Edit text turned off and on from the toolbar opens text editing, not
    // the picture layer — and no picture control is left meanwhile.
    const toggle = page.getByRole('toolbar').getByRole('button', { name: 'Edit text' });
    await toggle.click();
    await expect(p.getByRole('button', { name: 'Add a picture…' })).toHaveCount(0);
    await expect(p.getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(page.locator('section[data-page="1"] .edit-box').first()).toBeVisible();
    await expect(page.locator('.edit-pdf-image')).toHaveCount(0);
  });

  test('a link whose address is disguised with a bidi control is refused, and shown escaped', async ({ page, stayLocal: _ }) => {
    const hostile = 'test-results/edit-pdf-bidi.pdf';
    const placeholder = 'https://placeholder.example/aaaaaaaaaa';
    const c = await core();
    const doc = c.Document.open(new Uint8Array(readFileSync(THREE)));
    doc.call('links.add', JSON.stringify({ page: 0, rect: [100, 100, 300, 60], to: { uri: placeholder } }), []).free();
    const saved = Buffer.from(doc.save()).toString('latin1');
    doc.free();
    // `https://www.bank.com` + RLO (U+202E, as its UTF-8 bytes) + `@oi.live/`: reads as the bank, opens oi.live.
    const rlo = String.fromCharCode(0xe2, 0x80, 0xae);
    const disguised = `https://www.bank.com${rlo}@oi.live/`.padEnd(placeholder.length, 'x');
    writeFileSync(hostile, Buffer.from(saved.replace(placeholder, disguised), 'latin1'));
    await page.goto('/');
    await openPdf(page, hostile);
    const box = await pageBox(page);
    const scale = box.width / 595.28;
    await page.mouse.click(box.x + 250 * scale, box.y + 130 * scale);
    await page.locator('embedpdf-container').getByRole('button', { name: 'Go to Link' }).click();
    const dialog = page.getByRole('dialog', { name: 'This link is not opened' });
    await expect(dialog).toContainText('invisible characters');
    await expect(dialog.locator('.link-address')).toContainText('https://www.bank.com%E2%80%AE@oi.live/');
    await expect(dialog.getByRole('button', { name: 'Open' })).toHaveCount(0);
  });

  test('a script link a file carries is refused, never opened', async ({ page, stayLocal: _ }) => {
    // A hostile file: a link whose address is a script, written straight into it.
    const hostile = 'test-results/edit-pdf-hostile.pdf';
    const placeholder = 'https://placeholder.example/aaaaaaaaaa';
    const c = await core();
    const doc = c.Document.open(new Uint8Array(readFileSync(THREE)));
    doc.call('links.add', JSON.stringify({ page: 0, rect: [100, 100, 300, 60], to: { uri: placeholder } }), []).free();
    const saved = Buffer.from(doc.save()).toString('latin1');
    doc.free();
    expect(saved).toContain(placeholder);
    // Same length, so the cross-reference offsets still hold.
    const script = 'javascript:alert(document.cookie)//'.padEnd(placeholder.length, ' ');
    writeFileSync(hostile, Buffer.from(saved.replace(placeholder, script), 'latin1'));
    await page.goto('/');
    await openPdf(page, hostile);
    const box = await pageBox(page);
    const scale = box.width / 595.28;
    await page.mouse.click(box.x + 250 * scale, box.y + 130 * scale);
    await page.locator('embedpdf-container').getByRole('button', { name: 'Go to Link' }).click();
    const dialog = page.getByRole('dialog', { name: 'This link is not opened' });
    await expect(dialog).toContainText('javascript:');
    await expect(dialog.getByRole('button', { name: 'Open' })).toHaveCount(0);
  });
});
