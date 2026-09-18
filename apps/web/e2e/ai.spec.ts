import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Locator, Page, Request } from '@playwright/test';
import {
  INVOICE,
  WORD_EXPORT,
  answer,
  chooseTool,
  embedPage,
  openPdf,
  pageBox,
  pendingRedactions,
  refuse,
  test,
  useAction,
} from './helpers';
import type { Reply } from './helpers';

/**
 * The AI tool, driven the way a person drives it. No request reaches
 * Anthropic or a local model here: `answer` fakes both providers, and
 * `stayLocal` fails the test if anything else leaves the app.
 */

const KEY = 'sk-ant-api03-e2e-not-a-real-key-0000';
const ANTHROPIC = 'https://api.anthropic.com/';
const OLLAMA = 'http://localhost:11434/';

const panel = (page: Page) => page.locator('.pane-end');
const preflight = (page: Page) => panel(page).getByRole('region', { name: 'What will be sent' });
const reply = (page: Page) => panel(page).getByRole('region', { name: 'Answer' });

/** A reply the way the provider sends it — with the CORS header a browser needs to read it. */
const json = (body: unknown, status = 200): Reply => ({
  status,
  headers: { 'access-control-allow-origin': '*' },
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const claudeSays = (text: string) =>
  json({
    id: 'msg_e2e',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

/** Each page of `file` as Warraq's own reader reads it: the same core, run here in Node. */
async function readWithWarraq(file: string): Promise<string[]> {
  const root = new URL('../../../packages/ui/src/core-wasm/', import.meta.url);
  const core = await import(new URL('warraq_core.js', root).href);
  await core.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', root)) });
  const doc = core.Document.open(new Uint8Array(readFileSync(file)));
  try {
    return Array.from(
      { length: doc.page_count() as number },
      (_, index) => doc.extract_text(index) as string,
    );
  } finally {
    doc.free();
  }
}

/** What the person does before anything can be sent: Claude, their key, an action. */
async function claudeFor(
  page: Page,
  action: 'Summarize' | 'Ask a question' | 'Translate',
): Promise<Locator> {
  await chooseTool(page, 'AI');
  const ai = panel(page);
  await ai.getByRole('radio', { name: /^Claude/ }).check();
  await ai.getByLabel('Anthropic API key').fill(KEY);
  await ai.getByRole('radio', { name: action }).check();
  return ai;
}

/** The user message of a Messages API request: the document and the request. */
function sentText(request: Request): string {
  const body = request.postDataJSON() as { messages: { role: string; content: string }[] };
  return body.messages.map((message) => message.content).join('\n');
}

test.describe('the AI tool sends nothing until Send, and then only what it showed', () => {
  test('nothing leaves before Send; Send sends exactly the text Warraq read, and the key only in x-api-key', async ({
    page,
    stayLocal: _,
  }) => {
    const toClaude = await answer(page, ANTHROPIC, () =>
      claudeSays('A briefing on an uneven recovery [p. 1] and on climate finance [p. 2].'),
    );
    const toLocal = await answer(page, OLLAMA, () => json({ error: 'not expected' }, 500));
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    const ai = await claudeFor(page, 'Summarize');
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();

    const pages = await readWithWarraq(WORD_EXPORT);
    const characters = pages.reduce((sum, text) => sum + text.length, 0);
    const shown = preflight(page);
    await expect(shown).toContainText('Anthropic, at api.anthropic.com');
    await expect(shown).toContainText('claude-sonnet-5');
    await expect(shown).toContainText('1–2 of 2');
    await expect(shown).toContainText(characters.toLocaleString('en-US'));
    // Reading the document and showing what would go sent nothing anywhere.
    expect(toClaude).toHaveLength(0);
    expect(toLocal).toHaveLength(0);

    await shown.getByRole('button', { name: 'Send to Anthropic' }).click();
    await expect(reply(page)).toContainText('uneven recovery');
    expect(toClaude).toHaveLength(1);
    expect(toLocal).toHaveLength(0);

    const request = toClaude[0] as Request;
    expect(request.method()).toBe('POST');
    expect(request.url()).toBe('https://api.anthropic.com/v1/messages');
    const body = request.postDataJSON() as {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.messages).toHaveLength(1);
    const text = sentText(request);
    // Logical order, as Warraq reads it; PDFium's reader returns this Arabic reversed.
    expect(text).toContain('صباح الخير');
    // Page by page, exactly what Warraq's reader gives, and as many characters as the preflight said.
    pages.forEach((pageText, index) =>
      expect(text).toContain(`<page number="${index + 1}">\n${pageText}\n</page>`),
    );
    const inPages = [...text.matchAll(/<page number="\d+">\n([\s\S]*?)\n<\/page>/g)].reduce(
      (sum, match) => sum + (match[1]?.length ?? 0),
      0,
    );
    expect(inPages).toBe(characters);

    // The key goes in x-api-key and nowhere else: not the URL, not the body, not another header.
    const headers = await request.allHeaders();
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    const others = Object.entries(headers).filter(([name]) => name !== 'x-api-key');
    expect(JSON.stringify(others)).not.toContain(KEY);
    expect(request.url()).not.toContain(KEY);
    expect(request.postData()).not.toContain(KEY);
    // Nor is it kept on the device: "Remember" was not ticked.
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(KEY);
  });

  test('Ask: the answer cites its pages, and a citation goes to its page', async ({
    page,
    stayLocal: _,
  }) => {
    const toClaude = await answer(page, ANTHROPIC, () =>
      claudeSays('خطة العمل المناخية مذكورة في الصفحة الثانية [p. 2].'),
    );
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    const ai = await claudeFor(page, 'Ask a question');
    const question = 'ماذا قال عن تغير المناخ؟';
    await ai.getByLabel('Your question').fill(question);
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await expect(preflight(page)).toContainText('Your question is sent with the text.');
    await preflight(page).getByRole('button', { name: 'Send to Anthropic' }).click();

    const answered = reply(page);
    await expect(answered).toContainText('خطة العمل المناخية');
    expect(sentText(toClaude[0] as Request)).toContain(`Question: ${question}`);
    // Arabic reads right to left in the panel, whatever the interface language.
    const line = answered.locator('p[dir="auto"]').first();
    expect(await line.evaluate((node) => getComputedStyle(node).direction)).toBe('rtl');

    const cite = answered.getByRole('button', { name: 'p. 2', exact: true });
    await expect(cite).toBeVisible();
    await expect(cite).toHaveAttribute('title', 'Go to page 2');
    expect(await embedPage(page)).toBe(1);
    await cite.click();
    await expect.poll(() => embedPage(page)).toBe(2);
  });

  test('Translate sends only the pages chosen', async ({ page, stayLocal: _ }) => {
    const toClaude = await answer(page, ANTHROPIC, () =>
      claudeSays('[p. 1]\nGood morning. I am pleased to meet you online.'),
    );
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    const ai = await claudeFor(page, 'Translate');
    await expect(ai.getByLabel('Direction')).toHaveValue('en');
    await ai.getByRole('radio', { name: 'This page (1)' }).check();
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    const [first] = await readWithWarraq(WORD_EXPORT);
    await expect(preflight(page)).toContainText('1 of 2');
    await expect(preflight(page)).toContainText((first ?? '').length.toLocaleString('en-US'));
    await preflight(page).getByRole('button', { name: 'Send to Anthropic' }).click();
    await expect(reply(page)).toContainText('Good morning');
    const text = sentText(toClaude[0] as Request);
    expect(text).toContain(`<page number="1">\n${first}\n</page>`);
    expect(text).not.toContain('<page number="2">');
    expect(text).toContain('from Arabic into English');
  });

  test('a wrong key is named as the wrong key', async ({ page, stayLocal: _ }) => {
    const toClaude = await answer(page, ANTHROPIC, () =>
      json(
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
          request_id: 'req_e2e',
        },
        401,
      ),
    );
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    const ai = await claudeFor(page, 'Summarize');
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await preflight(page).getByRole('button', { name: 'Send to Anthropic' }).click();
    await expect(ai.getByRole('alert')).toContainText(
      'Anthropic did not accept this API key (401)',
    );
    expect(toClaude).toHaveLength(1);
    await expect(reply(page)).toHaveCount(0);
  });

  test('a local model: the text goes to this computer only, and the Anthropic key does not go with it', async ({
    page,
    stayLocal: _,
  }) => {
    const toLocal = await answer(page, OLLAMA, () =>
      json({
        model: 'gemma3',
        created_at: '2026-09-18T00:00:00Z',
        message: { role: 'assistant', content: 'ملخص محلي: كلمة عن تعافٍ اقتصادي متفاوت [p. 1].' },
        done: true,
        done_reason: 'stop',
      }),
    );
    const toClaude = await answer(page, ANTHROPIC, () => json({ error: 'not expected' }, 500));
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    // A key typed for Claude first, to show it stays behind.
    const ai = await claudeFor(page, 'Summarize');
    await ai.getByRole('radio', { name: 'A local model on this computer' }).check();
    await expect(ai.getByText('The model runs on this computer')).toBeVisible();
    await expect(ai.getByLabel('Server address')).toHaveValue('http://localhost:11434');
    await expect(ai.getByLabel('Model name')).toHaveValue('gemma3');
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await expect(preflight(page)).toContainText('This computer, at http://localhost:11434');
    await expect(preflight(page)).toContainText('1–2 of 2');
    expect(toLocal).toHaveLength(0);
    await preflight(page).getByRole('button', { name: 'Send to the local model' }).click();
    await expect(reply(page)).toContainText('ملخص محلي');

    expect(toClaude).toHaveLength(0);
    expect(toLocal).toHaveLength(1);
    const request = toLocal[0] as Request;
    expect(request.url()).toBe('http://localhost:11434/api/chat');
    const body = request.postDataJSON() as {
      model: string;
      stream: boolean;
      options: { num_ctx: number };
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('gemma3');
    expect(body.stream).toBe(false);
    expect(body.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(body.messages[1]?.content).toContain('صباح الخير');
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(4096);
    const headers = await request.allHeaders();
    expect(headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(KEY);
    expect(request.postData()).not.toContain(KEY);
  });

  test('LM Studio, through its OpenAI-compatible interface, is reached on its own port', async ({
    page,
    stayLocal: _,
  }) => {
    const toLmStudio = await answer(page, 'http://localhost:1234/', () =>
      json({
        id: 'chatcmpl-e2e',
        object: 'chat.completion',
        model: 'qwen2.5',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ملخص من LM Studio [p. 1].' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await chooseTool(page, 'AI');
    const ai = panel(page);
    await ai.getByRole('radio', { name: 'A local model on this computer' }).check();
    await ai.getByLabel('Interface').selectOption('openai');
    await ai.getByLabel('Server address').fill('http://localhost:1234/v1');
    await ai.getByLabel('Model name').fill('qwen2.5');
    await expect(ai.getByText('connect only to ports')).toHaveCount(0);
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await preflight(page).getByRole('button', { name: 'Send to the local model' }).click();
    // Past the security policy, which would have stopped it before the network.
    await expect(reply(page)).toContainText('ملخص من LM Studio');
    expect(toLmStudio).toHaveLength(1);
    expect((toLmStudio[0] as Request).url()).toBe('http://localhost:1234/v1/chat/completions');
  });

  test('a local address the security policy does not allow is named as such', async ({
    page,
    stayLocal: _,
  }) => {
    const through = await refuse(page, 'http://localhost:11435/');
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await chooseTool(page, 'AI');
    const ai = panel(page);
    await ai.getByRole('radio', { name: 'A local model on this computer' }).check();
    await ai.getByLabel('Server address').fill('http://localhost:11435');
    await expect(
      ai.getByText('connect only to ports 11434 (Ollama) and 1234 (LM Studio)'),
    ).toBeVisible();
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await preflight(page).getByRole('button', { name: 'Send to the local model' }).click();
    await expect(ai.getByRole('alert')).toContainText(
      "This build's security policy does not allow connecting to http://localhost:11435",
    );
    expect(through).toHaveLength(0);
  });

  test('redacted text is never sent: marked but not applied stops the review, applied is gone from the request', async ({
    page,
    stayLocal: _,
  }) => {
    const toClaude = await answer(page, ANTHROPIC, () =>
      claudeSays('An invoice for a customer [p. 1].'),
    );
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Redact');
    await useAction(page, 'Mark an area');
    // The invoice's title, number and date sit in the top fifth of the page (as in tools.spec.ts).
    const box = await pageBox(page);
    await page.mouse.move(box.x + box.width * 0.02, box.y + box.height * 0.03);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.98, box.y + box.height * 0.16, { steps: 15 });
    await page.mouse.up();
    await expect.poll(() => pendingRedactions(page)).toBeGreaterThan(0);

    // Marked but not applied, the title is still in the file: the tool will not read it out.
    let ai = await claudeFor(page, 'Summarize');
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await expect(ai.getByRole('alert')).toContainText('marked for redaction but not redacted yet');
    await expect(preflight(page)).toHaveCount(0);

    await chooseTool(page, 'Redact');
    await panel(page).getByRole('button', { name: 'Apply redactions', exact: true }).click();
    await expect.poll(() => pendingRedactions(page)).toBe(0);

    await chooseTool(page, 'AI');
    ai = panel(page);
    // The key is still in memory from before; nothing else to type.
    await expect(ai.getByLabel('Anthropic API key')).toHaveValue(KEY);
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await preflight(page).getByRole('button', { name: 'Send to Anthropic' }).click();
    await expect(reply(page)).toContainText('An invoice');
    expect(toClaude).toHaveLength(1);
    const text = sentText(toClaude[0] as Request);
    expect(text).not.toContain('فاتورة ضريبية مبسطة');
    expect(text).toContain('العميل');
  });

  test('the key is remembered only when asked, and "Forget the key" removes it', async ({
    page,
    stayLocal: _,
  }) => {
    const stored = () => page.evaluate(() => localStorage.getItem('warraq.ai.anthropicKey'));
    await page.goto('/');
    await page.locator('.tool-cards-grid .tool-card', { hasText: 'AI' }).click();
    const ai = panel(page);
    await ai.getByRole('radio', { name: /^Claude/ }).check();
    const remember = ai.getByRole('checkbox', { name: 'Remember this key on this device' });
    await expect(remember).not.toBeChecked();
    await ai.getByLabel('Anthropic API key').fill(KEY);
    expect(await stored()).toBeNull();
    await expect(ai.getByText('anyone with access to this device')).toBeVisible();

    await remember.check();
    expect(await stored()).toBe(KEY);
    await page.reload();
    await page.locator('.tool-cards-grid .tool-card', { hasText: 'AI' }).click();
    await expect(ai.getByLabel('Anthropic API key')).toHaveValue(KEY);
    await expect(remember).toBeChecked();

    await ai.getByRole('button', { name: 'Forget the key' }).click();
    await expect(ai.getByLabel('Anthropic API key')).toHaveValue('');
    await expect(remember).not.toBeChecked();
    expect(await stored()).toBeNull();
  });
});
