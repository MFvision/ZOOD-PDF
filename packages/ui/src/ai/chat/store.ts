import { useSyncExternalStore } from 'react';
import type { TKey, TParams } from '../../i18n/messages';
import type { AppServices } from '../../state/AppContext';
import type { PageText } from '../budget';
import type { Failure, Prompt, ProviderId } from '../providers';
import type { Progress } from './analyze';
import { keptOutline } from './analyze';
import { analyzeDocument, answerTurn, carry, fitsWhole, searchQuery } from './answer';
import type { Ask, Basis, DocumentText } from './answer';
import { chunkPages } from './chunks';
import { getSettings } from '../../state/settings';
import { memoryFor } from '../profile/walletState';
import type { Kept } from './kept';
import { generalPrompt } from './prompts';
import type { GeneralContext, Said } from './prompts';
import type { Runner } from './runner';
import { answerLibrary, answerOpen } from './across';
import type { FileBasis, LibraryLine, Scope, SourceDoc } from './across';

/**
 * The conversations, one for each open document, kept outside React for as
 * long as the app is open: leaving the AI tool for another and coming back
 * finds the chat as it was, and an answer being written goes on being
 * written. Nothing here is saved to disk — a conversation is the person's
 * own words about their document — only the analysis is (`kept.ts`).
 */
export type Note = { key: TKey; params?: TParams };

export interface UserTurn {
  id: number;
  role: 'user';
  text: string;
}

export interface AssistantTurn {
  id: number;
  role: 'assistant';
  text: string;
  /** Being worked on; finished; stopped by the person; failed; or there was no text to read. */
  status: 'working' | 'done' | 'stopped' | 'failed' | 'noText';
  /** The model is thinking before it writes (Claude). */
  thinking: boolean;
  /** The answer stopped at its length limit, or was stopped, before its end. */
  cutOff: boolean;
  failure: Failure | null;
  noText: 'document' | 'page' | null;
  /** What the answer was made from, said under it. */
  basis: Basis | null;
  provider: ProviderId;
  model: string;
  pageCount: number;
  /** The document had to be analyzed for this request: said in a line above the answer. */
  analyzed: boolean;
  /** Asked across files (Open documents, Library): the files the answer was made from, which its citations name. */
  files?: FileBasis[] | null;
  scope?: Scope;
}

/** Something that happened in the chat that is neither side's words: an analysis finished, say. */
export interface EventTurn {
  id: number;
  role: 'event';
  note: Note;
}

export type Turn = UserTurn | AssistantTurn | EventTurn;

/** What is about to leave the device, for the person to see before it does. */
export interface Review {
  provider: ProviderId;
  destination: string;
  model: string;
  pageCount: number;
  /** Characters of text in the whole document. */
  characters: number;
  /** The document goes whole in one request; otherwise in parts, as requests need them. */
  whole: boolean;
  /** Exactly what the first request carries. */
  prompt: Prompt;
  /** Asked across files: the name of every file whose text this request carries. */
  files?: string[];
}

/** What is known of the document once it has been read here. */
export interface Known {
  pageCount: number;
  characters: number;
  /** It fits the model's window whole: no analysis is needed. */
  whole: boolean;
  /** Its analysis, with this model, is kept. */
  analyzed: boolean;
  /** No page of it has text. */
  noText: boolean;
  /** How many parts the model reads it in. */
  parts: number;
}

export interface Conversation {
  turns: Turn[];
  busy: boolean;
  /** The page being read from the file, before anything is asked of a model. */
  reading: number | null;
  progress: Progress | null;
  review: Review | null;
  known: Known | null;
  notice: Note | null;
  /** Why the analysis asked for by its button failed, in the provider's terms. */
  failure: { failure: Failure; provider: ProviderId } | null;
  /** What is typed in the input and not sent yet: kept with the conversation, so it too survives a change of tool. */
  draft: string;
}

const EMPTY: Conversation = { turns: [], busy: false, reading: null, progress: null, review: null, known: null, notice: null, failure: null, draft: '' };

/** Conversations kept at once: the open document's and a few before it. */
const KEEP = 6;

const conversations = new Map<number, Conversation>();
const controllers = new Map<number, AbortController>();
const reviews = new Map<number, (go: boolean) => void>();
/** Where the person has agreed this document's text may go, for as long as the app is open. */
const approved = new Set<string>();
const listeners = new Set<() => void>();
let ids = 0;

/**
 * Settings › AI › Keep chat history: each document's finished turns, kept on
 * this device under the file's own key (`bindChat`), and found again the
 * next time the file is opened. Off, nothing is written.
 */
const chatKeys = new Map<number, string>();

function keepChat(documentId: number, turns: readonly Turn[]): void {
  const key = chatKeys.get(documentId);
  if (!key || !getSettings().keepChats) return;
  const finished = turns.filter((turn) => turn.role !== 'assistant' || turn.status !== 'working');
  void import('./saved')
    .then(({ savedChats }) => (finished.length > 0 ? savedChats.put(key, finished) : savedChats.delete(key)))
    .catch(() => undefined);
}

/** Ties a conversation to its file, and brings back what was kept of it. */
export async function bindChat(documentId: number, key: string): Promise<void> {
  if (chatKeys.get(documentId) === key) return;
  chatKeys.set(documentId, key);
  if (!getSettings().keepChats || conversationOf(documentId).turns.length > 0) return;
  const { savedChats } = await import('./saved');
  const kept = await savedChats.get(key).catch(() => null);
  if (!kept || kept.length === 0 || conversationOf(documentId).turns.length > 0) return;
  ids = Math.max(ids, ...kept.map((turn) => turn.id));
  update(documentId, (current) => ({ ...current, turns: kept }));
}

function update(documentId: number, change: (current: Conversation) => Conversation): void {
  const before = conversations.get(documentId);
  const next = change(before ?? EMPTY);
  if (!next.busy && (next.turns !== before?.turns || before?.busy)) keepChat(documentId, next.turns);
  conversations.delete(documentId);
  conversations.set(documentId, next);
  // The oldest conversation that is not at work goes when there are too many.
  for (const [id, conversation] of conversations) {
    if (conversations.size <= KEEP) break;
    if (id !== documentId && !conversation.busy) conversations.delete(id);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function conversationOf(documentId: number | null): Conversation {
  return documentId === null ? EMPTY : (conversations.get(documentId) ?? EMPTY);
}

export function useConversation(documentId: number | null): Conversation {
  return useSyncExternalStore(
    subscribe,
    () => conversationOf(documentId),
    () => EMPTY,
  );
}

/** What a turn needs from the app: the open file, the core, and the model chosen in the panel. */
export interface Env {
  services: Pick<AppServices, 'client' | 'currentFileBytes' | 'documentPassword' | 'pendingRedactions'>;
  /** The model as chosen now; `sample` is some of the document's text, to measure it with. */
  makeRunner: (sample: string) => Promise<Runner>;
  kept: Kept;
  /** Every document open in the window, read (Open documents). */
  openDocuments?: (onPage: (page: number) => void, signal: AbortSignal) => Promise<SourceDoc[]>;
  /** The lines the Library's index ranks highest for a query (Library). */
  searchLibrary?: (query: string) => Promise<LibraryLine[]>;
}

/** The longest a document's text may be, a bound no document of a person's reaches. */
const READ_LIMIT = 6_000_000;

/**
 * The open document's text as it stands now, read on this device by the
 * core's own reader — logical order, Arabic the right way round — from
 * `currentFileBytes()`: the file as the person sees it, applied redactions
 * gone. The copy is opened on its own and freed after.
 */
export async function readWhole(services: Env['services'], onPage: (page: number) => void, signal: AbortSignal): Promise<DocumentText | null> {
  const bytes = await services.currentFileBytes();
  if (!bytes) return null;
  return readBytes(services.client, bytes, services.documentPassword, onPage, signal);
}

/** Any file's text, read the same way: an open tab parked behind the live one, say. */
export async function readBytes(client: Env['services']['client'], bytes: ArrayBuffer, password: string | undefined, onPage: (page: number) => void, signal: AbortSignal): Promise<DocumentText | null> {
  const doc = await client.open(bytes, password);
  try {
    const pages: PageText[] = [];
    let characters = 0;
    for (let page = 1; page <= doc.pageCount; page += 1) {
      if (signal.aborted) return null;
      onPage(page);
      const text = characters < READ_LIMIT ? await doc.extract_text(page - 1) : '';
      pages.push({ page, text });
      characters += text.length;
    }
    return { pageCount: doc.pageCount, pages, characters };
  } finally {
    void doc.free();
  }
}

/** Some of the document's text, from its middle as well as its start: what a token of it costs is measured on this. */
function sampleOf(doc: DocumentText): string {
  const texts = doc.pages.filter((page) => page.text.trim().length > 0).map((page) => page.text);
  if (texts.length === 0) return '';
  const first = texts[0] ?? '';
  const middle = texts[Math.floor(texts.length / 2)] ?? '';
  return `${first.slice(0, 3000)}\n${middle.slice(0, 3000)}`;
}

const approvalKey = (documentId: number, runner: Runner) => `${documentId}|${runner.settings.provider}|${runner.destination}|${runner.settings.model}`;

/**
 * A runner that asks first. On this device nothing leaves, so nothing is
 * asked. For Claude and a local server the first request about a document
 * waits — its destination, its model and its exact text shown — until the
 * person presses Send; after that, this document's requests to the same
 * place go without asking again, and a change of provider, model or address
 * asks again.
 */
function gated(documentId: number, runner: Runner, doc: DocumentText): Runner {
  if (runner.settings.provider === 'device') return runner;
  const key = approvalKey(documentId, runner);
  return {
    ...runner,
    run: async (prompt, options) => {
      if (!approved.has(key)) {
        const go = await new Promise<boolean>((resolve) => {
          reviews.set(documentId, resolve);
          options.signal.addEventListener('abort', () => resolve(false), { once: true });
          update(documentId, (current) => ({
            ...current,
            review: {
              provider: runner.settings.provider,
              destination: runner.destination,
              model: runner.settings.model,
              pageCount: doc.pageCount,
              characters: doc.characters,
              whole: fitsWhole(doc, runner),
              prompt,
            },
          }));
        });
        reviews.delete(documentId);
        update(documentId, (current) => ({ ...current, review: null }));
        if (!go) return { ok: false, failure: { kind: 'cancelled' } };
        approved.add(key);
      }
      return runner.run(prompt, options);
    },
  };
}

/** Sends what the review shows. */
export function approve(documentId: number): void {
  reviews.get(documentId)?.(true);
}

/** Calls the reviewed message off: nothing is sent, and its words go back into the input. */
export function discard(documentId: number): void {
  const current = conversationOf(documentId);
  // Only a message that is waiting at the review has words to hand back.
  const working = current.turns.at(-1);
  const last = working?.role === 'assistant' && working.status === 'working' ? current.turns.at(-2) : undefined;
  discarded.add(documentId);
  if (last?.role === 'user') update(documentId, (conversation) => ({ ...conversation, draft: last.text }));
  controllers.get(documentId)?.abort();
  reviews.get(documentId)?.(false);
}

const discarded = new Set<number>();

/** What is typed in the input. */
export function setDraft(documentId: number, draft: string): void {
  update(documentId, (current) => (current.draft === draft ? current : { ...current, draft }));
}

async function prepare(documentId: number, env: Env, signal: AbortSignal): Promise<{ doc: DocumentText; runner: Runner } | { note: Note } | null> {
  // Marked but not applied, a redaction still leaves its text in the file.
  if (env.services.pendingRedactions > 0) return { note: { key: 'ai.redactPending' } };
  let doc: DocumentText | null;
  try {
    doc = await readWhole(env.services, (page) => update(documentId, (current) => ({ ...current, reading: page })), signal);
  } catch {
    doc = null;
  } finally {
    update(documentId, (current) => ({ ...current, reading: null }));
  }
  if (signal.aborted) return null;
  if (!doc) return { note: { key: 'ai.readFailed' } };
  const runner = await env.makeRunner(sampleOf(doc));
  await learn(documentId, doc, runner, env.kept);
  return { doc, runner };
}

async function learn(documentId: number, doc: DocumentText, runner: Runner, kept: Kept): Promise<void> {
  const pages = doc.pages.filter((page) => page.text.trim().length > 0);
  const whole = fitsWhole(doc, runner);
  const chunks = whole ? [] : chunkPages(pages, runner.budget);
  const analyzed = !whole && (await keptOutline(chunks, runner, kept)) !== null;
  update(documentId, (current) => ({
    ...current,
    known: { pageCount: doc.pageCount, characters: doc.characters, whole, analyzed, noText: pages.length === 0, parts: chunks.length },
  }));
}

/** Reads the document to say what is known of it — its length, whether it is analyzed — without asking a model anything. */
export async function inspect(documentId: number, env: Env): Promise<void> {
  if (conversationOf(documentId).busy) return;
  const controller = new AbortController();
  try {
    await prepare(documentId, env, controller.signal);
  } catch {
    /* what is known stays unknown; asking will say why */
  }
}

function start(documentId: number): AbortController {
  const controller = new AbortController();
  controllers.set(documentId, controller);
  update(documentId, (current) => ({ ...current, busy: true, notice: null, failure: null }));
  return controller;
}

function finish(documentId: number, controller: AbortController): void {
  if (controllers.get(documentId) === controller) controllers.delete(documentId);
  update(documentId, (current) => ({ ...current, busy: false, progress: null, reading: null, review: null }));
}

function history(turns: readonly Turn[]): Said[] {
  const said: Said[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') said.push({ role: 'user', text: turn.text });
    else if (turn.role === 'assistant' && turn.text.trim().length > 0) said.push({ role: 'assistant', text: turn.text });
  }
  return said;
}

/** Sends a request into the document's chat and writes the answer into it as it comes. */
export async function ask(documentId: number, request: Ask, env: Env): Promise<void> {
  if (conversationOf(documentId).busy || request.text.trim().length === 0) return;
  const before = history(conversationOf(documentId).turns);
  const controller = start(documentId);
  const userId = (ids += 1);
  const answerId = (ids += 1);
  const patch = (change: Partial<AssistantTurn>) =>
    update(documentId, (current) => ({
      ...current,
      turns: current.turns.map((turn) => (turn.id === answerId && turn.role === 'assistant' ? { ...turn, ...change } : turn)),
    }));
  update(documentId, (current) => ({
    ...current,
    turns: [
      ...current.turns,
      { id: userId, role: 'user', text: request.text.trim() },
      { id: answerId, role: 'assistant', text: '', status: 'working', thinking: false, cutOff: false, failure: null, noText: null, basis: null, provider: 'device', model: '', pageCount: 0, analyzed: false },
    ],
  }));
  /** The message never went: both turns leave the chat. */
  const withdraw = (notice: Note | null) =>
    update(documentId, (current) => ({ ...current, notice, turns: current.turns.filter((turn) => turn.id !== userId && turn.id !== answerId) }));
  try {
    const ready = await prepare(documentId, env, controller.signal);
    if (ready === null) {
      patch({ status: 'stopped' });
      return;
    }
    if ('note' in ready) {
      withdraw(ready.note);
      update(documentId, (current) => ({ ...current, draft: request.text }));
      return;
    }
    const { doc, runner } = ready;
    patch({ provider: runner.settings.provider, model: runner.settings.model, pageCount: doc.pageCount });
    const turned = await answerTurn(doc, request, before, gated(documentId, runner, doc), {
      client: env.services.client,
      kept: env.kept,
      signal: controller.signal,
      memory: await memoryFor(runner.settings.provider),
      onText: (text, thinking) => patch({ text, thinking }),
      onProgress: (progress) => {
        update(documentId, (current) => ({ ...current, progress }));
        if (progress) patch({ analyzed: true });
      },
    });
    if (discarded.delete(documentId)) {
      withdraw(null);
      return;
    }
    if (turned.ok) {
      const stopped = controller.signal.aborted;
      patch({ text: turned.answer.text, thinking: false, cutOff: turned.answer.cutOff, basis: turned.basis, status: stopped ? 'stopped' : 'done' });
    } else if ('noText' in turned) {
      patch({ status: 'noText', noText: turned.noText });
    } else if (turned.failure.kind === 'cancelled') {
      patch({ status: 'stopped', thinking: false });
    } else {
      patch({ status: 'failed', failure: turned.failure, thinking: false });
    }
    await learn(documentId, doc, runner, env.kept).catch(() => undefined);
  } catch (error) {
    patch({ status: 'failed', failure: { kind: 'device', message: error instanceof Error ? error.message : String(error) } });
  } finally {
    discarded.delete(documentId);
    finish(documentId, controller);
  }
}

/**
 * The same asking-first as `gated`, for a request across files: the review
 * lists every file whose text the request carries. Approval holds for this
 * conversation and destination while the set of files stays the same; one
 * more file asks again.
 */
function gatedAcross(conversationId: number, runner: Runner, files: readonly SourceDoc[] | null): Runner {
  if (runner.settings.provider === 'device') return runner;
  return {
    ...runner,
    run: async (prompt, options) => {
      // The files this request really carries, by the tags its text names them in.
      const names = [...prompt.user.matchAll(/<file number="\d+" name="([^"]*)"/g)].map((match) => match[1] ?? '');
      const key = `${approvalKey(conversationId, runner)}|${[...names].sort().join('\n')}`;
      if (!approved.has(key)) {
        const go = await new Promise<boolean>((resolve) => {
          reviews.set(conversationId, resolve);
          options.signal.addEventListener('abort', () => resolve(false), { once: true });
          const sent = files?.filter((file) => names.includes(file.name.replace(/[<>"&]/g, ' '))) ?? [];
          update(conversationId, (current) => ({
            ...current,
            review: {
              provider: runner.settings.provider,
              destination: runner.destination,
              model: runner.settings.model,
              pageCount: sent.reduce((sum, file) => sum + file.doc.pageCount, 0),
              characters: sent.reduce((sum, file) => sum + file.doc.characters, 0),
              whole: false,
              prompt,
              files: names,
            },
          }));
        });
        reviews.delete(conversationId);
        update(conversationId, (current) => ({ ...current, review: null }));
        if (!go) return { ok: false, failure: { kind: 'cancelled' } };
        approved.add(key);
      }
      return runner.run(prompt, options);
    },
  };
}

/**
 * A request across files, into `conversationId`'s chat: the document's own
 * for Open documents, the Library's (`LIBRARY_CHAT`) for the Library.
 */
export async function askAcross(conversationId: number, text: string, env: Env, scope: Exclude<Scope, 'document' | 'chat'>): Promise<void> {
  if (conversationOf(conversationId).busy || text.trim().length === 0) return;
  const before = history(conversationOf(conversationId).turns);
  const controller = start(conversationId);
  const userId = (ids += 1);
  const answerId = (ids += 1);
  const patch = (change: Partial<AssistantTurn>) =>
    update(conversationId, (current) => ({
      ...current,
      turns: current.turns.map((turn) => (turn.id === answerId && turn.role === 'assistant' ? { ...turn, ...change } : turn)),
    }));
  update(conversationId, (current) => ({
    ...current,
    turns: [
      ...current.turns,
      { id: userId, role: 'user', text: text.trim() },
      { id: answerId, role: 'assistant', text: '', status: 'working', thinking: false, cutOff: false, failure: null, noText: null, basis: null, provider: 'device', model: '', pageCount: 0, analyzed: false, files: null, scope },
    ],
  }));
  const withdraw = (notice: Note | null) =>
    update(conversationId, (current) => ({ ...current, notice, turns: current.turns.filter((turn) => turn.id !== userId && turn.id !== answerId) }));
  try {
    if (scope === 'open' && env.services.pendingRedactions > 0) {
      withdraw({ key: 'ai.redactPending' });
      return;
    }
    let sources: SourceDoc[] = [];
    let lines: LibraryLine[] = [];
    if (scope === 'open') {
      sources = (await env.openDocuments?.((page) => update(conversationId, (current) => ({ ...current, reading: page })), controller.signal).catch(() => null)) ?? [];
      update(conversationId, (current) => ({ ...current, reading: null }));
      if (sources.length === 0) {
        withdraw({ key: 'ai.readFailed' });
        return;
      }
    } else {
      lines = (await env.searchLibrary?.(searchQuery(text, before)).catch(() => null)) ?? [];
    }
    if (controller.signal.aborted) {
      patch({ status: 'stopped' });
      return;
    }
    const sample = scope === 'open' ? sources.map((source) => source.doc.pages.map((page) => page.text).join('\n').slice(0, 2000)).join('\n') : lines.map((line) => line.text).join('\n');
    const runner = await env.makeRunner(sample.slice(0, 6000));
    patch({ provider: runner.settings.provider, model: runner.settings.model });
    const options = {
      client: env.services.client,
      kept: env.kept,
      signal: controller.signal,
      onText: (written: string, thinking: boolean) => patch({ text: written, thinking }),
      onProgress: (progress: Progress | null) => {
        update(conversationId, (current) => ({ ...current, progress }));
        if (progress) patch({ analyzed: true });
      },
    };
    const turned =
      scope === 'open'
        ? await answerOpen(sources, text, before, gatedAcross(conversationId, runner, sources), options)
        : await answerLibrary(lines, text, before, gatedAcross(conversationId, runner, null), options);
    if (discarded.delete(conversationId)) {
      withdraw(null);
      return;
    }
    if (turned.ok) {
      patch({ text: turned.answer.text, thinking: false, cutOff: turned.answer.cutOff, files: turned.files, status: controller.signal.aborted ? 'stopped' : 'done' });
    } else if ('noText' in turned) {
      patch({ status: 'noText', noText: 'document', text: '', files: [], scope });
    } else if (turned.failure.kind === 'cancelled') {
      patch({ status: 'stopped', thinking: false });
    } else {
      patch({ status: 'failed', failure: turned.failure, thinking: false });
    }
  } catch (error) {
    patch({ status: 'failed', failure: { kind: 'device', message: error instanceof Error ? error.message : String(error) } });
  } finally {
    discarded.delete(conversationId);
    finish(conversationId, controller);
  }
}

/**
 * The general chat: a request about anything, answered by the chosen model
 * from the conversation so far and nothing of any document. Off this device,
 * the first request waits at the review as a document's does.
 */
export async function askGeneral(conversationId: number, text: string, env: Env, context: Omit<GeneralContext, 'memory'> = {}): Promise<void> {
  if (conversationOf(conversationId).busy || text.trim().length === 0) return;
  const before = history(conversationOf(conversationId).turns);
  const controller = start(conversationId);
  const userId = (ids += 1);
  const answerId = (ids += 1);
  const patch = (change: Partial<AssistantTurn>) =>
    update(conversationId, (current) => ({
      ...current,
      turns: current.turns.map((turn) => (turn.id === answerId && turn.role === 'assistant' ? { ...turn, ...change } : turn)),
    }));
  update(conversationId, (current) => ({
    ...current,
    turns: [
      ...current.turns,
      { id: userId, role: 'user', text: text.trim() },
      { id: answerId, role: 'assistant', text: '', status: 'working', thinking: false, cutOff: false, failure: null, noText: null, basis: null, provider: 'device', model: '', pageCount: 0, analyzed: false, scope: 'chat' },
    ],
  }));
  try {
    const runner = await env.makeRunner([...before.map((said) => said.text), text].join('\n').slice(-6000));
    patch({ provider: runner.settings.provider, model: runner.settings.model });
    const memory = await memoryFor(runner.settings.provider);
    const asked = gated(conversationId, runner, { pageCount: 0, pages: [], characters: 0 });
    // Tried with the whole conversation's room first; a request the model counts as too large carries less of it.
    let scale = 1;
    for (let attempt = 0; ; attempt += 1) {
      const said = carry(before, Math.floor(runner.turnBudget * 0.6 * scale) - memory.length);
      const outcome = await asked.run(generalPrompt(said, text, { ...context, memory }), { signal: controller.signal, onText: (written, thinking) => patch({ text: written, thinking }) });
      if (discarded.delete(conversationId)) {
        update(conversationId, (current) => ({ ...current, turns: current.turns.filter((turn) => turn.id !== userId && turn.id !== answerId), draft: text }));
        return;
      }
      if (outcome.ok) {
        patch({ text: outcome.answer.text, thinking: false, cutOff: outcome.answer.cutOff, status: controller.signal.aborted ? 'stopped' : 'done' });
        return;
      }
      if (outcome.failure.kind === 'tooLarge' && attempt < 3 && before.length > 0) {
        scale *= 0.5;
        continue;
      }
      if (outcome.failure.kind === 'cancelled') patch({ status: 'stopped', thinking: false });
      else patch({ status: 'failed', failure: outcome.failure, thinking: false });
      return;
    }
  } catch (error) {
    patch({ status: 'failed', failure: { kind: 'device', message: error instanceof Error ? error.message : String(error) } });
  } finally {
    discarded.delete(conversationId);
    finish(conversationId, controller);
  }
}

/**
 * Something the chat did in the app at the person's word ("open compress"):
 * their words, and a line saying what was done, with no model asked.
 */
export function noteDone(conversationId: number, text: string, note: Note): void {
  update(conversationId, (current) => ({
    ...current,
    notice: null,
    turns: [...current.turns, { id: (ids += 1), role: 'user', text: text.trim() }, { id: (ids += 1), role: 'event', note }],
  }));
}

/** "Analyze this document": the analysis on its own, with its progress, kept for every later request. */
export async function analyzeNow(documentId: number, env: Env): Promise<void> {
  if (conversationOf(documentId).busy) return;
  const controller = start(documentId);
  const say = (note: Note) => update(documentId, (current) => ({ ...current, turns: [...current.turns, { id: (ids += 1), role: 'event', note }] }));
  try {
    const ready = await prepare(documentId, env, controller.signal);
    if (ready === null) return;
    if ('note' in ready) {
      update(documentId, (current) => ({ ...current, notice: ready.note }));
      return;
    }
    const { doc, runner } = ready;
    if (fitsWhole(doc, runner)) return;
    const analyzed = await analyzeDocument(doc, gated(documentId, runner, doc), {
      kept: env.kept,
      signal: controller.signal,
      onProgress: (progress) => update(documentId, (current) => ({ ...current, progress })),
    });
    if (discarded.delete(documentId)) return;
    if (analyzed.ok) {
      say({ key: analyzed.made === 0 ? 'ai.chat.analysisKept' : 'ai.chat.analysisDone', params: { pages: doc.pageCount, parts: analyzed.reused + analyzed.made } });
    } else if ('noText' in analyzed) {
      update(documentId, (current) => ({ ...current, notice: { key: 'ai.chat.noTextDocument' } }));
    } else if (analyzed.failure.kind === 'cancelled') {
      say({ key: 'ai.chat.analysisStopped' });
    } else {
      update(documentId, (current) => ({ ...current, failure: { failure: analyzed.failure, provider: runner.settings.provider } }));
    }
    await learn(documentId, doc, runner, env.kept).catch(() => undefined);
  } catch {
    update(documentId, (current) => ({ ...current, notice: { key: 'ai.chat.analysisFailed' } }));
  } finally {
    discarded.delete(documentId);
    finish(documentId, controller);
  }
}

/** Stops whatever is being done for this document: what was written stays, marked as stopped. */
export function stop(documentId: number): void {
  controllers.get(documentId)?.abort();
}

/** Every conversation forgotten: the ones open now that are not at work, and the ones kept on this device. */
export async function forgetAllChats(): Promise<void> {
  for (const [id, conversation] of [...conversations]) if (!conversation.busy) conversations.delete(id);
  for (const listener of listeners) listener();
  const { savedChats } = await import('./saved');
  await savedChats.clear();
}

/** A new chat about the same document: the turns go; what is known of the document, and its analysis, stay. */
export function newChat(documentId: number): void {
  stop(documentId);
  update(documentId, (current) => ({ ...current, turns: [], notice: null, failure: null }));
}

/** The chosen model changed: what was known of the document was measured with the other one. */
export function forgetKnown(documentId: number): void {
  update(documentId, (current) => ({ ...current, known: null }));
}

/** For tests: every conversation and every approval gone. */
export function resetChats(): void {
  for (const controller of controllers.values()) controller.abort();
  conversations.clear();
  controllers.clear();
  reviews.clear();
  approved.clear();
  discarded.clear();
  for (const listener of listeners) listener();
}
