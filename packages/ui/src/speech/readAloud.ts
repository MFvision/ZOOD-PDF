import { useSyncExternalStore } from 'react';
import type { TextLineData } from '../core/types';
import type { PageBox } from '../embed/embedControl';
import { readJson, writeJson } from '../state/preferences';
import { pageText, sentenceBoxes, splitSentences } from './sentences';
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
  notice: 'unsupported' | 'noVoices' | 'noText' | 'noSelection' | 'done' | null;
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
  const rate = typeof raw.rate === 'number' && raw.rate >= 0.5 && raw.rate <= 2 ? raw.rate : 1;
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
  ...savedSettings(),
};

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
  const clamped = Math.min(2, Math.max(0.5, rate));
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
  stop();
  set({ open: false, notice: null });
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

/** Reads one sentence; resolves when it ends, rejects when the engine fails on it. */
function speak(engine: SpeechEngine, sentence: Sentence, fallback: VoiceLang): Promise<void> {
  const lang: VoiceLang = sentence.lang === 'other' ? fallback : sentence.lang;
  const voice = pickVoice(state.voices, lang, lang === 'ar' ? state.voiceAr : state.voiceEn);
  return engine.speak(sentence.text, voice, lang === 'ar' ? 'ar-SA' : 'en-US', state.rate);
}

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
      for (const sentence of sentences) {
        if (!alive()) return;
        set({ sentence });
        await speak(engine, sentence, fallback);
      }
    } else {
      const last = scope === 'page' ? next.currentPage : next.pageCount;
      let read = 0;
      for (let page = next.currentPage; page <= last; page += 1) {
        if (!alive()) return;
        const lines = await next.lines(page - 1);
        if (!alive()) return;
        const sentences = splitSentences(pageText(lines));
        if (sentences.length === 0) continue;
        const fallback = mainLanguage(sentences);
        set({ page });
        if (page !== next.currentPage) next.goToPage(page);
        for (const sentence of sentences) {
          if (!alive()) return;
          set({ sentence, boxes: { page: page - 1, rects: sentenceBoxes(lines, sentence) } });
          await speak(engine, sentence, fallback);
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
      set({ notice: 'noVoices' });
    }
  }
}
