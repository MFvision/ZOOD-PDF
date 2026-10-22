import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { TOOLS } from '../tools/tools';
import { ARTICLES, CATEGORIES, FAQ, KNOWN_ISSUES, articlesFor } from './articles';
import { fold, searchArticles, words } from './search';
import { clearLog, logText, note, recentLog } from './log';
import { RelayError, installId, relay } from './relay';
import { forgetTicket, keepMailed, readTickets, refreshTickets, sendTicket, systemFacts, ticketMail, validDraft } from './tickets';
import type { Draft } from './tickets';
import { loadIdeas, postIdea, sortIdeas, validIdea, vote } from './ideas';
import type { Idea } from './ideas';
import { LIMITS, SUPPORT } from './config';

function installStorage(): Map<string, string> {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (name: string) => items.get(name) ?? null,
      setItem: (name: string, value: string) => void items.set(name, value),
      removeItem: (name: string) => void items.delete(name),
    },
  });
  return items;
}

/** A relay that answers from a table, recording every request. */
function fakeRelay(answer: (action: string, body: Record<string, unknown> | null, url: URL) => { status?: number; json?: unknown; html?: string } | 'down') {
  const calls: { url: URL; body: Record<string, unknown> | null; headers: Record<string, string> }[] = [];
  const fetcher = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body, headers: init.headers as Record<string, string> });
    const reply = answer(url.searchParams.get('a') ?? '', body, url);
    if (reply === 'down') throw new TypeError('Failed to fetch');
    if (reply.html) return new Response(reply.html, { status: reply.status ?? 404 });
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const draft = (patch: Partial<Draft> = {}): Draft => ({ kind: 'bug', text: 'Saving fails after editing\nIt says the file is busy.', contact: '', includeLog: true, picture: null, ...patch });

describe('the help articles', () => {
  it('say everything in both languages', () => {
    for (const article of ARTICLES) {
      for (const text of [article.title, article.summary, ...article.steps, ...(article.tips ?? []), ...(article.guide?.steps.map((step) => step.say) ?? [])]) {
        expect(text.ar.trim(), article.id).not.toBe('');
        expect(text.en.trim(), article.id).not.toBe('');
        // The Arabic is Arabic.
        expect(text.ar, `${article.id}: ${text.ar}`).toMatch(/[؀-ۿ]/);
      }
    }
    for (const one of [...FAQ.flatMap((faq) => [faq.q, faq.a]), ...KNOWN_ISSUES, ...CATEGORIES.map((category) => category.title)]) {
      expect(one.ar).toMatch(/[؀-ۿ]/);
      expect(one.en.trim()).not.toBe('');
    }
  });

  it('have unique ids, real categories, and point their guides at real tools and words', () => {
    expect(new Set(ARTICLES.map((one) => one.id)).size).toBe(ARTICLES.length);
    const tools = new Set(TOOLS.map((tool) => tool.id));
    for (const article of ARTICLES) {
      expect(CATEGORIES.some((category) => category.id === article.category)).toBe(true);
      for (const step of article.guide?.steps ?? []) {
        expect(step.target || step.run, article.id).toBeTruthy();
        if (step.target?.kind === 'tool') expect(tools.has(step.target.tool), article.id).toBe(true);
        if (step.target?.kind === 'label') expect((en as Record<string, string>)[step.target.label], step.target.label).toBeTruthy();
      }
    }
  });

  it('leave out what only the desktop app has, in a browser', () => {
    expect(articlesFor(false).some((one) => one.desktopOnly)).toBe(false);
    expect(articlesFor(true).length).toBe(ARTICLES.length);
  });
});

describe('finding the answer', () => {
  it('folds Arabic spelling so the same word matches however it is written', () => {
    expect(fold('إنشاء')).toBe(fold('انشاء'));
    expect(fold('صفحة')).toBe('صفحه');
    expect(fold('مَلَفّ')).toBe('ملف');
    expect(words('كيف أدمج الملفات؟')).toEqual(['ادمج', 'ملفات']);
  });

  it('answers questions in Arabic and English with the right guide first', () => {
    const top = (question: string, lang: 'ar' | 'en' = 'en') => searchArticles(question, ARTICLES, lang)[0]?.article.id;
    expect(top('how do I merge two pdfs')).toBe('combine');
    expect(top('كيف ادمج ملفين', 'ar')).toBe('combine');
    expect(top('make the file smaller')).toBe('compress');
    expect(top('الملف حجمه كبير', 'ar')).toBe('compress');
    expect(top('كيف أوقع', 'ar')).toBe('sign');
    expect(top('convert to word')).toBe('export');
    expect(top('حول الملف الى اكسل', 'ar')).toBe('export');
    expect(top('put a password')).toBe('protect');
    expect(top('اقرا لي الملف بصوت', 'ar')).toBe('read-aloud');
    expect(top('rotate a page')).toBe('organize');
  });

  it('finds nothing for a question no guide is about', () => {
    expect(searchArticles('how is the weather', ARTICLES, 'en')).toEqual([]);
    expect(searchArticles('', ARTICLES, 'en')).toEqual([]);
  });
});

describe('the app log for a report', () => {
  beforeEach(clearLog);

  it('keeps the newest lines only, each cut short', () => {
    for (let index = 0; index < LIMITS.logLines + 30; index += 1) note('info', `line ${index}`, 0);
    expect(recentLog()).toHaveLength(LIMITS.logLines);
    expect(recentLog()[0]!.text).toBe('line 30');
    note('error', 'x'.repeat(2000), 0);
    expect(recentLog().at(-1)!.text.length).toBeLessThanOrEqual(601);
  });

  it('turns into text within the size a report may carry, newest kept', () => {
    for (let index = 0; index < 150; index += 1) note('warn', `${index} ${'y'.repeat(500)}`, 0);
    const text = logText();
    expect(text.length).toBeLessThanOrEqual(LIMITS.logChars);
    expect(text).toContain('149 ');
    expect(text).not.toContain('\n0 ');
  });
});

describe('the relay', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'localStorage'));

  it('gives every install one random number, kept', () => {
    const id = installId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(installId()).toBe(id);
  });

  it('sends JSON with the install and the app version, and no cookies', async () => {
    const { fetcher, calls } = fakeRelay(() => ({ json: { ok: true } }));
    await relay('ping', { hello: 1 }, { fetcher });
    expect(calls[0]!.url.href.startsWith(SUPPORT.relay)).toBe(true);
    expect(calls[0]!.body).toEqual({ hello: 1, install: installId() });
    expect(calls[0]!.headers['X-Zood-App']).toBeTruthy();
  });

  it('tells "not there yet" from "too many" from "refused"', async () => {
    await expect(relay('x', null, { fetcher: fakeRelay(() => 'down').fetcher })).rejects.toMatchObject({ kind: 'offline' });
    // A hosting page in place of the relay (not uploaded yet).
    await expect(relay('x', null, { fetcher: fakeRelay(() => ({ html: '<h1>404</h1>' })).fetcher })).rejects.toMatchObject({ kind: 'offline' });
    await expect(relay('x', null, { fetcher: fakeRelay(() => ({ status: 503, json: { ok: false, error: 'not set up' } })).fetcher })).rejects.toMatchObject({ kind: 'offline' });
    await expect(relay('x', null, { fetcher: fakeRelay(() => ({ status: 429, json: { ok: false, error: 'too many' } })).fetcher })).rejects.toMatchObject({ kind: 'busy' });
    await expect(relay('x', null, { fetcher: fakeRelay(() => ({ status: 400, json: { ok: false, error: 'links' } })).fetcher })).rejects.toMatchObject({ kind: 'refused', message: 'links' });
  });

  it('gives up after its timeout', async () => {
    vi.useFakeTimers();
    const fetcher = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const call = relay('ping', null, { fetcher, timeoutMs: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(call).rejects.toBeInstanceOf(RelayError);
    vi.useRealTimers();
  });
});

describe('problem reports', () => {
  beforeEach(() => {
    installStorage();
    clearLog();
  });
  afterEach(() => Reflect.deleteProperty(globalThis, 'localStorage'));

  it('need a few words, and not too many', () => {
    expect(validDraft(draft({ text: 'hi' }))).toBe(false);
    expect(validDraft(draft())).toBe(true);
    expect(validDraft(draft({ text: 'x'.repeat(LIMITS.text + 1) }))).toBe(false);
  });

  it('send what the person saw, the log only when they left it ticked, and keep the token', async () => {
    note('error', 'TypeError: busy');
    const { fetcher, calls } = fakeRelay(() => ({ json: { ok: true, id: 'abcdef0123456789', token: 'f'.repeat(32), number: 7 } }));
    const facts = systemFacts('ar', '0.5.0');
    const ticket = await sendTicket(draft(), facts, { fetcher });
    expect(calls[0]!.body).toMatchObject({ kind: 'bug', text: 'Saving fails after editing\nIt says the file is busy.', app: facts.app, lang: 'ar', picture: null });
    expect(String(calls[0]!.body!.log)).toContain('TypeError: busy');
    expect(ticket).toMatchObject({ id: 'abcdef0123456789', number: 7, status: 'open', via: 'relay', summary: 'Saving fails after editing' });
    expect(readTickets()[0]!.token).toBe('f'.repeat(32));

    await sendTicket(draft({ includeLog: false }), facts, { fetcher });
    expect(calls[1]!.body!.log).toBe('');
  });

  it('go by e-mail when the relay is not there, and are listed as sent', () => {
    const url = ticketMail(draft({ contact: '0500000000' }), systemFacts('en', '0.5.0'), 'ZOOD PDF');
    expect(url.startsWith(`mailto:${SUPPORT.email}?subject=`)).toBe(true);
    const body = decodeURIComponent(url.split('&body=')[1]!);
    expect(body).toContain('It says the file is busy.');
    expect(body).toContain('contact: 0500000000');
    expect(body).toContain('ZOOD PDF 0.5.0');
    const kept = keepMailed(draft());
    expect(readTickets()[0]).toEqual(kept);
    expect(kept.status).toBe('sent');
    expect(forgetTicket(kept.id)).toEqual([]);
  });

  it('come back with their status, and only this install’s tokens are asked', async () => {
    const send = fakeRelay(() => ({ json: { ok: true, id: '1111111111111111', token: 'a'.repeat(32), number: 3 } }));
    await sendTicket(draft(), systemFacts('en'), { fetcher: send.fetcher });
    keepMailed(draft());
    const status = fakeRelay(() => ({ json: { ok: true, tickets: [{ id: '1111111111111111', status: 'resolved', fixedIn: '0.5.1', reply: 'Fixed, please update.' }] } }));
    const list = await refreshTickets({ fetcher: status.fetcher });
    expect(status.calls[0]!.url.searchParams.get('tickets')).toBe(`1111111111111111:${'a'.repeat(32)}`);
    expect(status.calls[0]!.url.searchParams.get('install')).toBe(installId());
    const fixed = list.find((one) => one.id === '1111111111111111')!;
    expect(fixed).toMatchObject({ status: 'resolved', fixedIn: '0.5.1', reply: 'Fixed, please update.' });
    expect(list.find((one) => one.via === 'email')!.status).toBe('sent');
  });

  it('ask nothing when none was filed with the relay', async () => {
    keepMailed(draft());
    const { fetcher, calls } = fakeRelay(() => ({ json: { ok: true, tickets: [] } }));
    await refreshTickets({ fetcher });
    expect(calls).toHaveLength(0);
  });
});

describe('ideas', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'localStorage'));

  const idea = (patch: Partial<Idea>): Idea => ({ id: 'a', title: 'An idea', body: '', votes: 0, status: 'open', voted: false, mine: false, created: 0, ...patch });

  it('sort by votes or by date, with arrived ones last', () => {
    const list = [idea({ id: 'old', votes: 9, created: 1 }), idea({ id: 'new', votes: 2, created: 5 }), idea({ id: 'done', votes: 50, status: 'shipped', created: 3 })];
    expect(sortIdeas(list, 'top').map((one) => one.id)).toEqual(['old', 'new', 'done']);
    expect(sortIdeas(list, 'new').map((one) => one.id)).toEqual(['new', 'old', 'done']);
  });

  it('are cleaned as they arrive, so a bad answer cannot break the board', async () => {
    const { fetcher } = fakeRelay(() => ({ json: { ok: true, ideas: [{ id: 'x', title: 'T', votes: -4, status: 'weird' }, { title: 'no id' }, 7] } }));
    expect(await loadIdeas({ fetcher })).toEqual([{ id: 'x', title: 'T', body: '', votes: 0, status: 'open', voted: false, mine: false, created: 0, shippedIn: null }]);
  });

  it('post and vote with the install, nothing else', async () => {
    const { fetcher, calls } = fakeRelay((action) =>
      action === 'idea' ? { json: { ok: true, idea: { id: 'n', title: 'Dark PDF pages', votes: 1, voted: true, mine: true } } } : { json: { ok: true, votes: 5 } },
    );
    expect(validIdea('abc', '')).toBe(false);
    expect(validIdea('Dark PDF pages', '')).toBe(true);
    const posted = await postIdea(' Dark PDF pages ', '', 'en', { fetcher });
    expect(posted.mine).toBe(true);
    expect(calls[0]!.body).toEqual({ title: 'Dark PDF pages', body: '', lang: 'en', install: installId() });
    expect(await vote('n', true, { fetcher })).toBe(5);
    expect(calls[1]!.body).toEqual({ idea: 'n', on: true, install: installId() });
  });
});

describe('the words on screen', () => {
  it('are in both languages', () => {
    const keys = Object.keys(en).filter((key) => key.startsWith('support.') || key.startsWith('tour.support') || key.startsWith('prefs.support') || key.startsWith('help.'));
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) expect((ar as Record<string, string>)[key], key).toBeTruthy();
  });
});
