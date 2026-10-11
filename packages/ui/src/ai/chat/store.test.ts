import { beforeEach, describe, expect, it } from 'vitest';
import type { Prompt } from '../providers';
import { blocksOf, spokenText } from './AnswerText';
import { memoryKept } from './kept';
import type { Runner } from './runner';
import { analyzeNow, approve, ask, conversationOf, discard, newChat, resetChats, setDraft, stop } from './store';
import type { AssistantTurn, Env } from './store';

/**
 * The conversation's rules, without a model: whose turn is whose, what a
 * later message carries, and — for a provider off this device — that
 * nothing is asked of it before the person has seen the request and pressed
 * Send, once for a document and a destination.
 */

const PAGES = ['The first page says the fee is 40 riyals.', 'The second page says it is due in May.'];

function services(pages: string[] = PAGES, pendingRedactions = 0): Env['services'] {
  return {
    pendingRedactions,
    documentPassword: undefined,
    currentFileBytes: async () => new ArrayBuffer(8),
    client: {
      open: async () => ({ pageCount: pages.length, extract_text: async (page: number) => pages[page] ?? '', free: async () => undefined }),
      callStatic: async () => ({ result: { handle: 1, hits: [] }, blobs: [] }),
    } as unknown as Env['services']['client'],
  };
}

interface Recording extends Runner {
  asked: Prompt[];
}

function runner(provider: 'device' | 'claude' | 'local', reply: (prompt: Prompt, index: number) => string | Promise<string>, destination = provider === 'device' ? 'this device' : provider === 'claude' ? 'api.anthropic.com' : 'http://localhost:11434'): Recording {
  const asked: Prompt[] = [];
  const settings: Runner['settings'] = provider === 'device' ? { provider, model: 'test', runtime: 'test' } : provider === 'claude' ? { provider, model: 'claude-test' } : { provider, api: 'ollama', base: destination, model: 'local-test' };
  return {
    asked,
    settings,
    key: `${provider}:test`,
    destination,
    budget: 8000,
    turnBudget: 8000,
    echoBudget: 2000,
    run: async (prompt, options) => {
      asked.push(prompt);
      const text = await reply(prompt, asked.length - 1);
      if (options.signal.aborted) return { ok: false, failure: { kind: 'cancelled' } };
      options.onText?.(text, false);
      return { ok: true, answer: { text, cutOff: false } };
    },
  };
}

const env = (use: Runner, of: Env['services'] = services()): Env => ({ services: of, kept: memoryKept(), makeRunner: async () => use });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitFor = async (check: () => boolean) => {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await settle();
  expect(check()).toBe(true);
};
const assistant = (documentId: number, index: number) => conversationOf(documentId).turns.filter((turn): turn is AssistantTurn => turn.role === 'assistant')[index]!;

beforeEach(() => resetChats());

describe('the conversation', () => {
  it('belongs to its document, newest turn last, and a follow-up carries the turn before it', async () => {
    const device = runner('device', (_, index) => (index === 0 ? 'The fee is 40 riyals [p. 1].' : 'It is due in May [p. 2].'));
    await ask(1, { kind: 'question', text: 'What is the fee?' }, env(device));
    await ask(1, { kind: 'question', text: 'And when is it due?' }, env(device));
    const { turns, busy, known } = conversationOf(1);
    expect(busy).toBe(false);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(assistant(1, 0)).toMatchObject({ text: 'The fee is 40 riyals [p. 1].', status: 'done', provider: 'device', model: 'test', pageCount: 2, basis: { kind: 'whole', pageCount: 2 } });
    expect(assistant(1, 1).text).toBe('It is due in May [p. 2].');
    expect(known).toMatchObject({ pageCount: 2, whole: true, analyzed: false, noText: false });
    // On this device nothing is reviewed: both went as they were sent.
    expect(device.asked).toHaveLength(2);
    expect(device.asked[0]!.user).toContain(`<page number="1">\n${PAGES[0]}\n</page>`);
    expect(device.asked[1]!.user).toContain('<conversation>\nPerson: What is the fee?\nAssistant: The fee is 40 riyals [p. 1].\n</conversation>');
    expect(device.asked[1]!.user.endsWith('Request: And when is it due?')).toBe(true);
    // Another document has its own conversation; a new chat empties this one and keeps what is known of the document.
    expect(conversationOf(2).turns).toHaveLength(0);
    newChat(1);
    expect(conversationOf(1).turns).toHaveLength(0);
    expect(conversationOf(1).known?.pageCount).toBe(2);
  });

  it('Stop keeps what had been written and says the answer is incomplete', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const device: Recording = {
      ...runner('device', () => ''),
      run: async (_, options) => {
        options.onText?.('The fee is', false);
        await held;
        return options.signal.aborted ? { ok: true, answer: { text: 'The fee is', cutOff: true } } : { ok: true, answer: { text: 'The fee is 40.', cutOff: false } };
      },
    };
    const done = ask(1, { kind: 'question', text: 'What is the fee?' }, env(device));
    await waitFor(() => assistant(1, 0)?.text === 'The fee is');
    expect(conversationOf(1).busy).toBe(true);
    // A second message while the first is being answered is not taken.
    await ask(1, { kind: 'question', text: 'Another?' }, env(device));
    expect(conversationOf(1).turns).toHaveLength(2);
    stop(1);
    release();
    await done;
    expect(assistant(1, 0)).toMatchObject({ text: 'The fee is', status: 'stopped', cutOff: true });
    expect(conversationOf(1).busy).toBe(false);
  });

  it('text marked for redaction and not yet redacted stops the message: nothing is read out, and its words return to the input', async () => {
    const device = runner('device', () => 'never');
    await ask(1, { kind: 'question', text: 'What is the fee?' }, env(device, services(PAGES, 2)));
    const conversation = conversationOf(1);
    expect(conversation.turns).toHaveLength(0);
    expect(conversation.notice).toEqual({ key: 'ai.redactPending' });
    expect(conversation.draft).toBe('What is the fee?');
    expect(device.asked).toHaveLength(0);
  });

  it('a document with no text is answered with that, and the model is asked nothing', async () => {
    const device = runner('device', () => 'invented');
    await ask(1, { kind: 'overview', text: 'Summarize the document.' }, env(device, services(['', '  '])));
    expect(assistant(1, 0)).toMatchObject({ status: 'noText', noText: 'document', text: '' });
    expect(conversationOf(1).known?.noText).toBe(true);
    expect(device.asked).toHaveLength(0);
  });

  it('the draft is the conversation\'s own', () => {
    setDraft(1, 'half a question');
    expect(conversationOf(1).draft).toBe('half a question');
    expect(conversationOf(2).draft).toBe('');
  });
});

describe('off this device, nothing is sent before it is seen', () => {
  it('the first request about a document waits at the review; Send lets it and later ones go; another destination asks again', async () => {
    const claude = runner('claude', (_, index) => `Answer ${index + 1}.`);
    const first = ask(1, { kind: 'question', text: 'What is the fee?' }, env(claude));
    await waitFor(() => conversationOf(1).review !== null);
    // Shown, not sent: the destination, the model, the document, and the request itself.
    expect(claude.asked).toHaveLength(0);
    const review = conversationOf(1).review!;
    expect(review).toMatchObject({ provider: 'claude', destination: 'api.anthropic.com', model: 'claude-test', pageCount: 2, characters: PAGES.join('').length, whole: true });
    expect(review.prompt.user).toContain(PAGES[1]);
    expect(review.prompt.user.endsWith('Request: What is the fee?')).toBe(true);
    approve(1);
    await first;
    expect(conversationOf(1).review).toBeNull();
    // What went is what was shown.
    expect(claude.asked).toEqual([review.prompt]);
    expect(assistant(1, 0).text).toBe('Answer 1.');

    // The same document and destination: no second review.
    await ask(1, { kind: 'question', text: 'And when?' }, env(claude));
    expect(claude.asked).toHaveLength(2);
    expect(assistant(1, 1).text).toBe('Answer 2.');

    // Another document is asked about again.
    const other = ask(2, { kind: 'question', text: 'What is the fee?' }, env(claude));
    await waitFor(() => conversationOf(2).review !== null);
    expect(claude.asked).toHaveLength(2);
    approve(2);
    await other;
    expect(claude.asked).toHaveLength(3);

    // And so is another provider for the first document.
    const local = runner('local', () => 'Local answer.');
    const third = ask(1, { kind: 'question', text: 'Once more?' }, env(local));
    await waitFor(() => conversationOf(1).review !== null);
    expect(conversationOf(1).review).toMatchObject({ provider: 'local', destination: 'http://localhost:11434' });
    expect(local.asked).toHaveLength(0);
    approve(1);
    await third;
    expect(local.asked).toHaveLength(1);
    // A local server at another address is another destination.
    const moved = runner('local', () => 'Moved.', 'http://localhost:1234/v1');
    const fourth = ask(1, { kind: 'question', text: 'And there?' }, env(moved));
    await waitFor(() => conversationOf(1).review !== null);
    expect(moved.asked).toHaveLength(0);
    approve(1);
    await fourth;
  });

  it('"Don\'t send" sends nothing, withdraws the message and hands its words back', async () => {
    const claude = runner('claude', () => 'never');
    const pending = ask(1, { kind: 'question', text: 'What is the fee?' }, env(claude));
    await waitFor(() => conversationOf(1).review !== null);
    discard(1);
    await pending;
    const conversation = conversationOf(1);
    expect(claude.asked).toHaveLength(0);
    expect(conversation.turns).toHaveLength(0);
    expect(conversation.review).toBeNull();
    expect(conversation.draft).toBe('What is the fee?');
    expect(conversation.busy).toBe(false);
    // Calling it off is not consent: the next message is reviewed too.
    const again = ask(1, { kind: 'question', text: 'What is the fee?' }, env(claude));
    await waitFor(() => conversationOf(1).review !== null);
    expect(claude.asked).toHaveLength(0);
    approve(1);
    await again;
    expect(claude.asked).toHaveLength(1);
  });

  it('the analysis of a long document for a remote provider waits at the same review, before its first chunk', async () => {
    const long = Array.from({ length: 30 }, (_, index) => `Page ${index + 1}. ${'Some ordinary text of the document. '.repeat(30)}`);
    const claude = { ...runner('claude', (prompt) => (prompt.user.includes('Write its outline') ? 'OUTLINE' : 'notes')), budget: 3000, turnBudget: 3000 };
    const done = analyzeNow(1, env(claude, services(long)));
    await waitFor(() => conversationOf(1).review !== null);
    expect(claude.asked).toHaveLength(0);
    expect(conversationOf(1).review).toMatchObject({ whole: false, pageCount: 30 });
    expect(conversationOf(1).review!.prompt.user).toContain('<page number="1">');
    approve(1);
    await done;
    expect(claude.asked.length).toBeGreaterThan(10);
    const conversation = conversationOf(1);
    expect(conversation.turns.at(-1)).toMatchObject({ role: 'event', note: { key: 'ai.chat.analysisDone', params: { pages: 30 } } });
    expect(conversation.known).toMatchObject({ analyzed: true, whole: false });
  });
});

describe('an answer on the page', () => {
  it('reads the model\'s lists and Markdown marks, and never treats its words as markup', () => {
    expect(blocksOf('## What it is\nAn **invoice** [p. 1].\n\n- one\n* two\n• three\n1. first\n2) second\n<b>not markup</b>')).toEqual([
      { kind: 'paragraph', text: 'What it is', strong: true },
      { kind: 'paragraph', text: 'An invoice [p. 1].', strong: false },
      { kind: 'list', ordered: false, items: ['one', 'two', 'three'] },
      { kind: 'list', ordered: true, items: ['first', 'second'] },
      { kind: 'paragraph', text: '<b>not markup</b>', strong: false },
    ]);
  });

  it('is read aloud without its citations', () => {
    expect(spokenText('The fee is 40 riyals [p. 1].\n- Due in May [pp. 2–3]\n- الرسوم مذكورة [ص ٢]')).toBe('The fee is 40 riyals.\nDue in May.\nالرسوم مذكورة');
  });
});
