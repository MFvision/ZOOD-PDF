import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, documentStatus, test } from './helpers';

/** A file of `tests/fixtures/create`, Arabic files written by `make_fixtures.py`. */
const fixture = (name: string) => fileURLToPath(new URL(`../../../tests/fixtures/create/${name}`, import.meta.url));

const panel = (page: Page) => page.locator('.pane-end');
const status = (page: Page) => panel(page).getByRole('status').first();
/** The Create PDF card of the home screen's tool gallery. */
const openCreate = (page: Page, name = 'Create PDF') => page.locator('.tool-card', { hasText: name }).first().click();

/** Chooses files with Create PDF on the home screen, as a person does, and waits for the PDF to open. */
async function createFromHome(page: Page, names: string[]): Promise<string> {
  await page.goto('/');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Create PDF…' }).click()]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles(names.map(fixture));
  await expect(status(page)).toHaveText(/^Made “.+\.pdf”\.$/, { timeout: 60_000 });
  const made = (await status(page).textContent())!.replace(/^Made “|”\.$/g, '');
  await expect(page.getByRole('toolbar')).toContainText(made.replace(/\.pdf$/, ''));
  await expect(documentStatus(page)).toContainText(/Page 1 of \d+/, { timeout: 30_000 });
  return made;
}

/** How many pages the open document has, as the toolbar says. */
async function pageCount(page: Page): Promise<number> {
  await expect(documentStatus(page)).toContainText(/of \d+/);
  return Number(/of (\d+)/.exec((await documentStatus(page).textContent()) ?? '')?.[1]);
}

/** A page's text as Warraq's own reader has it: the text layer of Edit text. */
async function readBack(page: Page, n = 1): Promise<string> {
  if (n === 1) await chooseTool(page, 'Edit');
  const layer = page.locator(`section[data-page="${n}"] .text-layer`);
  await expect(layer).toBeAttached({ timeout: 30_000 });
  await layer.scrollIntoViewIfNeeded();
  await expect(layer).not.toBeEmpty({ timeout: 30_000 });
  return ((await layer.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

test.describe('Create PDF makes a PDF of other files, here on this device', () => {
  test.setTimeout(180_000);

  test('a Word document: its Arabic reads back as typed, its landscape section is a page of its own', async ({ page, stayLocal: _ }) => {
    const made = await createFromHome(page, ['report-ar.docx']);
    expect(made).toBe('report-ar.pdf');
    await expect(panel(page)).toContainText('Word');
    expect(await pageCount(page)).toBeGreaterThanOrEqual(2);
    const first = await readBack(page);
    expect(first).toContain('التقرير السنوي لمكتبة ورّاق');
    expect(first).toContain('هذا تقرير عريض ومائل وتحته خط وملوّن مع رابط إلى الموقع.');
    expect(first).toContain('The annual report also has an English paragraph.');
    expect(first).toContain('الصنف');
    expect(first).toContain('مكتبة ورّاق — تقرير داخلي');
    expect(first).toMatch(/صفحة 1 من [2-9]/);
    const last = await readBack(page, await pageCount(page));
    expect(last).toContain('هذه الصفحة عرضية لأن قسمها كذلك.');
  });

  test('an Excel workbook, a PowerPoint deck, a web page, Markdown, text and CSV all come out readable', async ({ page, stayLocal: _ }) => {
    const cases: [string, string[]][] = [
      ['budget-ar.xlsx', ['الميزانية السنوية', 'الرواتب', '125,000.50', '62.5%']],
      ['slides-ar.pptx', ['عرض مكتبة ورّاق', 'تقرير الربع الثالث']],
      ['page-ar.html', ['دليل ورّاق', 'عربي أولًا', 'تحرير النص العربي']],
      ['notes-ar.md', ['ملاحظات ورّاق', 'كلمة عريضة', 'الرياض']],
      ['notes-ar.txt', ['رسالة من ورّاق', 'هذا نص عادي بالعربية.']],
      ['cities-ar.csv', ['المدينة', 'جدة، الساحل', '٥٦٠']],
    ];
    for (const [name, expected] of cases) {
      await createFromHome(page, [name]);
      const text = await readBack(page);
      for (const words of expected) expect(text, `${name}: ${words}`).toContain(words);
    }
    // The page never ran its script, and fetched nothing (stayLocal would fail).
    await createFromHome(page, ['page-ar.html']);
    expect(await readBack(page)).not.toContain('this never runs');
  });

  test('pictures in the order listed, a multi-page TIFF each page, on A4', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openCreate(page);
    const add = async (names: string[]) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), panel(page).getByRole('button', { name: 'Add files…' }).click()]);
      await chooser.setFiles(names.map(fixture));
    };
    await add(['photo-rotated.jpg', 'scan-2pages.tiff']);
    await add(['picture.webp', 'picture.gif', 'picture.bmp']);
    const list = panel(page).getByRole('list', { name: 'Files to make into a PDF' }).getByRole('listitem');
    await expect(list).toHaveCount(5);
    // The TIFF first.
    await panel(page).getByRole('button', { name: 'Move scan-2pages.tiff earlier' }).click();
    await expect(list.first()).toContainText('scan-2pages.tiff');
    await panel(page).getByRole('combobox', { name: 'Page size' }).selectOption({ label: 'A4' });
    await panel(page).getByRole('combobox', { name: 'Margin around pictures' }).selectOption({ label: 'Normal' });
    await panel(page).getByRole('button', { name: 'Create PDF', exact: true }).click();
    await expect(status(page)).toHaveText('Made “scan-2pages + 4.pdf”.', { timeout: 60_000 });
    expect(await pageCount(page)).toBe(6);
  });

  test('a scan made into a PDF is then read with Scan & OCR', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openCreate(page);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), panel(page).getByRole('button', { name: 'Add files…' }).click()]);
    await chooser.setFiles(fixture('scan-invoice.tiff'));
    await panel(page).getByLabel('Then read the text in the pictures (Scan & OCR)').check();
    await panel(page).getByRole('button', { name: 'Create PDF', exact: true }).click();
    await expect(panel(page).getByRole('status').last()).toContainText('Text layer added', { timeout: 180_000 });
    await expect(status(page)).toHaveText('Made “scan-invoice.pdf”.');
    const truth = readFileSync(fileURLToPath(new URL('../../../tests/corpus/arabic/truth/scan-arial-200dpi-bilevel.txt', import.meta.url)), 'utf8');
    const words = [...new Set(truth.split(/[\s|:،.()—؟]+/).filter((w) => /[؀-ۿ]/.test(w) && w.length >= 3))];
    const text = await readBack(page);
    // As Scan & OCR reads this scan on its own (e2e/ocr.spec.ts).
    expect(words.filter((w) => text.includes(w)).length / words.length).toBeGreaterThan(0.55);
  });

  test('a Word file dropped on the window is made into a PDF, and a file it cannot read is named', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    const drop = async (files: { name: string; bytes: number[] }[]) =>
      page.evaluate((list) => {
        const transfer = new DataTransfer();
        for (const f of list) transfer.items.add(new File([new Uint8Array(f.bytes)], f.name));
        for (const type of ['dragenter', 'dragover', 'drop']) {
          window.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
        }
      }, files);
    await drop([
      { name: 'report-ar.docx', bytes: [...readFileSync(fixture('report-ar.docx'))] },
      { name: 'unknown.docx', bytes: [...new TextEncoder().encode('not a document')] },
    ]);
    await expect(status(page)).toHaveText('Made “report-ar.pdf”.', { timeout: 60_000 });
    await expect(panel(page).getByRole('alert')).toHaveText('Could not be read: unknown.docx.');
    expect(await readBack(page)).toContain('التقرير السنوي لمكتبة ورّاق');
  });

  test('in Arabic, the panel and its choices read right to left', async ({ page, stayLocal: _ }) => {
    await page.addInitScript(() => localStorage.setItem('warraq.preferences', JSON.stringify({ lang: 'ar', theme: 'system' })));
    await page.goto('/');
    const create = page.getByRole('button', { name: 'إنشاء PDF…' });
    await expect(create).toBeVisible();
    await openCreate(page, 'إنشاء PDF');
    await expect(panel(page)).toContainText('أنشئ ملف PDF من ملفات Word');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});
