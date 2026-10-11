import { describe, expect, it } from 'vitest';
import type { PageText } from '../budget';
import type { Prompt } from '../providers';
import type { Outcome } from '../send';
import { analyze, digest, groupParts, keptOutline, summaryLimit } from './analyze';
import { answerTurn, asksForOverview, carry, fitsWhole, searchQuery } from './answer';
import type { DocumentText } from './answer';
import { chunkPages, halve, splitText } from './chunks';
import { memoryKept } from './kept';
import type { Runner } from './runner';

/**
 * The chat's reading of a document, with a model that only records what it
 * was asked: what is proven here is what reaches the model — every page of a
 * long document, the earlier turns, the passage from a late page — and what
 * is done with what it says. No model's wording is tested.
 */

/** A document of `count` pages; page N says "Fact N: the value on page N is VN." among filler lines. */
function longDocument(count: number, linesPerPage = 12): DocumentText {
  const pages: PageText[] = [];
  for (let page = 1; page <= count; page += 1) {
    const lines = Array.from({ length: linesPerPage }, (_, line) => `Page ${page} line ${line + 1} speaks of ordinary matters at some length.`);
    lines[5] = `Fact ${page}: the value on page ${page} is V${page * 7}.`;
    pages.push({ page, text: lines.join('\n') });
  }
  return { pageCount: count, pages, characters: pages.reduce((sum, page) => sum + page.text.length, 0) };
}

interface Recorded {
  prompt: Prompt;
  brief: boolean;
}

/** A runner that records every prompt and answers from `reply`. */
function recorder(budget: number, reply: (prompt: Prompt, index: number) => string | Outcome | Promise<string | Outcome>): Runner & { asked: Recorded[] } {
  const asked: Recorded[] = [];
  return {
    asked,
    settings: { provider: 'device', model: 'test', runtime: 'test' },
    key: 'device:test',
    destination: 'this device',
    budget,
    echoBudget: Math.floor(budget / 4),
    run: async (prompt, options) => {
      asked.push({ prompt, brief: options.brief === true });
      const said = await reply(prompt, asked.length - 1);
      if (typeof said !== 'string') return said;
      options.onText?.(said, false);
      return { ok: true, answer: { text: said, cutOff: false } };
    },
  };
}

/** What the notes of a chunk say: the facts found in it, each with its page — so a test can follow a fact through. */
const notes = (prompt: Prompt): string => {
  if (prompt.user.includes('<summaries>')) {
    const facts = [...prompt.user.matchAll(/V\d+ \[p\. \d+\]/g)].map((match) => match[0]);
    return prompt.user.includes('Write its outline') ? `OUTLINE of ${facts.length} facts` : `- ${facts.join('; ')}`;
  }
  const facts = [...prompt.user.matchAll(/the value on page (\d+) is (V\d+)/g)].map((match) => `${match[2]} [p. ${match[1]}]`);
  return `- ${facts.join('; ')}`;
};

/** The core's library search, stood in for: lines that share a word of four letters or more with the query. */
const client = {
  callStatic: async <T>(op: string, args?: Record<string, unknown>): Promise<{ result: T; blobs: ArrayBuffer[] }> => {
    const state = client as unknown as { pages?: PageText[] };
    if (op === 'library.open') return { result: { handle: 1 } as T, blobs: [] };
    if (op === 'library.add') state.pages = (args as { text: PageText[] }).text;
    if (op === 'library.search') {
      const words = String((args as { query: string }).query)
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length >= 4 || /^v?\d+$/.test(word));
      const hits = (state.pages ?? []).flatMap((page) =>
        page.text
          .split('\n')
          .map((text, line) => ({ page: page.page, line, text, score: words.filter((word) => text.toLowerCase().split(/\W+/).includes(word)).length }))
          .filter((hit) => hit.score >= 2),
      );
      hits.sort((a, b) => b.score - a.score);
      return { result: { hits: hits.slice(0, 40) } as T, blobs: [] };
    }
    return { result: {} as T, blobs: [] };
  },
};

const live = () => new AbortController().signal;

describe('chunks', () => {
  it('packs whole pages while they fit, and leaves no page out', () => {
    const doc = longDocument(40);
    const chunks = chunkPages(doc.pages, 2000);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.characters).toBeLessThanOrEqual(2000);
    expect(chunks.flatMap((chunk) => chunk.pages.map((page) => page.page))).toEqual(doc.pages.map((page) => page.page));
    expect(chunks.map((chunk) => chunk.pages.map((page) => page.text).join('')).join('')).toBe(doc.pages.map((page) => page.text).join(''));
    expect(chunks[0]!.from).toBe(1);
    expect(chunks.at(-1)!.to).toBe(40);
  });

  it('cuts a page longer than the budget between its lines, every part keeping its page number', () => {
    const page = { page: 3, text: Array.from({ length: 200 }, (_, line) => `سطر رقم ${line} من صفحة طويلة جداً`).join('\n') };
    expect(page.text.length).toBeGreaterThan(4000);
    const chunks = chunkPages([page], 1000);
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) {
      expect(chunk.characters).toBeLessThanOrEqual(1000);
      expect(chunk.from).toBe(3);
      expect(chunk.to).toBe(3);
    }
    // Nothing of the page is lost: its lines, in order.
    expect(chunks.flatMap((chunk) => chunk.pages.map((part) => part.text)).join('\n')).toBe(page.text);
  });

  it('cuts a line longer than the budget between its words, and a word longer than it anywhere', () => {
    const parts = splitText(`${'word '.repeat(100)}${'x'.repeat(250)}`, 100);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(100);
    expect(parts.join(' ').replace(/ /g, '')).toBe(`${'word'.repeat(100)}${'x'.repeat(250)}`);
  });

  it('halves a chunk into two that hold all of it', () => {
    const [chunk] = chunkPages(longDocument(4).pages, 100_000);
    const halves = halve(chunk!)!;
    expect(halves).toHaveLength(2);
    expect(halves[0]!.characters + halves[1]!.characters).toBe(chunk!.characters);
    expect(halves[0]!.from).toBe(1);
    expect(halves[1]!.to).toBe(4);
  });
});

describe('analyze: a document far over the window', () => {
  const doc = longDocument(60);
  const budget = 3000;

  it('reads every chunk — every page reaches the model — then combines in rounds into an outline', async () => {
    expect(doc.characters).toBeGreaterThan(budget * 10);
    const runner = recorder(budget, notes);
    const kept = memoryKept();
    const chunks = chunkPages(doc.pages, budget);
    const stages: string[] = [];
    const done = await analyze(chunks, doc.pageCount, runner, kept, { signal: live(), onProgress: (progress) => stages.push(progress.stage === 'reading' ? `reading ${progress.from}-${progress.to} of ${progress.pageCount}` : progress.stage) });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    // One request a chunk first, each carrying that chunk's pages whole.
    const maps = runner.asked.filter((asked) => asked.prompt.user.includes('<document>'));
    expect(maps).toHaveLength(chunks.length);
    for (const page of doc.pages) {
      expect(maps.filter((asked) => asked.prompt.user.includes(`<page number="${page.page}">\n${page.text}\n</page>`))).toHaveLength(1);
    }
    expect(maps.every((asked) => asked.brief)).toBe(true);
    // Every fact of every page is in the first level, and survives into the last.
    expect(done.analysis.levels[0]).toHaveLength(chunks.length);
    const last = done.analysis.levels.at(-1)!.map((part) => part.text).join('\n');
    for (const page of doc.pages) expect(last).toContain(`V${page.page * 7} [p. ${page.page}]`);
    expect(done.analysis.outline).toBe('OUTLINE of 60 facts');
    // The summaries cover the document from its first page to its last, in order, with no gap.
    for (const level of done.analysis.levels) {
      expect(level[0]!.from).toBe(1);
      expect(level.at(-1)!.to).toBe(60);
      for (let at = 1; at < level.length; at += 1) expect(level[at]!.from).toBe(level[at - 1]!.to + 1);
    }
    expect(stages[0]).toBe(`reading 1-${chunks[0]!.to} of 60`);
    expect(stages.at(-1)).toBe('outline');
    expect(done.made).toBe(runner.asked.length);
    expect(done.reused).toBe(0);
  });

  it('combines in more than one round when the summaries themselves are over the window', async () => {
    // Summaries as long as they are allowed to be: they do not fit one request together.
    const wordy = (prompt: Prompt) => `${notes(prompt)} ${'and more of the same. '.repeat(100)}`;
    const runner = recorder(budget, wordy);
    const chunks = chunkPages(doc.pages, budget);
    const done = await analyze(chunks, doc.pageCount, runner, memoryKept(), { signal: live() });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.analysis.levels.length).toBeGreaterThan(1);
    const limit = summaryLimit(budget);
    for (const level of done.analysis.levels) for (const part of level) expect(part.text.length).toBeLessThanOrEqual(limit);
    // Each round is smaller than the one before, and no request went over the budget.
    for (let at = 1; at < done.analysis.levels.length; at += 1) expect(done.analysis.levels[at]!.length).toBeLessThan(done.analysis.levels[at - 1]!.length);
    for (const asked of runner.asked.filter((entry) => entry.prompt.user.includes('<summaries>'))) {
      expect(/<summaries>[\s\S]*<\/summaries>/.exec(asked.prompt.user)![0].length).toBeLessThanOrEqual(budget);
    }
    expect(groupParts(done.analysis.levels[0]!, budget).length).toBeGreaterThan(1);
    // The digest is the most detailed level that fits.
    expect(digest(done.analysis, budget)).toBe(done.analysis.levels.at(-1));
  });

  it('is kept: a second analysis asks the model nothing', async () => {
    const kept = memoryKept();
    const chunks = chunkPages(doc.pages, budget);
    const first = recorder(budget, notes);
    await analyze(chunks, doc.pageCount, first, kept, { signal: live() });
    expect(await keptOutline(chunks, first, kept)).toBe('OUTLINE of 60 facts');
    const second = recorder(budget, notes);
    const again = await analyze(chunks, doc.pageCount, second, kept, { signal: live() });
    expect(second.asked).toHaveLength(0);
    expect(again.ok && again.reused).toBe(first.asked.length);
    expect(again.ok && again.made).toBe(0);
    // Another model's summaries are not taken for this one's.
    const other = { ...recorder(budget, notes), key: 'device:other' };
    expect(await keptOutline(chunks, other, kept)).toBeNull();
  });

  it('stopped half-way, it goes on from what was kept', async () => {
    const kept = memoryKept();
    const chunks = chunkPages(doc.pages, budget);
    const controller = new AbortController();
    const first = recorder(budget, (prompt, index) => {
      if (index === 3) controller.abort();
      return notes(prompt);
    });
    const stopped = await analyze(chunks, doc.pageCount, first, kept, { signal: controller.signal });
    expect(stopped).toEqual({ ok: false, failure: { kind: 'cancelled' } });
    // The request being answered when Stop came is not kept as a summary.
    expect(first.asked).toHaveLength(4);
    expect(await kept.count()).toBe(3);
    expect(await keptOutline(chunks, first, kept)).toBeNull();
    const second = recorder(budget, notes);
    const done = await analyze(chunks, doc.pageCount, second, kept, { signal: live() });
    expect(done.ok && done.reused).toBe(3);
    expect(second.asked.filter((asked) => asked.prompt.user.includes('<document>'))).toHaveLength(chunks.length - 3);
    expect(second.asked[0]!.prompt.user).toContain(`<page number="${chunks[3]!.from}">`);
  });

  it('a chunk the model counts as too long is read as two halves, not dropped', async () => {
    const chunks = chunkPages(doc.pages, budget);
    const runner = recorder(budget, (prompt) => {
      // Too large when it holds both page 1 and the chunk's last page.
      if (prompt.user.includes('<page number="1">') && prompt.user.includes(`<page number="${chunks[0]!.to}">`)) return { ok: false, failure: { kind: 'tooLarge' } };
      return notes(prompt);
    });
    const done = await analyze(chunks, doc.pageCount, runner, memoryKept(), { signal: live() });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    for (let page = 1; page <= chunks[0]!.to; page += 1) expect(done.analysis.levels[0]![0]!.text).toContain(`V${page * 7} [p. ${page}]`);
  });

  it('a failure stops it and says why', async () => {
    const runner = recorder(budget, (_, index) => (index === 2 ? { ok: false, failure: { kind: 'device', message: 'out of memory' } } : 'notes'));
    const done = await analyze(chunkPages(doc.pages, budget), doc.pageCount, runner, memoryKept(), { signal: live() });
    expect(done).toEqual({ ok: false, failure: { kind: 'device', message: 'out of memory' } });
  });
});

describe('a turn of the chat', () => {
  const options = () => ({ client, kept: memoryKept(), signal: live() });

  it('a short document goes whole, with the request', async () => {
    const doc = longDocument(2);
    const runner = recorder(8000, () => 'It is about values [p. 1].');
    expect(fitsWhole(doc, runner)).toBe(true);
    const turned = await answerTurn(doc, { kind: 'overview', text: 'Summarize the document.' }, [], runner, options());
    expect(turned).toEqual({ ok: true, answer: { text: 'It is about values [p. 1].', cutOff: false }, basis: { kind: 'whole', pageCount: 2 } });
    expect(runner.asked).toHaveLength(1);
    const { user } = runner.asked[0]!.prompt;
    for (const page of doc.pages) expect(user).toContain(`<page number="${page.page}">\n${page.text}\n</page>`);
    expect(user).toContain('This is the whole text of the 2-page document.');
    expect(user.endsWith('Request: Summarize the document.')).toBe(true);
  });

  it('"Summarize the document" on a long one is answered from all of it: every page read, then the summaries', async () => {
    const doc = longDocument(60);
    const budget = 3000;
    const runner = recorder(budget, (prompt) => (prompt.user.includes('Request:') ? 'THE SUMMARY [p. 60]' : notes(prompt)));
    const progress: string[] = [];
    const turned = await answerTurn(doc, { kind: 'overview', text: 'Summarize the document.' }, [], runner, { ...options(), onProgress: (at) => progress.push(at?.stage ?? 'end') });
    expect(turned.ok && turned.answer.text).toBe('THE SUMMARY [p. 60]');
    expect(turned.ok && turned.basis).toEqual({ kind: 'analysis', pageCount: 60 });
    const maps = runner.asked.filter((asked) => asked.prompt.user.includes('<document>'));
    expect(maps).toHaveLength(chunkPages(doc.pages, budget).length);
    for (const page of doc.pages) expect(maps.some((asked) => asked.prompt.user.includes(page.text))).toBe(true);
    // The last request is the person's, over summaries that hold a fact of the first page and of the last.
    const final = runner.asked.at(-1)!.prompt.user;
    expect(final).toContain('<summaries>');
    expect(final).not.toContain('<page number=');
    expect(final).toContain('V7 [p. 1]');
    expect(final).toContain('V420 [p. 60]');
    expect(final).toContain('The document is 60 pages, too long to give you whole');
    expect(progress[0]).toBe('reading');
    expect(progress.at(-1)).toBe('end');
  });

  it('typed in words, a request for a summary is read the same way, in Arabic or English', () => {
    for (const text of ['summarize this', 'Give me an overview', 'what is this document about?', 'key points please', 'لخّص المستند', 'ما أهم النقاط؟', 'أريد ملخصاً', 'عمّ يتحدث هذا الملف؟']) expect(asksForOverview(text), text).toBe(true);
    for (const text of ['What is the penalty in article 5?', 'كم المبلغ الإجمالي؟', 'who signed it']) expect(asksForOverview(text), text).toBe(false);
  });

  it('a question on a long document is answered from the passage on a late page', async () => {
    const doc = longDocument(60);
    const runner = recorder(3000, () => 'It is V399 [p. 57].');
    const turned = await answerTurn(doc, { kind: 'question', text: 'What is the value on page 57?' }, [], runner, options());
    expect(turned.ok && turned.basis.kind).toBe('passages');
    expect(runner.asked).toHaveLength(1);
    const { user } = runner.asked[0]!.prompt;
    expect(user).toContain('Fact 57: the value on page 57 is V399.');
    expect(user).toContain('<page number="57">');
    // Not the whole document, and not its first pages by default.
    expect(user.length).toBeLessThan(3000 + 800);
    expect(user).not.toContain('<summaries>');
    expect(user).toContain('too long to give you whole');
    expect(turned.ok && turned.basis.kind === 'passages' && turned.basis.pages).toContain(57);
    expect(turned.ok && turned.basis.kind === 'passages' && turned.basis.outline).toBe(false);
  });

  it('once the document is analyzed, a question carries its outline too', async () => {
    const doc = longDocument(60);
    const kept = memoryKept();
    const runner = recorder(3000, (prompt) => (prompt.user.includes('Request:') ? 'answer' : notes(prompt)));
    await answerTurn(doc, { kind: 'overview', text: 'Summarize the document.' }, [], runner, { client, kept, signal: live() });
    const before = runner.asked.length;
    const turned = await answerTurn(doc, { kind: 'question', text: 'What is the value on page 44?' }, [], runner, { client, kept, signal: live() });
    // The analysis is not made again: one request, the question's.
    expect(runner.asked).toHaveLength(before + 1);
    const { user } = runner.asked.at(-1)!.prompt;
    expect(user).toContain('<outline>\nOUTLINE of 60 facts\n</outline>');
    expect(user).toContain('Fact 44: the value on page 44 is V308.');
    expect(turned.ok && turned.basis.kind === 'passages' && turned.basis.outline).toBe(true);
  });

  it('a follow-up carries the earlier turn, and is searched with the question before it', async () => {
    const doc = longDocument(60);
    const runner = recorder(3000, () => 'Twice that is V798.');
    const history = [
      { role: 'user' as const, text: 'What is the value on page 57?' },
      { role: 'assistant' as const, text: 'It is V399 [p. 57].' },
    ];
    await answerTurn(doc, { kind: 'question', text: 'And twice that?' }, history, runner, options());
    const { user } = runner.asked[0]!.prompt;
    expect(user).toContain('<conversation>\nPerson: What is the value on page 57?\nAssistant: It is V399 [p. 57].\n</conversation>');
    expect(user.endsWith('Request: And twice that?')).toBe(true);
    // "And twice that?" names nothing; the passage comes by the question before it.
    expect(user).toContain('Fact 57: the value on page 57 is V399.');
    expect(searchQuery('And twice that?', history)).toBe('And twice that? What is the value on page 57?');
  });

  it('older turns are shortened to the questions asked, the last two exchanges kept as said', () => {
    const history = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 === 0 ? ('user' as const) : ('assistant' as const), text: `${index % 2 === 0 ? 'Question' : 'Answer'} ${index} ${'x'.repeat(300)}` }));
    const carried = carry(history, 1500);
    expect(carried.reduce((sum, said) => sum + said.text.length, 0)).toBeLessThanOrEqual(1500);
    expect(carried.slice(-4).map((said) => said.text.slice(0, 10))).toEqual(['Question 6', 'Answer 7 x', 'Question 8', 'Answer 9 x']);
    expect(carried.slice(0, -4).every((said) => said.role === 'user')).toBe(true);
    expect(carry(history, 0)).toEqual([]);
  });

  it('a document with no text is said to have none: the model is asked nothing', async () => {
    const runner = recorder(3000, () => 'invented');
    const scan: DocumentText = { pageCount: 3, pages: [1, 2, 3].map((page) => ({ page, text: page === 2 ? '  \n' : '' })), characters: 3 };
    expect(await answerTurn(scan, { kind: 'overview', text: 'Summarize the document.' }, [], runner, options())).toEqual({ ok: false, noText: 'document' });
    expect(await answerTurn(scan, { kind: 'question', text: 'What does it say?' }, [], runner, options())).toEqual({ ok: false, noText: 'document' });
    expect(runner.asked).toHaveLength(0);
  });

  it('a request the model counts as too large is asked again with less, not failed', async () => {
    const doc = longDocument(60);
    const sizes: number[] = [];
    const runner = recorder(3000, (prompt) => {
      sizes.push(prompt.user.length);
      return sizes.length === 1 ? { ok: false, failure: { kind: 'tooLarge' } } : 'answer';
    });
    const turned = await answerTurn(doc, { kind: 'question', text: 'What is the value on page 57?' }, [], runner, options());
    expect(turned.ok).toBe(true);
    expect(sizes).toHaveLength(2);
    expect(sizes[1]!).toBeLessThan(sizes[0]! * 0.8);
  });

  it('translates the page on screen a piece at a time, all of it, as one answer', async () => {
    const doc = longDocument(3, 40);
    const runner = recorder(3000, (prompt) => `T(${/<page number="2">\n([\s\S]*?)\n<\/page>/.exec(prompt.user)![1]!.length})`);
    const seen: string[] = [];
    const turned = await answerTurn(doc, { kind: 'translate', text: 'Translate this page into Arabic.', page: 2 }, [], runner, { ...options(), onText: (text) => seen.push(text) });
    expect(turned.ok).toBe(true);
    if (!turned.ok) return;
    expect(runner.asked.length).toBeGreaterThan(1);
    expect(turned.basis).toEqual({ kind: 'page', page: 2, parts: runner.asked.length });
    // Every character of the page went, across the pieces.
    const lengths = [...turned.answer.text.matchAll(/T\((\d+)\)/g)].map((match) => Number(match[1]));
    expect(lengths.reduce((sum, length) => sum + length, 0) + lengths.length - 1).toBe(doc.pages[1]!.text.length);
    for (const asked of runner.asked) expect(asked.prompt.user).toContain('from English into Modern Standard Arabic');
    // The answer grows piece by piece.
    expect(seen.at(-1)).toBe(turned.answer.text);
    const blank = await answerTurn({ ...doc, pages: doc.pages.map((page) => (page.page === 2 ? { page: 2, text: '' } : page)) }, { kind: 'translate', text: 't', page: 2 }, [], runner, options());
    expect(blank).toEqual({ ok: false, noText: 'page' });
  });
});
