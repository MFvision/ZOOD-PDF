import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { strFromU8, unzipSync, unzlibSync } from 'fflate';
import { INVOICE, WORD_EXPORT, annotationTypes, chooseTool, corpus, enterEditText, openPdf, pageBox, pendingRedactions, test, useAction } from './helpers';

const HUNDRED_PAGES = corpus('generated/perf-text-100-pages.pdf');
const WORD_NAME = 'A_worldbank_malpass_g7_briefing_AR_word2016_pdftools';
const GREETING = 'صباح الخير';
/** The same two words in visual order, as PDFium reads Arabic: they must never be exported. */
const GREETING_VISUAL = [...GREETING].reverse().join('');

const panel = (page: Page) => page.locator('.pane-end');

/** Chooses a format (and a resolution), clicks Export, and returns the file the person gets. */
async function exportAs(page: Page, format: string, dpi?: string): Promise<{ name: string; bytes: Uint8Array }> {
  // Word as flowing text is Word with its second choice.
  const flowing = format === 'Word (.docx), text only';
  await panel(page).getByRole('radio', { name: flowing ? 'Word (.docx)' : format }).check();
  if (dpi) await panel(page).getByRole('combobox', { name: 'Resolution' }).selectOption({ label: dpi });
  if (format.startsWith('Word')) {
    await panel(page).getByRole('combobox', { name: 'Word' }).selectOption({ label: flowing ? 'Text only, flowing' : 'Keep the layout' });
  }
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel(page).getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  const name = download.suggestedFilename();
  const path = `test-results/export-${name}`;
  await download.saveAs(path);
  await expect(panel(page).getByRole('status')).toHaveText(`Exported “${name}”.`);
  return { name, bytes: new Uint8Array(readFileSync(path)) };
}

/** Whether the browser's own XML parser accepts `xml`: the strictest check at hand. */
async function wellFormed(page: Page, xml: string): Promise<boolean> {
  return page.evaluate((source) => new DOMParser().parseFromString(source, 'application/xml').getElementsByTagName('parsererror').length === 0, xml);
}

interface Png {
  width: number;
  height: number;
  dpi: number | null;
  /** Pixels darker than mid-grey: zero means nothing was drawn. */
  ink: number;
  /** Strongly red pixels, as EmbedPDF draws ink by default. */
  red: number;
}

/** The PNG predictor of filter type 4. */
function paeth(left: number, up: number, corner: number): number {
  const guess = left + up - corner;
  const [a, b, c] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - corner)];
  return a <= b && a <= c ? left : b <= c ? up : corner;
}

/** Reads a PNG back without Warraq's code: chunks, inflate, and every row filter. */
function readPng(png: Uint8Array): Png {
  expect([...png.subarray(0, 8)], 'PNG signature').toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  let dpi: number | null = null;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[png[at + 17]!] ?? 0;
    }
    if (type === 'pHYs') dpi = Math.round(view.getUint32(at + 8) * 0.0254);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  idat.reduce((offset, part) => (joined.set(part, offset), offset + part.length), 0);
  const raw = unzlibSync(joined);
  const stride = width * channels;
  expect(raw.length, 'rows of the declared size').toBe((stride + 1) * height);
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : 0;
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + predictor) & 0xff;
    }
  }
  let ink = 0;
  let red = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    if (pixels[i]! < 128) ink += 1;
    if (channels >= 3 && pixels[i]! > 180 && pixels[i + 1]! < 110 && pixels[i + 2]! < 110) red += 1;
  }
  return { width, height, dpi, ink, red };
}

/** One continuous stroke across the page, between fractions of its size. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await pageBox(page);
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 15 });
  await page.mouse.up();
}

test.describe('Export saves the document in other formats, Arabic in reading order', () => {
  test('text, Markdown, Word, a web page and page images of an Arabic Word export', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await chooseTool(page, 'Export');
    await expect(panel(page).getByText('Each page as it looks')).toBeVisible();

    // Plain text: UTF-8 with a byte-order mark, each page marked, in reading order.
    const txt = await exportAs(page, 'Plain text (.txt)');
    expect(txt.name).toBe(`${WORD_NAME}.txt`);
    expect([...txt.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = strFromU8(txt.bytes.subarray(3));
    expect(text.startsWith('— 1 —\n\n')).toBe(true);
    expect(text).toContain('\n\n— 2 —\n\n');
    expect(text.indexOf(GREETING)).toBeGreaterThan(0);
    expect(text.indexOf(GREETING)).toBeLessThan(text.indexOf('— 2 —'));
    expect(text).not.toContain(GREETING_VISUAL);

    // Markdown: a heading for each page, paragraphs as paragraphs.
    const md = strFromU8((await exportAs(page, 'Markdown (.md)')).bytes);
    expect(md.startsWith(`# ${WORD_NAME.replaceAll('_', '\\_')}\n\n## Page 1\n\n`)).toBe(true);
    expect(md).toContain('\n\n## Page 2\n\n');
    expect(md).toContain(`\n\n${GREETING}. يسعدني أن ألتقي بكم عبر شبكة الإنترنت. سألقي كلمة، ثم يسعدني أن أتلقَّى الأسئلة.\n\n`);

    // Word: right-to-left paragraphs in well-formed UTF-8 XML, a page break between the pages.
    const docx = await exportAs(page, 'Word (.docx), text only');
    expect(docx.name).toBe(`${WORD_NAME}.docx`);
    const parts = unzipSync(docx.bytes);
    expect(Object.keys(parts).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
    for (const [name, data] of Object.entries(parts)) expect(await wellFormed(page, strFromU8(data)), name).toBe(true);
    const xml = strFromU8(parts['word/document.xml']!);
    expect(xml).toMatch(/<w:p><w:pPr><w:bidi\/><\/w:pPr><w:r><w:rPr>(<w:sz w:val="\d+"\/><w:szCs w:val="\d+"\/>)?<w:rtl\/><\/w:rPr><w:t xml:space="preserve">صباح الخير\./);
    expect(xml.match(/<w:pageBreakBefore\/>/g)).toHaveLength(1);
    expect(xml).not.toContain(GREETING_VISUAL);
    // The date reads left to right: no w:bidi and no w:rtl on it.
    expect(xml).toContain('<w:p><w:r><w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">06/13/2021</w:t></w:r></w:p>');

    // Page images: one PNG per page in one zip, drawn at the chosen resolution.
    const zip = await exportAs(page, 'Page images (.png)', '72 dpi');
    expect(zip.name).toBe(`${WORD_NAME} (pages).zip`);
    const images = unzipSync(zip.bytes);
    expect(Object.keys(images)).toEqual([`${WORD_NAME}-1.png`, `${WORD_NAME}-2.png`]);
    for (const [name, png] of Object.entries(images)) {
      const image = readPng(png);
      expect(Math.abs(image.width - 612), name).toBeLessThanOrEqual(1);
      expect(Math.abs(image.height - 792), name).toBeLessThanOrEqual(1);
      expect(image.dpi, name).toBe(72);
      expect(image.ink, name).toBeGreaterThan(1000);
    }
    const sharper = readPng(unzipSync((await exportAs(page, 'Page images (.png)', '150 dpi')).bytes)[`${WORD_NAME}-1.png`]!);
    expect(Math.abs(sharper.width - 1275)).toBeLessThanOrEqual(1);

    // A web page: UTF-8, right-to-left paragraphs, and nothing that reaches outside.
    const html = strFromU8((await exportAs(page, 'Web page (.html)')).bytes);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(`<p dir="rtl">${GREETING}.`);
    expect(html).toContain('<p dir="auto">06/13/2021</p>');
    expect(html).not.toMatch(/<script|<link|<img|\bsrc=|\bhref=|url\(|@import/i);
    // Opened in the browser, it reads right to left and loads nothing (the fixture fails on any request).
    await page.setContent(html);
    const greeting = page.locator('p', { hasText: GREETING });
    await expect(greeting).toBeVisible();
    expect(await greeting.evaluate((node) => getComputedStyle(node).direction)).toBe('rtl');
  });

  test('Word keeping the layout: the page picture behind text boxes in their own face, size and colour', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, corpus('generated/chrome-cairo-mixed-invoice.pdf'));
    await chooseTool(page, 'Export');
    const docx = await exportAs(page, 'Word (.docx)');
    const parts = unzipSync(docx.bytes);
    for (const [name, data] of Object.entries(parts)) {
      if (name.endsWith('.xml') || name.endsWith('.rels')) expect(await wellFormed(page, strFromU8(data)), name).toBe(true);
    }
    // The table's rules are in the page's picture, behind the text.
    const picture = parts['word/media/page1.png']!;
    expect([...picture.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const xml = strFromU8(parts['word/document.xml']!);
    expect(xml).toContain('behindDoc="1"');
    // A text box per paragraph, and per table cell: each where it was.
    const boxes = xml.match(/<wps:wsp>/g) ?? [];
    expect(boxes.length).toBeGreaterThan(15);
    expect(xml).toContain('w:ascii="Cairo"');
    expect(xml).toMatch(/<w:bidi\/>.*?<w:t xml:space="preserve">فاتورة ضريبية مبسطة<\/w:t>/);
    // The header row's cells are boxes of their own, not one line across the table.
    for (const cell of ['الوصف', 'الكمية', 'السعر', 'الإجمالي']) expect(xml).toContain(`<w:t xml:space="preserve">${cell}</w:t>`);
    // The page is the PDF's own size.
    expect(xml).toContain('<w:pgSz w:w="11899" w:h="16838"/>');
  });

  test('a long document shows its progress, and the button waits for it', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, HUNDRED_PAGES);
    await chooseTool(page, 'Export');
    await panel(page).getByRole('radio', { name: 'Page images (.png)' }).check();
    await panel(page).getByRole('combobox', { name: 'Resolution' }).selectOption({ label: '72 dpi' });
    const button = panel(page).getByRole('button', { name: 'Export', exact: true });
    const downloaded = page.waitForEvent('download', { timeout: 110_000 });
    await button.click();
    await expect(panel(page).getByRole('status')).toHaveText(/^Page \d+ of 100…$/);
    await expect(button).toBeDisabled();
    await expect(panel(page).getByRole('radio', { name: 'Plain text (.txt)' })).toBeDisabled();
    const download = await downloaded;
    const path = `test-results/export-${download.suggestedFilename()}`;
    await download.saveAs(path);
    expect(Object.keys(unzipSync(new Uint8Array(readFileSync(path))))).toHaveLength(100);
    await expect(button).toBeEnabled();
  });

  test('what was redacted in the viewer is in no export; the rest of the page is', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Redact');
    await useAction(page, 'Mark an area');
    await chooseTool(page, 'Export');
    const warning = panel(page).getByText('Some marked areas have not been applied yet.', { exact: false });
    await expect(warning).toHaveCount(0);

    // The viewer is still marking areas with Export open. The invoice's title,
    // number and date sit in the top fifth of the page; marked is not redacted,
    // and Export says so as soon as the mark is there.
    await drag(page, [0.02, 0.03], [0.98, 0.16]);
    await expect.poll(() => pendingRedactions(page)).toBeGreaterThan(0);
    await expect(warning).toBeVisible();

    await chooseTool(page, 'Redact');
    await panel(page).getByRole('button', { name: 'Apply redactions', exact: true }).click();
    await expect.poll(() => pendingRedactions(page)).toBe(0);
    await chooseTool(page, 'Export');
    await expect(warning).toHaveCount(0);

    const txt = strFromU8((await exportAs(page, 'Plain text (.txt)')).bytes);
    const md = strFromU8((await exportAs(page, 'Markdown (.md)')).bytes);
    const html = strFromU8((await exportAs(page, 'Web page (.html)')).bytes);
    const docx = strFromU8(unzipSync((await exportAs(page, 'Word (.docx), text only')).bytes)['word/document.xml']!);
    for (const [format, content] of Object.entries({ txt, md, html, docx })) {
      expect(content, format).not.toContain('فاتورة ضريبية مبسطة');
      expect(content, format).toContain('العميل');
    }

    // One page: a single PNG, not a zip.
    const png = await exportAs(page, 'Page images (.png)', '72 dpi');
    expect(png.name).toBe('raw-amiri-cid-identity-tounicode.png');
    expect(readPng(png.bytes).ink).toBeGreaterThan(1000);
  });

  test('page images show what was drawn in the viewer', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Export');
    expect(readPng((await exportAs(page, 'Page images (.png)', '72 dpi')).bytes).red).toBe(0);
    await chooseTool(page, 'Comment');
    await useAction(page, 'Draw');
    await drag(page, [0.1, 0.9], [0.9, 0.95]);
    // The ink tool turns the stroke into a drawing 800 ms after it ends.
    await expect.poll(() => annotationTypes(page), { message: 'the stroke became a drawing' }).toContain(15);
    await chooseTool(page, 'Export');
    expect(readPng((await exportAs(page, 'Page images (.png)', '72 dpi')).bytes).red).toBeGreaterThan(100);
  });

  test("a paragraph rewritten in Warraq's editor is exported as rewritten", async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    const replacement = 'فقرة جديدة كتبها الاختبار';
    await area.fill(replacement);
    await area.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(first.locator('.text-layer')).toContainText(replacement);
    // Leaving the editor hands the file back to EmbedPDF; Export waits for it.
    await chooseTool(page, 'Export');
    const xml = strFromU8(unzipSync((await exportAs(page, 'Word (.docx), text only')).bytes)['word/document.xml']!);
    expect(xml).toContain(replacement);
    expect(xml).not.toContain('كلمة رئيس مجموعة البنك الدولي');
  });

  test('a file protected in this session asks for its new password, then exports', async ({ page, stayLocal: _ }) => {
    const password = 'ورّاق-2026';
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Protect');
    await panel(page).getByRole('button', { name: 'Set a password', exact: true }).click();
    await page.getByRole('checkbox', { name: /Require password to open/ }).check();
    await page.getByRole('textbox', { name: 'Enter password' }).fill(password);
    await page.getByRole('textbox', { name: 'Confirm password' }).fill(password);
    await page.getByRole('button', { name: 'Apply Protection' }).click();

    await chooseTool(page, 'Export');
    await panel(page).getByRole('radio', { name: 'Plain text (.txt)' }).check();
    const button = panel(page).getByRole('button', { name: 'Export', exact: true });
    await button.click();
    await expect(panel(page).getByText('This copy is protected with a password set in Protect.')).toBeVisible();
    const field = panel(page).getByLabel('Password');
    await field.fill('not-the-password');
    await field.press('Enter');
    await expect(panel(page).getByRole('alert')).toHaveText('That password did not open the file. Try again.');

    await field.fill(password);
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    const path = `test-results/export-protected-${download.suggestedFilename()}`;
    await download.saveAs(path);
    expect(strFromU8(new Uint8Array(readFileSync(path)))).toContain('العميل');
    await expect(panel(page).getByLabel('Password')).toHaveCount(0);
  });
});
