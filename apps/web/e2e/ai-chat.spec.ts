import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, WORD_EXPORT, chooseTool, corpus, embedPage, openPdf, test } from './helpers';
import { installDeviceStub, stubRecord } from './deviceStub';

/**
 * The assistant as a chat, on this device, with the engine faked in the page
 * (`deviceStub.ts`): what is proven is what reaches the model — every page
 * of a long document, the earlier turns, the passage from a late page — and
 * what the panel does with what it says. `stayLocal` fails a test if
 * anything leaves the app.
 */

const LONG = corpus('realworld/A_un_rome_statute_A-CONF.183-9-AR_word_pdfmaker6.pdf');
const SCAN = corpus('realworld/E_commons_qarar193_toshiba_estudio_mfp_scan.pdf');

const panel = (page: Page) => page.locator('.pane-end');
const thread = (page: Page) => panel(page).getByRole('log', { name: 'Conversation' });
const input = (page: Page) => panel(page).getByLabel('Message');
const answers = (page: Page) => thread(page).locator('.ai-turn-assistant');
const chip = (page: Page, name: string) => panel(page).getByRole('list', { name: 'Suggestions' }).getByRole('button', { name });

type Messages = { role: string; content: string }[];
const user = (messages: Messages) => messages[1]?.content ?? '';

/** The stub's part in an analysis: notes that name the pages they were made from. */
const reader = (messages: Messages): string => {
  const text = user(messages);
  if (text.includes('Request:')) {
    return `FINAL from ${(text.match(/<summary /g) ?? []).length} summaries and ${(text.match(/<page number=/g) ?? []).length} pages [p. 95] [p. 2].`;
  }
  if (text.includes('Write its outline')) return 'OUTLINE of the statute [p. 1]';
  if (text.includes('<summaries>')) return `- combined ${(text.match(/<summary /g) ?? []).length}`;
  const pages = [...text.matchAll(/<page number="(\d+)">/g)].map((match) => match[1]);
  return `- notes on ${pages[0]}-${pages.at(-1)} [p. ${pages[0]}]`;
};

async function readWithWarraq(file: string): Promise<string[]> {
  const root = new URL('../../../packages/ui/src/core-wasm/', import.meta.url);
  const core = await import(new URL('warraq_core.js', root).href);
  await core.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', root)) });
  const doc = core.Document.open(new Uint8Array(readFileSync(file)));
  try {
    return Array.from({ length: doc.page_count() as number }, (_, index) => doc.extract_text(index) as string);
  } finally {
    doc.free();
  }
}

/** Opens the assistant on `file` with the model downloaded: the chat ready to be typed into. */
async function ready(page: Page, file: string): Promise<void> {
  await page.goto('/');
  await openPdf(page, file);
  await chooseTool(page, 'AI');
  const ai = panel(page);
  // Before the model is there, the chat says so, offers the download, and sends nothing.
  await expect(ai).toContainText('Download the on-device model first, or choose another provider.');
  await ai.getByRole('button', { name: /^Download the on-device model \(491 MB, once\)/ }).click();
  await expect(input(page)).toBeEnabled();
  await expect(ai).toContainText('Messages stay on this device: the model runs inside the app, and nothing is sent anywhere.');
  await expect(ai.getByRole('button', { name: /^Answering model: Qwen2\.5 0\.5B/ })).toBeVisible();
}

/** The parts of each page that reached the model in requests for notes, in the order they went. */
function pagesRead(requests: { messages: Messages }[]): Map<number, string[]> {
  const read = new Map<number, string[]>();
  for (const request of requests) {
    const text = user(request.messages);
    if (!text.includes('Note its main points')) continue;
    for (const match of text.matchAll(/<page number="(\d+)">\n([\s\S]*?)\n<\/page>/g)) {
      const page = Number(match[1]);
      read.set(page, [...(read.get(page) ?? []), match[2] ?? '']);
    }
  }
  return read;
}

test.describe('the assistant is a chat about the open document', () => {
  test('a message and its streamed answer, a follow-up that carries the earlier turn, Copy, Listen, another tool and back, New chat', async ({ page, context, stayLocal: _ }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // A voice, so Listen has something to speak with.
    await page.addInitScript(() => {
      const spoken: string[] = [];
      class Utterance {
        text: string;
        voice: unknown = null;
        lang = '';
        rate = 1;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(text: string) {
          this.text = text;
        }
      }
      const voice = { name: 'Maged', lang: 'ar-SA', voiceURI: 'maged', localService: true, default: false };
      const synth = {
        getVoices: () => [voice, { name: 'Samantha', lang: 'en-US', voiceURI: 'samantha', localService: true, default: true }],
        speak: (utterance: Utterance) => {
          spoken.push(utterance.text);
          setTimeout(() => utterance.onend?.(), 400);
        },
        cancel: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
        addEventListener: () => undefined,
      };
      Object.defineProperty(globalThis, 'speechSynthesis', { value: synth, configurable: true });
      Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
      (globalThis as unknown as { __spoken: string[] }).__spoken = spoken;
    });
    await installDeviceStub(page, (messages) => {
      const text = user(messages);
      if (text.includes('Request: And who is it for?')) return 'It is for the customer named on it [p. 1].';
      return 'فاتورة ضريبية مبسطة [p. 1].\n- **المجموع** مذكور في أسفلها [p. 1]\n- لا صفحة ثانية فيها [p. 7]';
    });
    await ready(page, INVOICE);
    const ai = panel(page);
    await expect(thread(page)).toContainText('Ask about this document');
    expect((await stubRecord(page)).requests).toHaveLength(0);

    // Shift+Enter is a new line; Enter sends, and the input keeps the focus.
    await input(page).fill('What is this');
    await input(page).press('Shift+Enter');
    await input(page).pressSequentially('document?');
    await expect(input(page)).toHaveValue('What is this\ndocument?');
    await input(page).press('Enter');
    await expect(input(page)).toHaveValue('');
    await expect(input(page)).toBeFocused();
    await expect(thread(page).locator('.ai-turn-user p')).toHaveText(/^What is this\s+document\?$/);
    const first = answers(page).nth(0);
    await expect(first).toContainText('فاتورة ضريبية مبسطة');
    await expect(first).toHaveAttribute('aria-busy', 'false');
    // Lists are lists, the stars of Markdown are not shown, and each citation of a real page is a button.
    await expect(first.locator('li')).toHaveCount(2);
    await expect(first).not.toContainText('**');
    await expect(first.getByRole('button', { name: 'Go to page 1' })).toHaveCount(2);
    await expect(first).toContainText('[p. 7]');
    await expect(first).toContainText('From the whole document (pages: 1).');
    await expect(first).toContainText('Qwen2.5 0.5B · From the whole document (pages: 1).');
    // Arabic reads right to left in the panel, whatever the interface language.
    expect(await first.locator('p[dir="auto"]').first().evaluate((node) => getComputedStyle(node).direction)).toBe('rtl');

    const [pageText] = await readWithWarraq(INVOICE);
    let record = await stubRecord(page);
    expect(record.requests).toHaveLength(1);
    expect(record.requests[0]!.messages[0]!.role).toBe('system');
    expect(user(record.requests[0]!.messages)).toContain(`<page number="1">\n${pageText}\n</page>`);
    expect(user(record.requests[0]!.messages)).toContain('This is the whole text of the 1-page document.');
    expect(user(record.requests[0]!.messages).endsWith('Request: What is this\ndocument?')).toBe(true);
    expect(user(record.requests[0]!.messages)).not.toContain('<conversation>');

    // The follow-up goes with what was said before it.
    await input(page).fill('And who is it for?');
    await input(page).press('Enter');
    const second = answers(page).nth(1);
    await expect(second).toContainText('It is for the customer named on it');
    record = await stubRecord(page);
    expect(record.requests).toHaveLength(2);
    const followUp = user(record.requests[1]!.messages);
    expect(followUp).toContain('<conversation>\nPerson: What is this document?\nAssistant: فاتورة ضريبية مبسطة [p. 1]. - **المجموع** مذكور في أسفلها [p. 1] - لا صفحة ثانية فيها [p. 7]\n</conversation>');
    expect(followUp.endsWith('Request: And who is it for?')).toBe(true);

    // Copy takes the answer as it was written.
    await second.getByRole('button', { name: 'Copy the answer' }).click();
    await expect(second.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('It is for the customer named on it [p. 1].');

    // Listen reads it with the system's voice — the words, not the citation's brackets.
    await second.getByRole('button', { name: 'Listen' }).click();
    await expect(second.getByRole('button', { name: 'Stop listening' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __spoken: string[] }).__spoken)).toEqual(['It is for the customer named on it.']);
    await expect(second.getByRole('button', { name: 'Listen' })).toBeVisible();

    // The conversation is the document's: another tool and back, and it is as it was.
    await chooseTool(page, 'Compress');
    await chooseTool(page, 'AI');
    await expect(answers(page)).toHaveCount(2);
    await expect(answers(page).nth(1)).toContainText('It is for the customer named on it');

    await ai.getByRole('button', { name: 'New chat' }).click();
    await expect(answers(page)).toHaveCount(0);
    await expect(thread(page)).toContainText('Ask about this document');
    await expect(ai.getByRole('button', { name: 'New chat' })).toBeDisabled();
  });

  test('Summarize on a document far over the model\'s window reads every page of it, answers from all of it, and keeps the analysis', async ({ page, stayLocal: _ }) => {
    test.setTimeout(180_000);
    await installDeviceStub(page, reader, { pace: 1 });
    await ready(page, LONG);
    const ai = panel(page);
    const pages = await readWithWarraq(LONG);
    expect(pages).toHaveLength(95);
    // About forty times what the model reads at once.
    expect(pages.reduce((sum, text) => sum + text.length, 0)).toBeGreaterThan(150_000);
    await expect(ai).toContainText('Pages: 95 — more than the model reads at once.');

    await chip(page, 'Summarize this document').click();
    await expect(input(page)).toBeFocused();
    await expect(thread(page).locator('.ai-turn-user p')).toHaveText('Summarize this document: one or two sentences on what it is, then its main points, each with its page.');
    const answer = answers(page).nth(0);
    await expect(answer).toContainText('This needs the whole document, so all of it is read first');
    // Its progress is said, by the pages being read.
    await expect(ai.getByRole('status').filter({ hasText: /Reading pages \d+(–\d+)? of 95/ })).toBeVisible();
    await expect(answer).toContainText('FINAL from', { timeout: 120_000 });
    await expect(answer).toContainText('From the analysis of the whole document (pages: 95).');
    await expect(ai).toContainText('Analyzed: the assistant knows the whole document (pages: 95).');

    let record = await stubRecord(page);
    // Every page reached the model, whole: what was read of each page, put together, is that page's text.
    const read = pagesRead(record.requests);
    let long = 0;
    for (const [index, text] of pages.entries()) {
      if (text.trim().length === 0) continue;
      expect(read.get(index + 1)?.join('\n'), `page ${index + 1}`).toBe(text);
      if ((read.get(index + 1)?.length ?? 0) > 1) long += 1;
    }
    const maps = record.requests.filter((request) => user(request.messages).includes('Note its main points'));
    expect(maps.length).toBeGreaterThan(20);
    // The last request is the person's own, over summaries that run from the first page to the last.
    const final = user(record.requests.at(-1)!.messages);
    expect(final).toContain('Request: Summarize this document:');
    expect(final).not.toContain('<page number=');
    const covered = [...final.matchAll(/<summary pages="(\d+)(?:-(\d+))?">/g)].map((match) => [Number(match[1]), Number(match[2] ?? match[1])] as const);
    expect(covered.length).toBeGreaterThan(0);
    expect(covered[0]![0]).toBe(1);
    expect(covered.at(-1)![1]).toBe(95);
    for (let at = 1; at < covered.length; at += 1) expect(covered[at]![0]).toBeLessThanOrEqual(covered[at - 1]![1] + 1);
    await expect(answer).toContainText(`FINAL from ${covered.length} summaries and 0 pages`);
    // The citation of a real page goes there.
    expect(await embedPage(page)).toBe(1);
    await answer.getByRole('button', { name: 'Go to page 2' }).click();
    await expect.poll(() => embedPage(page)).toBe(2);
    test.info().annotations.push({ type: 'analysis', description: `${maps.length} chunks, ${record.requests.length} requests, ${long} pages read in more than one part` });

    // Asked again, the analysis is not made again: one request, the new one.
    const before = record.requests.length;
    await chip(page, 'Find the key points').click();
    await expect(answers(page).nth(1)).toContainText('FINAL from');
    record = await stubRecord(page);
    expect(record.requests).toHaveLength(before + 1);
    expect(user(record.requests.at(-1)!.messages)).toContain('<conversation>\nPerson: Summarize this document:');
    await expect(answers(page).nth(1)).not.toContainText('This needs the whole document');

    // It is kept on the device, by the text: the app closed and opened again, the file opened again, nothing is read twice.
    await page.reload();
    await ready(page, LONG);
    await expect(ai).toContainText('Analyzed: the assistant knows the whole document (pages: 95).');
    await chip(page, 'Summarize this document').click();
    await expect(answers(page).nth(0)).toContainText('FINAL from');
    expect((await stubRecord(page)).requests).toHaveLength(1);
  });

  test('a question on a long document is answered from the passage on a late page, and says which pages it read', async ({ page, stayLocal: _ }) => {
    await installDeviceStub(page, () => 'The passage says so [p. 90].');
    await ready(page, LONG);
    const pages = await readWithWarraq(LONG);
    // A line of page 90, asked about in its own words.
    const line = pages[89]!.split('\n').filter((text) => text.trim().split(/\s+/).length >= 8)[3]!;
    const question = line.trim().split(/\s+/).slice(0, 7).join(' ');
    await input(page).fill(question);
    await input(page).press('Enter');
    const answer = answers(page).nth(0);
    await expect(answer).toContainText('The passage says so');
    const record = await stubRecord(page);
    expect(record.requests).toHaveLength(1);
    const sent = user(record.requests[0]!.messages);
    expect(sent).toContain(line);
    expect(sent).toContain('<page number="90">');
    expect(sent).toContain('The document is 95 pages, too long to give you whole.');
    expect(sent.endsWith(`Request: ${question}`)).toBe(true);
    // Far less than the document, and every line of it a line of the page it is tagged with.
    expect(sent.length).toBeLessThan(8000);
    for (const match of sent.matchAll(/<page number="(\d+)">\n([\s\S]*?)\n<\/page>/g)) {
      for (const part of (match[2] ?? '').split('\n').filter((text) => text !== '…')) expect(pages[Number(match[1]) - 1]).toContain(part);
    }
    // No silent truncation: the answer says what it was made from.
    await expect(answer).toContainText(/From passages on pages [\d–, ]*90[\d–, ]* of 95; the rest was not read for this answer\./);
    // The pages read are buttons under the answer, whether or not the model cited them; so is the citation it wrote.
    const read = answer.getByRole('list', { name: 'Pages read for this answer' });
    await read.getByRole('button', { name: 'Go to page 90' }).click();
    await expect.poll(() => embedPage(page)).toBe(90);
    await expect(answer.locator('.ai-answer-text').getByRole('button', { name: 'Go to page 90' })).toHaveText('p. 90');
  });

  test('Stop keeps what was written; an analysis stopped half-way goes on from what it kept', async ({ page, stayLocal: _ }) => {
    test.setTimeout(180_000);
    await installDeviceStub(page, (messages) => (user(messages).includes('Request:') ? Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ') : reader(messages)), { pace: 10 });
    await ready(page, LONG);
    const ai = panel(page);
    // A question, stopped while its answer is being written.
    await input(page).fill('What does article 5 say about jurisdiction?');
    await input(page).press('Enter');
    const answer = answers(page).nth(0);
    await expect(answer).toContainText('word5 ');
    await ai.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(answer).toContainText('Stopped here: the answer is incomplete.');
    await expect(answer).not.toContainText('word399');
    await expect(input(page)).toBeFocused();
    await expect(ai.getByRole('button', { name: 'Send' })).toBeVisible();
    expect((await stubRecord(page)).aborted).toBe(1);

    // The analysis, from its button, stopped after some chunks.
    await ai.getByRole('button', { name: 'Analyze this document' }).click();
    await expect(ai.getByRole('status').filter({ hasText: /Reading pages (\d+)(–\d+)? of 95/ })).toBeVisible();
    await expect.poll(async () => (await stubRecord(page)).requests.filter((request) => user(request.messages).includes('Note its main points')).length).toBeGreaterThan(4);
    await ai.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(thread(page)).toContainText('The analysis was stopped. What was read is kept; it goes on from there next time.');
    const stopped = (await stubRecord(page)).requests.filter((request) => user(request.messages).includes('Note its main points'));
    await expect(ai).toContainText('Pages: 95 — more than the model reads at once.');

    await ai.getByRole('button', { name: 'Analyze this document' }).click();
    await expect(thread(page)).toContainText(/The document is analyzed, all of it \(pages: 95; steps: \d+\)/, { timeout: 120_000 });
    await expect(ai).toContainText('Analyzed: the assistant knows the whole document (pages: 95).');
    const all = (await stubRecord(page)).requests.filter((request) => user(request.messages).includes('Note its main points'));
    // What was summarized before the stop was not asked for again — only the chunk in hand when Stop came.
    const again = all.slice(stopped.length).map((request) => user(request.messages));
    for (const done of stopped.slice(0, -1)) expect(again).not.toContain(user(done.messages));
    const read = pagesRead(all.slice(0, stopped.length - 1).concat(all.slice(stopped.length)));
    const pages = await readWithWarraq(LONG);
    for (const [index, text] of pages.entries()) if (text.trim().length > 0) expect(read.get(index + 1)?.join('\n'), `page ${index + 1}`).toBe(text);
  });

  test('a scanned PDF with no text: the assistant says so and offers Scan & OCR, and asks the model nothing', async ({ page, stayLocal: _ }) => {
    await installDeviceStub(page, () => 'an invented summary');
    await ready(page, SCAN);
    const ai = panel(page);
    await expect(ai).toContainText('This file has no text to read — its pages may be scanned images.');
    await chip(page, 'Summarize this document').click();
    const answer = answers(page).nth(0);
    await expect(answer).toContainText('This document has no text');
    await expect(answer).toContainText('Recognize its text with Scan & OCR first.');
    await expect(thread(page)).not.toContainText('an invented summary');
    expect((await stubRecord(page)).requests).toHaveLength(0);
    await answer.getByRole('button', { name: 'Open Scan & OCR' }).click();
    await expect(panel(page).getByRole('heading', { name: 'Scan & OCR' })).toBeVisible();
  });

  test('a text that costs more than a token a character: no request is over the window, every page is read, and the answer appears', async ({ page, stayLocal: _ }) => {
    // The engine refuses what does not fit, as the host does (E_TOO_LONG): the fault behind "the answer doesn't appear".
    await installDeviceStub(page, reader, { charsPerToken: 0.7, pace: 1 });
    await ready(page, WORD_EXPORT);
    const pages = await readWithWarraq(WORD_EXPORT);
    await chip(page, 'Summarize this document').click();
    const answer = answers(page).nth(0);
    await expect(answer).toContainText('FINAL from');
    await expect(answer.getByRole('alert')).toHaveCount(0);
    const record = await stubRecord(page);
    // Requests were refused, and answered with less: each chunk read in halves until it fitted.
    expect(record.refused).toBeGreaterThan(0);
    for (const request of record.requests) {
      const tokens = Math.ceil(request.messages.reduce((sum, message) => sum + message.content.length, 0) / 0.7);
      expect(tokens + request.maxTokens).toBeLessThanOrEqual(4096);
    }
    const read = pagesRead(record.requests);
    for (const [index, text] of pages.entries()) expect(read.get(index + 1)?.join('\n'), `page ${index + 1}`).toBe(text);
  });
});
