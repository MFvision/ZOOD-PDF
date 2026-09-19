import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { ARABIC_FORM, INVOICE, WORD_EXPORT, corpus, test } from './helpers';

/**
 * Batch, driven the way a person drives it: files chosen, steps added and
 * set, the batch run, the zip saved — and every result opened again by
 * Warraq's own core (the WASM build, here in Node) to see the steps really
 * happened in the files. Nothing leaves the app (`stayLocal`).
 */

const panel = (page: Page) => page.locator('.pane-end');
const PROTECTED = corpus('generated/variant-encrypted-aes256.pdf');
const SCAN = corpus('generated/scan-notonaskh-300dpi-skewed-jpeg.pdf');

type Core = {
  Document: { open(bytes: Uint8Array, password?: string): CoreDoc };
  call_static(op: string, args: string, blobs: Uint8Array[]): { json: string; blobs: Uint8Array[] };
};
type CoreDoc = { page_count(): number; page_size(i: number): Float32Array; extract_text(i: number): string; free(): void };

let core: Core | null = null;
async function warraq(): Promise<Core> {
  if (core) return core;
  const root = new URL('../../../packages/ui/src/core-wasm/', import.meta.url);
  const module = await import(new URL('warraq_core.js', root).href);
  await module.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', root)) });
  core = module as unknown as Core;
  return core;
}

async function openBatch(page: Page): Promise<Locator> {
  await page.goto('/');
  // From the home screen: no document needs to be open.
  await page.locator('.tool-cards-grid .tool-card', { hasText: 'Batch' }).click();
  const batch = panel(page);
  await expect(batch.getByRole('heading', { name: 'Files' })).toBeVisible();
  return batch;
}

async function addStep(batch: Locator, name: string): Promise<Locator> {
  await batch.getByRole('combobox', { name: 'Add a step' }).selectOption({ label: name });
  return batch.locator('.batch-step').last();
}

async function saveZip(page: Page, batch: Locator, path: string): Promise<Record<string, Uint8Array>> {
  const [download] = await Promise.all([page.waitForEvent('download'), batch.getByRole('button', { name: /^Save the \d+ results/ }).click()]);
  await download.saveAs(path);
  return unzipSync(new Uint8Array(readFileSync(path)));
}

test.describe('Batch runs a sequence of steps over many files', () => {
  test.setTimeout(240_000);

  test('rotate, number and compress several files; a failing file does not stop the rest; the results come as a zip', async ({
    page,
    stayLocal: _,
  }) => {
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/not-really.pdf', 'this is not a PDF');
    const batch = await openBatch(page);
    await batch.locator('input[type="file"][accept]').setInputFiles([INVOICE, WORD_EXPORT, PROTECTED, 'test-results/not-really.pdf']);
    await expect(batch.getByText('Files: 4')).toBeVisible();

    const rotate = await addStep(batch, 'Rotate pages');
    await rotate.getByRole('combobox', { name: 'Pages', exact: true }).selectOption({ label: 'Odd pages' });
    const numbers = await addStep(batch, 'Page marks');
    await expect(numbers.getByRole('combobox', { name: 'Kind of mark' })).toHaveValue('pageNumber');
    await numbers.getByRole('combobox', { name: 'Digits', exact: true }).selectOption('arabic');
    await addStep(batch, 'Compress');
    await batch.getByLabel('Password for protected files (optional)').fill('warraq');

    await batch.getByRole('button', { name: 'Run on 4 files' }).click();
    const summary = batch.locator('.batch-summary');
    await expect(summary).toContainText('Done: 2. Failed: 2. Not done: 0.', { timeout: 120_000 });
    // Each failure says why, beside its file.
    const files = batch.getByRole('list', { name: 'Files' });
    await expect(files.locator('li', { hasText: 'variant-encrypted-aes256.pdf' })).toContainText('a protected file is not compressed');
    await expect(files.locator('li', { hasText: 'not-really.pdf' })).toContainText('This is not a PDF');

    const zip = await saveZip(page, batch, 'test-results/batch-results.zip');
    expect(Object.keys(zip).sort()).toEqual(['A_worldbank_malpass_g7_briefing_AR_word2016_pdftools-processed.pdf', 'raw-amiri-cid-identity-tounicode-processed.pdf']);
    const warraqCore = await warraq();
    const original = warraqCore.Document.open(new Uint8Array(readFileSync(WORD_EXPORT)));
    const [w, h] = original.page_size(0);
    const text = original.extract_text(0);
    original.free();
    const result = zip['A_worldbank_malpass_g7_briefing_AR_word2016_pdftools-processed.pdf']!;
    const doc = warraqCore.Document.open(result);
    // Page 1 is odd: turned a quarter, so it is as wide as it was tall.
    const size = doc.page_size(0);
    expect([Math.round(size[0]!), Math.round(size[1]!)]).toEqual([Math.round(h!), Math.round(w!)]);
    // Page 2 is even: as it was.
    expect(Math.round(doc.page_size(1)[0]!)).toBe(Math.round(w!));
    // The words are all still there.
    expect(doc.extract_text(0).replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
    doc.free();
    // The page numbers are Warraq's marks, in Arabic-Indic digits, on both pages.
    const marks = JSON.parse(warraqCore.call_static('marks.list', '{}', [result]).json) as { marks: { kind: string; pages: number[]; spec: { numerals: string } }[] };
    expect(marks.marks).toHaveLength(1);
    expect(marks.marks[0]).toMatchObject({ kind: 'pageNumber', pages: [0, 1], spec: { numerals: 'arabic' } });
  });

  test('a saved action comes back without its password; flatten and protect a form', async ({ page, stayLocal: _ }) => {
    let batch = await openBatch(page);
    await addStep(batch, 'Flatten forms and comments');
    const protect = await addStep(batch, 'Protect');
    await protect.getByLabel('Password to open').fill('سر-١٢٣');
    await protect.getByLabel('Copying text and pictures').check();
    await batch.getByLabel('Name for these steps').fill('للإرسال');
    await batch.getByRole('button', { name: 'Save the steps as an action' }).click();

    // A new session: the action is there, its password is not.
    batch = await openBatch(page);
    await batch.getByRole('combobox', { name: 'Action', exact: true }).selectOption('للإرسال');
    await batch.getByRole('button', { name: 'Use this action' }).click();
    const steps = batch.locator('.batch-step');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toContainText('Flatten forms and comments');
    const restored = steps.nth(1);
    await expect(restored.getByLabel('Password to open')).toHaveValue('');
    await expect(restored.getByLabel('Copying text and pictures')).toBeChecked();
    await expect(restored).toContainText('Give a password to open, or one to change the permissions.');

    await batch.locator('input[type="file"][accept]').setInputFiles([ARABIC_FORM]);
    await expect(batch.getByRole('button', { name: 'Run on 1 files' })).toBeDisabled();
    await restored.getByLabel('Password to open').fill('سر-١٢٣');
    await batch.getByRole('button', { name: 'Run on 1 files' }).click();
    await expect(batch.locator('.batch-summary')).toContainText('Done: 1.', { timeout: 120_000 });
    const zip = await saveZip(page, batch, 'test-results/batch-protected.zip');
    const [name] = Object.keys(zip);
    expect(name).toBe('F_pdfjs15546_rtl_acroform_textfields_arabic_digits_acrobat-processed.pdf');
    const bytes = zip[name!]!;
    const warraqCore = await warraq();
    // Only with its password.
    expect(() => warraqCore.Document.open(bytes)).toThrow();
    const doc = warraqCore.Document.open(bytes, 'سر-١٢٣');
    expect(doc.page_count()).toBe(1);
    doc.free();
    // Its fields are drawn into the page now: no form is left in it.
    const report = JSON.parse(warraqCore.call_static('redact.inspect', JSON.stringify({ password: 'سر-١٢٣' }), [bytes]).json) as { findings: { kind: string }[]; protected: boolean };
    expect(report.protected).toBe(true);
    expect(report.findings.map((f) => f.kind)).not.toContain('forms');
    // The form it came from had one.
    const before = JSON.parse(warraqCore.call_static('redact.inspect', '{}', [new Uint8Array(readFileSync(ARABIC_FORM))]).json) as { findings: { kind: string }[] };
    expect(before.findings.map((f) => f.kind)).toContain('forms');
  });

  test('a folder of scans: read with OCR and exported as text, its subfolder kept in the zip', async ({ page, stayLocal: _ }) => {
    rmSync('test-results/scans', { recursive: true, force: true });
    mkdirSync('test-results/scans/2026', { recursive: true });
    copyFileSync(SCAN, 'test-results/scans/2026/مسح.pdf');
    const batch = await openBatch(page);
    await batch.locator('input[type="file"]:not([accept])').setInputFiles('test-results/scans');
    await expect(batch.getByText('Files: 1')).toBeVisible();
    await expect(batch.getByRole('list', { name: 'Files' })).toContainText('scans/2026/مسح.pdf');
    await addStep(batch, 'Scan & OCR');
    const exporting = await addStep(batch, 'Export');
    await exporting.getByRole('combobox', { name: 'Format' }).selectOption('txt');
    // Nothing can follow Export.
    await expect(batch.getByRole('combobox', { name: 'Add a step' })).toBeDisabled();
    await batch.getByRole('button', { name: 'Run on 1 files' }).click();
    await expect(batch.locator('.batch-summary')).toContainText('Done: 1.', { timeout: 180_000 });
    const zip = await saveZip(page, batch, 'test-results/batch-ocr.zip');
    expect(Object.keys(zip)).toEqual(['scans/2026/مسح-processed.txt']);
    const text = new TextDecoder().decode(zip['scans/2026/مسح-processed.txt']);
    // Read from the scan: the words of its first paragraph.
    for (const word of ['مفتوح', 'المصدر', 'المستندات', 'الإنجليزية']) expect(text).toContain(word);
  });
});
