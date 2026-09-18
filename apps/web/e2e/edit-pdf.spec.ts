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
    await expect(p.getByRole('region', { name: 'New link' })).toBeVisible();
    await p.getByRole('textbox', { name: 'Address' }).fill('https://example.org/دليل');
    await p.getByRole('button', { name: 'Add the link' }).click();
    await expect(first.locator('.edit-pdf-link')).toHaveCount(1);

    // A second, to page 3.
    await drag(page, at(100, 300), at(300, 340));
    await p.getByRole('radio', { name: 'A page of this file' }).check();
    await p.getByLabel('Page (1–3)').fill('3');
    await p.getByRole('button', { name: 'Add the link' }).click();
    await expect(first.locator('.edit-pdf-link')).toHaveCount(2);

    // Following the address asks first, shows it whole, and opens nothing on Cancel.
    await first.locator('.edit-pdf-link').first().click();
    await p.getByRole('button', { name: 'Open the address…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Open this link?' });
    await expect(dialog).toContainText('https://example.org/');
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
    await expect(page.getByRole('dialog', { name: 'Open this link?' })).toContainText('https://example.org/%D8%AF');
    await page.getByRole('dialog', { name: 'Open this link?' }).getByRole('button', { name: 'Cancel' }).click();
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
