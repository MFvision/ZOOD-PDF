import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Locator, Page, Request } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { answer, chooseTool, corpus, enterEditText, fieldValues, openPdf, pendingRedactions, test } from './helpers';
import type { Reply } from './helpers';

/**
 * The AI tool's data answers — OCR post-correction, smart form fill,
 * personal information for redaction, tables to CSV and Excel — driven the
 * way a person drives them, with both providers faked (`answer`): nothing
 * reaches Anthropic or a local model, and `stayLocal` fails the test if
 * anything else leaves the app. Each test checks what was sent, that nothing
 * changed before the review, and what the chosen changes did to the file.
 */

const KEY = 'sk-ant-api03-e2e-not-a-real-key-0000';
const ANTHROPIC = 'https://api.anthropic.com/';
const OLLAMA = 'http://localhost:11434/';
const FORM = corpus('generated/acroform-pdflib-arabic-fields.pdf');
const INVOICE_TABLE = corpus('generated/chrome-cairo-mixed-invoice.pdf');
const SCAN = corpus('generated/scan-arial-200dpi-bilevel.pdf');

const panel = (page: Page) => page.locator('.pane-end');
const preflight = (page: Page) => panel(page).getByRole('region', { name: 'What will be sent' });
const review = (page: Page) => panel(page).getByRole('region', { name: 'To review' });

const json = (body: unknown, status = 200): Reply => ({
  status,
  headers: { 'access-control-allow-origin': '*' },
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** Claude's answer, in one piece: `data` as the JSON text of its one text block. */
const claudeAnswers = (data: unknown) =>
  json({
    id: 'msg_e2e',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: JSON.stringify(data) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

type Body = { system: string; messages: { content: string }[]; output_config?: { format: { type: string; schema: object } } };
const bodyOf = (request: Request) => request.postDataJSON() as Body;

async function withClaude(page: Page, action: string): Promise<Locator> {
  await chooseTool(page, 'AI');
  const ai = panel(page);
  await ai.getByRole('radio', { name: /^Claude/ }).check();
  await ai.getByLabel('Anthropic API key').fill(KEY);
  await ai.getByRole('radio', { name: action }).check();
  return ai;
}

type Core = { call_static(op: string, args: string, blobs: Uint8Array[]): { json: string }; Document: { open(b: Uint8Array): { extract_text(i: number): string; free(): void } } };
let core: Core | null = null;
async function warraq(): Promise<Core> {
  if (core) return core;
  const root = new URL('../../../packages/ui/src/core-wasm/', import.meta.url);
  const module = await import(new URL('warraq_core.js', root).href);
  await module.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', root)) });
  core = module as unknown as Core;
  return core;
}

async function saveFile(page: Page, path: string): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click()]);
  await download.saveAs(path);
  return readFileSync(path);
}

test.describe('the AI tool answers with data, and nothing is changed before it is reviewed', () => {
  test.setTimeout(180_000);

  test('OCR post-correction: the changed words are shown one by one and written into the text layer', async ({ page, stayLocal: _ }) => {
    let sentPage = '';
    const toClaude = await answer(page, ANTHROPIC, (request) => {
      const text = bodyOf(request).messages[0]!.content;
      sentPage = /<page number="1">\n([\s\S]*?)\n<\/page>/.exec(text)?.[1] ?? '';
      // The model corrects one word: the first on the page.
      const first = sentPage.split(/\s+/)[0] ?? '';
      return claudeAnswers({ pages: [{ page: 1, text: sentPage.replace(first, 'مُصحَّحة') }] });
    });
    await page.goto('/');
    await openPdf(page, SCAN);
    await chooseTool(page, 'Scan & OCR');
    await panel(page).getByRole('button', { name: 'Recognize text', exact: true }).click();
    await expect(panel(page).locator('[role="status"]').last()).toContainText('Text layer added', { timeout: 120_000 });

    const ai = await withClaude(page, 'Correct the OCR text');
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await expect(preflight(page)).toContainText('Anthropic, at api.anthropic.com');
    expect(toClaude).toHaveLength(0);
    await preflight(page).getByRole('button', { name: 'Send to Anthropic' }).click();

    const list = review(page).getByRole('list', { name: 'Corrections' });
    await expect(list.locator('li')).toHaveCount(1);
    await expect(list).toContainText('مُصحَّحة');
    // What went: the recognised text of the page, with the answer's shape asked for.
    const body = bodyOf(toClaude[0]!);
    expect(body.system).toContain('optical character recognition');
    expect(body.output_config?.format.type).toBe('json_schema');
    expect(sentPage.length).toBeGreaterThan(50);

    await review(page).getByRole('button', { name: 'Write 1 corrections into the text layer' }).click();
    await expect(review(page)).toContainText('Corrections written: 1, on 1 pages.');
    const first = await enterEditText(page);
    await expect(first.locator('.text-layer')).toContainText('مُصحَّحة');
    const saved = await saveFile(page, 'test-results/ocr-corrected.pdf');
    // The corrected word is in the file's layer, and in the words kept with it.
    const warraqCore = await warraq();
    const doc = warraqCore.Document.open(new Uint8Array(saved));
    expect(doc.extract_text(0)).toContain('مُصحَّحة');
    doc.free();
    const kept = JSON.parse(warraqCore.call_static('ocr.layer_words', '{}', [new Uint8Array(saved)]).json) as { pages: { words: { text: string }[] }[] };
    expect(kept.pages[0]?.words.map((w) => w.text).join(' ')).toContain('مُصحَّحة');
  });

  test('smart form fill: only the fields and the details go; the values are reviewed, then typed into the form', async ({ page, stayLocal: _ }) => {
    const toClaude = await answer(page, ANTHROPIC, () =>
      claudeAnswers({
        values: [
          { field: 'الجنسية', value: 'سعودي' },
          { field: 'البريد الإلكتروني', value: 'm.ali@example.sa' },
          { field: 'not a field', value: 'x' },
        ],
      }),
    );
    await page.goto('/');
    await openPdf(page, FORM);
    const ai = await withClaude(page, 'Fill in the form from my details');
    await ai.getByLabel('Your details (name, ID number, address…)').fill('أنا سعودي الجنسية، وبريدي m.ali@example.sa');
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await preflight(page).getByRole('button', { name: 'Send to Anthropic' }).click();

    const text = bodyOf(toClaude[0]!).messages[0]!.content;
    expect(text).toContain('- name: "الجنسية" | label: "الجنسية:" | now: ""');
    expect(text).toContain('أنا سعودي الجنسية، وبريدي m.ali@example.sa');
    // Nothing else of the document: not its title, not a field's value's neighbours.
    expect(text).not.toContain('نموذج طلب تجديد رخصة');
    // The details are not kept on the device: "Remember" was not ticked.
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('m.ali@example.sa');

    const values = review(page).getByRole('list', { name: 'Proposed values' });
    await expect(values.locator('li')).toHaveCount(2);
    // Before the button, the form is as it was.
    expect(await fieldValues(page)).not.toContain('سعودي');
    await values.getByLabel('Value for الجنسية:').fill('سعودية');
    await review(page).getByRole('button', { name: 'Fill 2 fields' }).click();
    await expect(review(page)).toContainText('Filled 2 fields.');
    await expect.poll(() => fieldValues(page)).toContain('سعودية');
    expect(await fieldValues(page)).toContain('m.ali@example.sa');

    const saved = await saveFile(page, 'test-results/form-filled.pdf');
    await page.goto('/');
    await openPdf(page, 'test-results/form-filled.pdf');
    await expect.poll(() => fieldValues(page)).toContain('سعودية');
    // Arabic typed into the form is drawn in the file (Warraq's appearances).
    expect(saved.toString('latin1')).toContain('WarraqArabic');
  });

  test('personal information: the model, and patterns on this device; the chosen ones become redaction marks', async ({ page, stayLocal: _ }) => {
    const toClaude = await answer(page, ANTHROPIC, () =>
      claudeAnswers({ items: [{ page: 1, text: 'محمد عبد الله', kind: 'name' }, { page: 1, text: 'غير موجود في الصفحة', kind: 'address' }] }),
    );
    await page.goto('/');
    await openPdf(page, FORM);
    const ai = await withClaude(page, 'Find personal information to redact');
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await preflight(page).getByRole('button', { name: 'Send to Anthropic' }).click();
    const found = review(page).getByRole('list', { name: 'Personal information' });
    await expect(found.locator('li')).toHaveCount(2);
    // A finding the page does not have cannot be marked.
    await expect(found).toContainText('not found on the page');
    expect(await pendingRedactions(page)).toBe(0);
    await review(page).getByRole('button', { name: 'Mark 1 for redaction' }).click();
    await expect.poll(() => pendingRedactions(page)).toBeGreaterThan(0);
    const byModel = await pendingRedactions(page);

    // Patterns, on this device: nothing more is sent.
    await ai.getByRole('button', { name: 'Find with patterns only — nothing is sent' }).click();
    const local = ai.getByRole('region', { name: 'Found on this device' });
    await expect(local.getByRole('list', { name: 'Personal information' })).toContainText('1098765432');
    expect(toClaude).toHaveLength(1);
    await local.getByRole('button', { name: /^Mark \d+ for redaction$/ }).click();
    await expect(local).toContainText('Places marked for redaction');
    await expect.poll(() => pendingRedactions(page)).toBeGreaterThan(byModel);
    // With marks waiting, nothing more goes to a model: their text is still in the file.
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await expect(ai.getByRole('alert')).toContainText('redact');
    // Marks only: nothing is removed until Redact applies them.
    await local.getByRole('button', { name: 'Open Redact' }).click();
    await expect(panel(page).getByRole('button', { name: 'Apply redactions', exact: true })).toBeVisible();
  });

  test('tables: found on this device with nothing sent, or read by a local model; shown, then saved as Excel and as CSV', async ({ page, stayLocal: _ }) => {
    const table = {
      page: 1,
      title: 'فاتورة ضريبية مبسطة',
      rows: [
        ['الوصف', 'الكمية', 'السعر', 'الإجمالي'],
        ['اشتراك سنوي في خدمة Warraq Pro', '1', '1,200.00', '1,200.00'],
        ['دعم فني (Premium Support)', '12', '150.00', '1,800.00'],
      ],
    };
    const toLocal = await answer(page, OLLAMA, () =>
      json({ model: 'gemma3', message: { role: 'assistant', content: `Here are the tables:\n${JSON.stringify({ tables: [table] })}` }, done: true, done_reason: 'stop' }),
    );
    await page.goto('/');
    await openPdf(page, INVOICE_TABLE);
    await chooseTool(page, 'AI');
    const ai = panel(page);
    await ai.getByRole('radio', { name: 'A local model on this computer' }).check();
    await ai.getByRole('radio', { name: 'Extract the tables' }).check();
    await ai.getByRole('radio', { name: 'This page (1)' }).check();

    // First on this device: the Excel export's own table detection, nothing sent.
    await ai.getByRole('button', { name: 'Find tables on this device — nothing is sent' }).click();
    const local = ai.getByRole('region', { name: 'Tables found on this device' });
    const found = local.getByRole('region', { name: 'Table 1, page 1' });
    await expect(found.locator('th').first()).toHaveText('الوصف');
    await expect(found).toContainText('اشتراك سنوي في خدمة Warraq Pro');
    expect(toLocal).toHaveLength(0);
    const [fromDevice] = await Promise.all([page.waitForEvent('download'), local.getByRole('button', { name: 'Save as Excel (.xlsx)' }).click()]);
    await fromDevice.saveAs('test-results/tables-local.xlsx');
    const localSheet = strFromU8(unzipSync(new Uint8Array(readFileSync('test-results/tables-local.xlsx')))['xl/worksheets/sheet1.xml']!);
    expect(localSheet).toContain('rightToLeft="1"');
    expect(localSheet).toMatch(/<v>1200<\/v>/);

    // Then the model, for what the detection cannot see.
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await preflight(page).getByRole('button', { name: 'Send to the local model' }).click();
    // Ollama was asked for the answer's shape.
    const sent = toLocal[0]!.postDataJSON() as { format?: { required?: string[] } };
    expect(sent.format?.required).toEqual(['tables']);

    const shown = review(page).getByRole('region', { name: 'Table 1, page 1' });
    await expect(shown.locator('tr')).toHaveCount(3);
    await expect(shown.locator('th').first()).toHaveText('الوصف');

    const [xlsx] = await Promise.all([page.waitForEvent('download'), review(page).getByRole('button', { name: 'Save as Excel (.xlsx)' }).click()]);
    expect(xlsx.suggestedFilename()).toBe('chrome-cairo-mixed-invoice (tables).xlsx');
    await xlsx.saveAs('test-results/tables.xlsx');
    const book = unzipSync(new Uint8Array(readFileSync('test-results/tables.xlsx')));
    const sheet = strFromU8(book['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toMatch(/<c r="C2"[^>]*><v>1200<\/v><\/c>/);
    expect(sheet).toContain('اشتراك سنوي في خدمة Warraq Pro');

    const [csv] = await Promise.all([page.waitForEvent('download'), review(page).getByRole('button', { name: 'Save as CSV' }).click()]);
    await csv.saveAs('test-results/tables.csv');
    const text = readFileSync('test-results/tables.csv', 'utf8');
    expect(text.startsWith('\uFEFFالوصف,الكمية,السعر,الإجمالي\r\n')).toBe(true);
    expect(text).toContain('"1,200.00"');
  });
});
