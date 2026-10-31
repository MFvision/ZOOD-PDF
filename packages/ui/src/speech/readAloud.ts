import { useSyncExternalStore } from 'react';
import type { TextLineData } from '../core/types';
import type { PageBox } from '../embed/embedControl';
import { readJson, writeJson } from '../state/preferences';
import { pageText, readableLines, sentenceBoxes, splitSentences } from './sentences';
import type { Sentence } from './sentences';
import { knownEngine, speechAvailable, speechEngine } from './engines';
import type { EngineKind, SpeechEngine } from './engines';
import { pickVoice } from './voices';
import type { VoiceInfo, VoiceLang } from './voices';

/**
 * Read aloud, with the system's own voices (`engines.ts`: Apple's speech
 * engine in the Mac app, Web Speech elsewhere): the page on
 * screen, the whole document from it, or what is selected. One utterance a
 * sentence; the sentence being read is marked on the page in both views
 * (`ReadAloudHighlight`, `EmbedReadAloudHighlight`), and reading goes on
 * to the next page until the document ends or the person stops it. Each
 * sentence is read in the voice of its own script — Arabic in an Arabic
 * voice, Latin in an English one — chosen in the settings, or the best the
 * system has. Nothing leaves the device: voices that are not local are
 * never used.
 *
 * The state lives here, outside React, so the bar, the highlights and the
 * menu read one store; `useReadAloud` subscribes a component to it.
 */

export type Scope = 'page' | 'document' | 'selection';

export interface ReadAloudState {
  /** The bar is showing. */
  open: boolean;
  /** Reading, or paused in the middle of it. */
  active: boolean;
  paused: boolean;
  scope: Scope;
  /** The page being read, one-based; null while reading a selection. */
  page: number | null;
  /** The sentence being read, and its boxes on `page` (zero-based inside). */
  sentence: Sentence | null;
  boxes: { page: number; rects: PageBox[] } | null;
  rate: number;
  voices: VoiceInfo[];
  /** Which engine the voices are from, once known. */
  engine: EngineKind | null;
  /** The chosen voice for each language (its id), or null for the best installed. */
  voiceAr: string | null;
  voiceEn: string | null;
  /** What stopped the reading: no voice for the text, nothing to read, or a browser without speech. */
  notice: 'unsupported' | 'noVoices' | 'speechFailed' | 'noText' | 'noSelection' | 'done' | 'slept' | null;
  /** The sleep timer: minutes chosen, or null when reading runs to the end. */
  sleep: number | null;
}

/** What the reader reads from: the open document, as the shell provides it. */
export interface ReadingSource {
  pageCount: number;
  /** One-based page on screen. */
  currentPage: number;
  /** The lines of a page (zero-based), in logical order. */
  lines(page: number): Promise<TextLineData[]>;
  /** What is selected in the view, or null. */
  selection(): Promise<string | null>;
  /** Brings a page (one-based) into view. */
  goToPage(page: number): void;
  /** Lets go of what `lines` opened. */
  close(): void;
}

const SETTINGS = 'warraq.readAloud';

interface Saved {
  rate: number;
  voiceAr: string | null;
  voiceEn: string | null;
}

function savedSettings(): Saved {
  const raw = readJson<Partial<Saved>>(SETTINGS, {});
  const rate = typeof raw.rate === 'number' && raw.rate >= 0.5 && raw.rate <= 3 ? raw.rate : 1;
  const id = (value: unknown) => (typeof value === 'string' && value.length > 0 && value.length < 300 ? value : null);
  return { rate, voiceAr: id(raw.voiceAr), voiceEn: id(raw.voiceEn) };
}

let state: ReadAloudState = {
  open: false,
  active: false,
  paused: false,
  scope: 'page',
  page: null,
  sentence: null,
  boxes: null,
  voices: [],
  engine: null,
  notice: null,
  sleep: null,
  ...savedSettings(),
};

/** The sleep timer's choices, in minutes. */
export const SLEEP_MINUTES = [5, 15, 30, 60] as const;
let sleepTimer: ReturnType<typeof setTimeout> | undefined;

/** Stops reading after `minutes`, or never with null; choosing again starts the count again. */
export function setSleep(minutes: number | null): void {
  clearTimeout(sleepTimer);
  sleepTimer = undefined;
  const chosen = minutes !== null && SLEEP_MINUTES.includes(minutes as (typeof SLEEP_MINUTES)[number]) ? minutes : null;
  set({ sleep: chosen });
  if (chosen === null) return;
  sleepTimer = setTimeout(() => {
    sleepTimer = undefined;
    const reading = state.active;
    stop();
    set({ sleep: null, notice: reading ? 'slept' : state.notice });
  }, chosen * 60_000);
}

const listeners = new Set<() => void>();

function set(patch: Partial<ReadAloudState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function readAloudState(): ReadAloudState {
  return state;
}

export function useReadAloud(): ReadAloudState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

/* --------------------------------------------------------------- speech */

export function speechSupported(): boolean {
  return speechAvailable();
}

let voicesWatched: SpeechEngine | null = null;

/** Reads the installed voices, and again when the engine reports more. */
export function refreshVoices(): void {
  void speechEngine().then(async (engine) => {
    if (!engine) return;
    const load = () =>
      engine
        .voices()
        .then((voices) => set({ voices, engine: engine.kind }))
        .catch(() => undefined);
    await load();
    if (voicesWatched !== engine) {
      voicesWatched = engine;
      engine.watchVoices(() => void load());
    }
  });
}

export function setRate(rate: number): void {
  const clamped = Math.min(3, Math.max(0.5, rate));
  set({ rate: clamped });
  writeJson(SETTINGS, { rate: clamped, voiceAr: state.voiceAr, voiceEn: state.voiceEn });
}

export function setVoice(lang: VoiceLang, id: string | null): void {
  set(lang === 'ar' ? { voiceAr: id } : { voiceEn: id });
  writeJson(SETTINGS, { rate: state.rate, voiceAr: state.voiceAr, voiceEn: state.voiceEn });
}

/* -------------------------------------------------------------- reading */

/** The reading under way; a new one replaces it. */
let run = 0;
let source: ReadingSource | null = null;

export function openBar(): void {
  refreshVoices();
  set({ open: true, notice: speechSupported() ? null : 'unsupported' });
  void speechEngine().then((engine) => {
    if (!engine && state.open) set({ notice: 'unsupported' });
  });
}

export function closeBar(): void {
  setSleep(null);
  stop();
  set({ open: false, notice: null });
}

/** Another document on screen: what was being read, and what was said about it, stop. */
export function documentChanged(): void {
  if (state.active) stop();
  if (state.notice !== null) set({ notice: null });
}

export function stop(): void {
  run += 1;
  knownEngine()?.cancel();
  source?.close();
  source = null;
  set({ active: false, paused: false, page: null, sentence: null, boxes: null });
}

export function pause(): void {
  if (!state.active || state.paused) return;
  knownEngine()?.pause();
  set({ paused: true });
}

export function resume(): void {
  if (!state.active || !state.paused) return;
  knownEngine()?.resume();
  set({ paused: false });
}

function voiceOf(sentence: Sentence, fallback: VoiceLang) {
  const lang: VoiceLang = sentence.lang === 'other' ? fallback : sentence.lang;
  const voice = pickVoice(state.voices, lang, lang === 'ar' ? state.voiceAr : state.voiceEn);
  return { voice, tag: lang === 'ar' ? 'ar-SA' : 'en-US' };
}

/**
 * Reads one sentence; resolves when it ends, rejects when the engine fails
 * on it. The sentence after it, when there is one, is made meanwhile, so
 * a natural voice goes on without a pause.
 */
function speak(engine: SpeechEngine, sentence: Sentence, fallback: VoiceLang, after?: Sentence): Promise<void> {
  const { voice, tag } = voiceOf(sentence, fallback);
  const spoken = engine.speak(sentence.text, voice, tag, state.rate);
  if (after && engine.prepare) {
    const next = voiceOf(after, fallback);
    engine.prepare(after.text, next.voice, next.tag, state.rate);
  }
  return spoken;
}

/** A line in the voice chosen for `lang`, so the settings can be heard before reading. */
export async function sayExample(lang: VoiceLang): Promise<void> {
  const engine = await speechEngine();
  if (!engine) return;
  stop();
  const voices = state.voices.length > 0 ? state.voices : await engine.voices().catch(() => []);
  const voice = pickVoice(voices, lang, lang === 'ar' ? state.voiceAr : state.voiceEn);
  await engine.speak(EXAMPLE[lang], voice, lang === 'ar' ? 'ar-SA' : 'en-US', state.rate).catch(() => undefined);
}

/** What `sayExample` says: the kind of thing ZOOD reads and answers. */
const EXAMPLE: Record<VoiceLang, string> = {
  ar: 'مرحبًا، أنا زود. لخّصت لك العقد، وفيه ثلاث نقاط تستحق المراجعة قبل التوقيع.',
  en: 'Hi, I’m ZOOD. I summarized the contract for you, and three points are worth checking before you sign.',
};

/** The main language of a page, for sentences with no script of their own (numbers, say). */
function mainLanguage(sentences: readonly Sentence[]): VoiceLang {
  let arabic = 0;
  let latin = 0;
  for (const sentence of sentences) {
    if (sentence.lang === 'ar') arabic += sentence.text.length;
    if (sentence.lang === 'en') latin += sentence.text.length;
  }
  return arabic >= latin ? 'ar' : 'en';
}

/**
 * Starts reading from `from`: the page on screen and, with `document`, the
 * pages after it; or the selection. Whatever was being read stops.
 */
export async function start(next: ReadingSource, scope: Scope): Promise<void> {
  stop();
  const ticket = ++run;
  const engine = await speechEngine();
  if (ticket !== run) return;
  if (!engine) {
    set({ open: true, notice: 'unsupported' });
    return;
  }
  if (state.voices.length === 0 || state.engine !== engine.kind) {
    const voices = await engine.voices().catch(() => []);
    if (ticket !== run) return;
    set({ voices, engine: engine.kind });
  }
  source = next;
  set({ open: true, active: true, paused: false, scope, notice: null });
  const alive = () => ticket === run;
  try {
    if (scope === 'selection') {
      const text = await next.selection();
      if (!alive()) return;
      const sentences = splitSentences(text ?? '');
      if (sentences.length === 0) {
        stop();
        set({ notice: 'noSelection' });
        return;
      }
      const fallback = mainLanguage(sentences);
      set({ page: null, boxes: null });
      for (const [index, sentence] of sentences.entries()) {
        if (!alive()) return;
        set({ sentence });
        await speak(engine, sentence, fallback, sentences[index + 1]);
      }
    } else {
      const last = scope === 'page' ? next.currentPage : next.pageCount;
      let read = 0;
      for (let page = next.currentPage; page <= last; page += 1) {
        if (!alive()) return;
        // Headers, footers and page numbers are not read: the pages either
        // side show which lines repeat at the edges.
        const [all, before, after] = await Promise.all([
          next.lines(page - 1),
          page > 1 ? next.lines(page - 2) : Promise.resolve([]),
          page < next.pageCount ? next.lines(page) : Promise.resolve([]),
        ]);
        if (!alive()) return;
        const lines = readableLines(all, [before, after].filter((other) => other.length > 0));
        const sentences = splitSentences(pageText(lines));
        if (sentences.length === 0) continue;
        const fallback = mainLanguage(sentences);
        set({ page });
        if (page !== next.currentPage) next.goToPage(page);
        for (const [index, sentence] of sentences.entries()) {
          if (!alive()) return;
          set({ sentence, boxes: { page: page - 1, rects: sentenceBoxes(lines, sentence) } });
          await speak(engine, sentence, fallback, sentences[index + 1]);
          read += 1;
        }
      }
      if (alive() && read === 0) {
        stop();
        set({ notice: 'noText' });
        return;
      }
    }
    if (alive()) {
      stop();
      set({ notice: 'done' });
    }
  } catch {
    if (alive()) {
      stop();
      // No voice at all says so plainly; with voices there, the one speaking
      // failed, and the person can try again or choose another.
      set({ notice: state.voices.length === 0 ? 'noVoices' : 'speechFailed' });
    }
  }
}
