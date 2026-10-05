import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextLineData } from '../core/types';
import { closeBar, pause, readAloudState, resume, setRate, start, stop } from './readAloud';
import type { ReadingSource } from './readAloud';

/**
 * A speech engine in memory: utterances end when `finish` is called, in
 * order, so the reading is stepped through and the store checked between.
 */
class FakeUtterance {
  text: string;
  lang = '';
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

const spoken: FakeUtterance[] = [];
let paused = 0;
let cancelled = 0;
const voices = [
  { voiceURI: 'uri:Maged', name: 'Maged', lang: 'ar-SA', localService: true, default: false },
  { voiceURI: 'uri:Ava', name: 'Ava (Premium)', lang: 'en-US', localService: true, default: false },
] as SpeechSynthesisVoice[];

beforeEach(() => {
  spoken.length = 0;
  paused = 0;
  cancelled = 0;
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => voices,
    speak: (u: FakeUtterance) => spoken.push(u),
    cancel: () => {
      cancelled += 1;
    },
    pause: () => {
      paused += 1;
    },
    resume: () => {},
  });
  stop();
});

const line = (text: string, y: number, direction: 'ltr' | 'rtl' = 'ltr'): TextLineData => ({ text, x: 50, y, width: 100, height: 10, direction });

function source(pages: TextLineData[][], currentPage = 1): ReadingSource & { closed: number; went: number[] } {
  const made = {
    closed: 0,
    went: [] as number[],
    pageCount: pages.length,
    currentPage,
    lines: async (page: number) => pages[page] ?? [],
    selection: async () => 'One. Two.',
    goToPage: (page: number) => made.went.push(page),
    close: () => {
      made.closed += 1;
    },
  };
  return made;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function finishCurrent() {
  spoken[spoken.length - 1]!.onend?.();
  await tick();
  await tick();
}

describe('read aloud', () => {
  it('reads the page sentence by sentence, in the voice of each script, marking each on the page', async () => {
    const pages = [[line('مرحبا بكم.', 10, 'rtl'), line('Hello there.', 30)]];
    const reading = start(source(pages), 'page');
    await tick();
    await tick();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.text).toBe('مرحبا بكم.');
    expect(spoken[0]!.voice?.name).toBe('Maged');
    expect(readAloudState().active).toBe(true);
    expect(readAloudState().page).toBe(1);
    expect(readAloudState().boxes).toEqual({ page: 0, rects: [{ x: 50, y: 10, width: 100, height: 10 }] });
    await finishCurrent();
    expect(spoken[1]!.text).toBe('Hello there.');
    expect(spoken[1]!.voice?.name).toBe('Ava (Premium)');
    expect(readAloudState().boxes?.rects[0]).toEqual({ x: 50, y: 30, width: 100, height: 10 });
    await finishCurrent();
    await reading;
    expect(readAloudState().active).toBe(false);
    expect(readAloudState().notice).toBe('done');
  });

  it('goes on to the next page for the whole document, and stops at the page for a page', async () => {
    const pages = [[line('A.', 10)], [line('B.', 10)]];
    const whole = source(pages);
    void start(whole, 'document');
    await tick();
    await tick();
    await finishCurrent();
    expect(spoken.map((u) => u.text)).toEqual(['A.', 'B.']);
    expect(whole.went).toEqual([2]);
    expect(readAloudState().page).toBe(2);
    stop();
    expect(whole.closed).toBeGreaterThan(0);

    spoken.length = 0;
    void start(source(pages), 'page');
    await tick();
    await tick();
    await finishCurrent();
    expect(spoken.map((u) => u.text)).toEqual(['A.']);
    expect(readAloudState().active).toBe(false);
  });

  it('pauses and resumes, and stop cancels the engine and lets the source go', async () => {
    const reading = source([[line('A. B.', 10)]]);
    void start(reading, 'page');
    await tick();
    await tick();
    pause();
    expect(paused).toBe(1);
    expect(readAloudState().paused).toBe(true);
    resume();
    expect(readAloudState().paused).toBe(false);
    stop();
    expect(cancelled).toBeGreaterThan(0);
    expect(reading.closed).toBe(1);
    expect(readAloudState().active).toBe(false);
    expect(readAloudState().boxes).toBeNull();
  });

  it('reads the selection without marks, at the chosen speed', async () => {
    setRate(1.5);
    void start(source([[]]), 'selection');
    await tick();
    await tick();
    expect(spoken[0]!.text).toBe('One.');
    expect(spoken[0]!.rate).toBe(1.5);
    expect(readAloudState().boxes).toBeNull();
    setRate(1);
  });

  it('says when there is nothing to read, and when the browser has no speech', async () => {
    await start(source([[line('   ', 10)]]), 'page');
    expect(readAloudState().notice).toBe('noText');
    vi.stubGlobal('speechSynthesis', undefined);
    await start(source([[line('A.', 10)]]), 'page');
    expect(readAloudState().notice).toBe('unsupported');
    closeBar();
    expect(readAloudState().open).toBe(false);
  });
});
