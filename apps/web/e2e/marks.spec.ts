import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, corpus, openPdf, test } from './helpers';

const THREE = corpus('generated/chrome-notonaskh-justified-3pages.pdf');
const ENGLISH = corpus('generated/chrome-windows-arial-tahoma-times.pdf');
const panel = (page: Page) => page.locator('.pane-end');

type Core = {
  call_static(op: string, args: string, blobs: Uint8Array[]): { json: string; blobs: Uint8Array[]; free(): void };
};
let loaded: Core | null = null;

/** Warraq's own core, the same WASM the app runs, here in Node: to read what was saved. */
async function core(): Promise<Core> {
  if (loaded) return loaded;
  const root = new URL('../../../packages/ui/src/core-wasm/', import.meta.url);
  const module = await import(new URL('warraq_core.js', root).href);
  await module.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', root)) });
  loaded = module as Core;
  return loaded;
}

async function callStatic<T>(op: string, args: object, file: string): Promise<T> {
  const reply = (await core()).call_static(op, JSON.stringify(args), [new Uint8Array(readFileSync(file))]);
  try {
    return JSON.parse(reply.json) as T;
  } finally {
    reply.free();
  }
}

/** What page `index`'s marks say, and what the page says without them, as Warraq's reader reads each. */
const marksText = (file: string, index: number) => callStatic<{ marks: string; page: string }>('marks.text', { page: index }, file);
const listMarks = (file: string) => callStatic<{ marks: { id: number; kind: string; pages: number[] }[] }>('marks.list', {}, file);

async function saveAs(page: Page, name: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: /^(Save|حفظ)$/ }).click(),
  ]);
  const path = `test-results/${name}-${download.suggestedFilename()}`;
  await download.saveAs(path);
  return path;
}

/**
 * The share of strongly red pixels in a box of the page (fractions of its
 * width and height) as PDFium drew it in EmbedPDF's view: the page's
 * largest image on screen, read back through a canvas.
 */
async function redInEmbed(page: Page, box: [number, number, number, number]): Promise<number> {
  return page.evaluate(async ([x0, y0, x1, y1]) => {
    const root = document.querySelector('embedpdf-container')?.shadowRoot;
    const images = root ? [...root.querySelectorAll('img')] : [];
    let best: HTMLImageElement | null = null;
    for (const image of images) {
      const rect = image.getBoundingClientRect();
      const onScreen = rect.width > 0 && rect.top < innerHeight && rect.bottom > 0;
      if (onScreen && (!best || image.naturalWidth * image.naturalHeight > best.naturalWidth * best.naturalHeight)) best = image;
    }
    if (!best) return 0;
    await best.decode().catch(() => undefined);
    const canvas = document.createElement('canvas');
    canvas.width = best.naturalWidth;
    canvas.height = best.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    context.drawImage(best, 0, 0);
    const [w, h] = [canvas.width, canvas.height];
    const data = context.getImageData(Math.floor(x0 * w), Math.floor(y0 * h), Math.max(1, Math.floor((x1 - x0) * w)), Math.max(1, Math.floor((y1 - y0) * h))).data;
    let red = 0;
    for (let k = 0; k < data.length; k += 4) if (data[k]! > 150 && data[k + 1]! < 120 && data[k + 2]! < 120) red += 1;
    return red / (data.length / 4);
  }, box);
}

test.describe('Page marks are drawn into the file, read back in Arabic, and come off again', () => {
  test.setTimeout(180_000);

  test('in Arabic: a header with the page number, Arabic page numbers and a red watermark', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await page.getByRole('menubar').getByRole('combobox', { name: 'Language' }).selectOption({ label: 'العربية' });
    await openPdf(page, THREE);
    await chooseTool(page, 'علامات الصفحات');
    const p = panel(page);

    // A header: the report's name at the start (the right), the page number at the end.
    await p.getByRole('radio', { name: 'ترويسة وتذييل' }).click();
    await p.getByRole('textbox', { name: 'البداية' }).fill('التقرير السنوي');
    await p.getByRole('textbox', { name: 'النهاية' }).click();
    await p.getByRole('button', { name: 'رقم الصفحة' }).click();
    await expect(p.getByRole('textbox', { name: 'النهاية' })).toHaveValue('{page}');
    await p.getByLabel('الأرقام').selectOption('arabic');
    // The preview is drawn by the core before anything is applied.
    await expect(p.locator('.marks-preview canvas')).toBeVisible();
    await p.getByRole('button', { name: 'تطبيق' }).click();
    await expect(p.locator('.marks-item')).toHaveCount(1);
    await expect(p.locator('.marks-item').first()).toContainText('ترويسة');

    // Page numbers, «صفحة ١ من ٣», at the bottom.
    await p.getByRole('radio', { name: 'أرقام الصفحات' }).click();
    await p.getByLabel('الصيغة').selectOption('pageOfArabic');
    await p.getByLabel('الأرقام').selectOption('arabic');
    await p.getByRole('button', { name: 'تطبيق' }).click();
    await expect(p.locator('.marks-item')).toHaveCount(2);

    // A red watermark across the middle, in front.
    await p.getByRole('radio', { name: 'علامة مائية' }).click();
    await p.getByRole('textbox', { name: 'النص' }).fill('سري');
    await p.getByLabel('الحجم (نقطة)').fill('160');
    await p.getByLabel('العتامة (٪)').fill('90');
    await p.getByLabel('اللون').fill('#e01010');
    await p.getByRole('button', { name: 'تطبيق' }).click();
    await expect(p.locator('.marks-item')).toHaveCount(3);

    // PDFium draws it: red in the middle of the page in EmbedPDF's view.
    await expect.poll(() => redInEmbed(page, [0.3, 0.35, 0.7, 0.65]), { timeout: 20_000 }).toBeGreaterThan(0.03);

    const saved = await saveAs(page, 'marks-arabic');
    const original = await callStatic<{ page: string }>('marks.text', { page: 1 }, THREE);
    for (const [index, number] of ['١', '٢', '٣'].entries()) {
      const read = await marksText(saved, index);
      expect(read.marks).toContain('التقرير السنوي');
      expect(read.marks).toContain(`صفحة ${number} من ٣`);
      expect(read.marks).toContain('سري');
    }
    // The marks are artifacts: the page's own text reads as it did.
    expect((await marksText(saved, 1)).page).toBe(original.page);
    expect((await listMarks(saved)).marks.map((m) => m.kind)).toEqual(['header', 'pageNumber', 'watermark']);

    // Reopened, the marks are listed; one comes off, then the rest.
    await page.goto('/');
    await openPdf(page, saved);
    await chooseTool(page, 'علامات الصفحات');
    await expect(p.locator('.marks-item')).toHaveCount(3);
    await p.locator('.marks-item', { hasText: 'علامة مائية' }).getByRole('button', { name: 'إزالة' }).click();
    await expect(p.locator('.marks-item')).toHaveCount(2);
    await expect.poll(() => redInEmbed(page, [0.3, 0.35, 0.7, 0.65]), { timeout: 20_000 }).toBeLessThan(0.005);
    await p.getByRole('button', { name: 'إزالة كل العلامات' }).click();
    await expect(p.getByText('لا علامات من محرر PDF في هذا الملف بعد.')).toBeVisible();
    const cleaned = await saveAs(page, 'marks-cleaned');
    expect((await listMarks(cleaned)).marks).toEqual([]);
    expect((await marksText(cleaned, 0)).marks).toBe('');
  });

  test('in English: Bates numbers across the file and a footer from page 2', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, THREE);
    await chooseTool(page, 'Page marks');
    const p = panel(page);
    await p.getByRole('radio', { name: 'Bates numbers' }).click();
    await p.getByLabel('Prefix').fill('WRQ-');
    await p.getByLabel('Start at').fill('41');
    await p.getByLabel('Number of digits').fill('6');
    // At the top: the footer's page number takes the bottom right.
    await p.getByLabel('Position').selectOption('topRight');
    await p.getByRole('button', { name: 'Apply' }).click();
    await expect(p.locator('.marks-item')).toHaveCount(1);

    await p.getByRole('radio', { name: 'Header & footer' }).click();
    await p.getByRole('radio', { name: 'Footer (bottom)' }).check();
    await p.getByRole('textbox', { name: 'Start' }).fill('Confidential');
    await p.getByRole('textbox', { name: 'End' }).fill('Page {page} of {pages}');
    await p.getByRole('textbox', { name: 'Pages' }).fill('2-');
    await p.getByRole('button', { name: 'Apply' }).click();
    await expect(p.locator('.marks-item')).toHaveCount(2);
    await expect(p.locator('.marks-item').nth(1)).toContainText('Pages 2');

    const saved = await saveAs(page, 'marks-english');
    const pages = (await listMarks(saved)).marks;
    expect(pages[0]?.kind).toBe('bates');
    const count = pages[0]!.pages.length;
    for (let index = 0; index < count; index += 1) {
      const read = await marksText(saved, index);
      expect(read.marks).toContain(`WRQ-${String(41 + index).padStart(6, '0')}`);
      if (index === 0) expect(read.marks).not.toContain('Confidential');
      else expect(read.marks).toContain(`Page ${index + 1} of ${count}`);
    }
  });

  test('chosen before a file is open, the panel works; numbers are typed; the preview is drawn once; summaries say what is drawn', async ({ page, stayLocal: _ }) => {
    // Every `marks.preview` the panel sends to the core, counted as it goes.
    await page.addInitScript(() => {
      const w = window as unknown as { previews: number };
      w.previews = 0;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
        if ((message as { op?: string } | null)?.op === 'marks.preview') w.previews += 1;
        return (post as (...args: unknown[]) => void).call(this, message, ...rest);
      } as typeof Worker.prototype.postMessage;
    });
    const previews = () => page.evaluate(() => (window as unknown as { previews: number }).previews);

    // The tool first, from the home screen's gallery, then the file: the
    // panel must not stay disabled.
    await page.goto('/');
    await page.getByRole('button', { name: 'Page marks', exact: true }).click();
    const p = panel(page);
    await expect(p.getByRole('heading', { name: 'Page marks' })).toBeVisible();
    await openPdf(page, THREE);
    await expect(p.getByText(/^This file has no marks from .+ yet\.$/)).toBeVisible({ timeout: 20_000 });
    await p.getByRole('textbox', { name: 'Text' }).fill('DRAFT');
    await expect(p.locator('.marks-preview canvas')).toBeVisible();
    // Left alone, the preview is not drawn again and again.
    await page.waitForTimeout(1_500);
    const settled = await previews();
    await page.waitForTimeout(2_500);
    expect(await previews()).toBe(settled);

    // Typed a key at a time: 12 stays 12 in a field that starts at 6, and a
    // negative angle can be typed.
    const size = p.getByLabel('Size (pt)');
    await size.selectText();
    await size.pressSequentially('12');
    await expect(size).toHaveValue('12');
    const rotation = p.getByLabel('Rotation (°)');
    await rotation.selectText();
    await rotation.pressSequentially('-30');
    await expect(rotation).toHaveValue('-30');
    await rotation.press('Tab');
    await expect(size).toHaveValue('12');
    await expect(rotation).toHaveValue('-30');
    // Out of range, it settles to the nearest end when left.
    await size.selectText();
    await size.pressSequentially('3');
    await size.press('Tab');
    await expect(size).toHaveValue('6');

    // Page-number formats are labelled in the digits that will be drawn.
    await p.getByRole('radio', { name: 'Page numbers' }).click();
    const format = p.getByLabel('Format');
    await expect(format.locator('option[value="pageOfArabic"]')).toHaveText('صفحة 1 من 9');
    await p.getByLabel('Digits').selectOption('arabic');
    await expect(format.locator('option[value="pageOfArabic"]')).toHaveText('صفحة ١ من ٩');

    // A Bates mark from 41 is listed from 41.
    await p.getByRole('radio', { name: 'Bates numbers' }).click();
    await p.getByLabel('Prefix').fill('WRQ-');
    await p.getByLabel('Start at').fill('41');
    await p.getByRole('button', { name: 'Apply' }).click();
    await expect(p.locator('.marks-item')).toHaveCount(1);
    await expect(p.locator('.marks-item')).toContainText('WRQ-000041');
  });

  test('a picture as a watermark, behind an English page, drawn by PDFium', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, ENGLISH);
    await chooseTool(page, 'Page marks');
    const p = panel(page);
    await p.getByRole('radio', { name: 'Picture' }).check();
    await p.getByLabel('Choose a picture (PNG or JPEG)…').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(RED_PNG, 'base64') });
    await expect(p.getByRole('button', { name: 'Picture: red.png' })).toBeVisible();
    await p.getByLabel('Width (% of the page)').fill('30');
    await p.getByLabel('Rotation (°)').fill('0');
    await p.getByLabel('Opacity (%)').fill('100');
    await p.getByRole('radio', { name: 'Behind the page' }).check();
    await p.getByRole('button', { name: 'Apply' }).click();
    await expect(p.locator('.marks-item')).toHaveCount(1);
    await expect(p.locator('.marks-item')).toContainText('Picture');
    await expect.poll(() => redInEmbed(page, [0.4, 0.45, 0.6, 0.55]), { timeout: 20_000 }).toBeGreaterThan(0.3);

    const saved = await saveAs(page, 'marks-picture');
    const listed = (await listMarks(saved)).marks;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.kind).toBe('watermark');
    // Nothing of a picture is text: the page reads as it did.
    expect((await marksText(saved, 0)).page).toBe((await marksText(ENGLISH, 0)).page);
  });
});

/** A 16×16 red PNG. */
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGN4JiJCEmIY1TCqYfhqAABdUg4Qd2gTGgAAAABJRU5ErkJggg==';
