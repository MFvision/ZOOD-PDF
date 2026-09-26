import { describe, expect, it } from 'vitest';
import { ReadAloudController, startUnitFor } from './reader';
import type { ReadingUnit, SpeakHandlers, SpeakRequest, SpeechBackend, SpeechVoice } from './types';

const AR: SpeechVoice = { id: 'ar-1', name: 'Maged', lang: 'ar-SA', quality: 'default' };
const EN: SpeechVoice = { id: 'en-1', name: 'Samantha', lang: 'en-US', quality: 'enhanced' };

function unit(page: number, index: number, runs: [ReadingUnit['lang'], string][], y = index * 50): ReadingUnit {
  return {
    page,
    index,
    text: runs.map((r) => r[1]).join(' '),
    lang: runs[0]![0],
    dir: runs[0]![0] === 'ar' ? 'rtl' : 'ltr',
    bbox: { x0: 50, y0: y, x1: 500, y1: y + 30 },
    rects: [],
    runs: runs.map(([lang, text]) => ({ lang, text, script: lang === 'ar' ? 'Arab' : lang === 'en' ? 'Latn' : 'Cyrl' })),
  };
}

class FakeBackend implements SpeechBackend {
  readonly kind = 'web' as const;
  spoken: { text: string; voice: string; rate: number }[] = [];
  current: SpeakHandlers | null = null;
  cancels = 0;
  pauses = 0;
  constructor(
    public voices: SpeechVoice[],
    private native = false,
  ) {
    if (native) {
      this.pause = () => void this.pauses++;
      this.resume = () => undefined;
    }
  }
  pause?: () => void;
  resume?: () => void;
  async listVoices() {
    return this.voices;
  }
  onVoicesChanged() {
    return () => {};
  }
  speak(req: SpeakRequest, on: SpeakHandlers) {
    this.spoken.push({ text: req.text, voice: req.voice.id, rate: req.rate });
    this.current = on;
    on.start();
  }
  cancel() {
    this.cancels++;
    this.current = null;
  }
  /** Finishes the current utterance. */
  end() {
    const c = this.current;
    this.current = null;
    c?.end();
  }
  fail(reason: string) {
    const c = this.current;
    this.current = null;
    c?.error(reason);
  }
}

function setup(units: ReadingUnit[], voices = [AR, EN], native = false) {
  const backend = new FakeBackend(voices, native);
  const prefs = { voices: {} as Record<string, string>, rate: 1.25, pitch: 1 };
  const reader = new ReadAloudController({ backend, voices, prefs });
  reader.load(units);
  const states: string[] = [];
  reader.subscribe((s) => states.push(`${s.status}:${s.unit}`));
  return { backend, reader, prefs, states };
}

const DOC = [
  unit(0, 0, [['ar', 'مقدمة التقرير']]),
  unit(0, 1, [['en', 'The English paragraph. It has two sentences.']]),
  unit(0, 2, [
    ['ar', 'يقرأ تطبيق'],
    ['en', 'ZOOD PDF'],
    ['ar', 'هذا النص.'],
  ]),
  unit(1, 0, [['ar', 'الصفحة الثانية']]),
];

describe('read-aloud queue', () => {
  it('reads paragraphs in order, sentence by sentence, with the voice of each run', () => {
    const { backend, reader } = setup(DOC);
    reader.play(0);
    expect(reader.state).toMatchObject({ status: 'playing', unit: 0 });
    for (let i = 0; i < 20 && backend.current; i++) backend.end();
    expect(backend.spoken.map((s) => [s.voice, s.text])).toEqual([
      ['ar-1', 'مقدمة التقرير'],
      ['en-1', 'The English paragraph.'],
      ['en-1', 'It has two sentences.'],
      ['ar-1', 'يقرأ تطبيق'],
      ['en-1', 'ZOOD PDF'],
      ['ar-1', 'هذا النص.'],
      ['ar-1', 'الصفحة الثانية'],
    ]);
    expect(backend.spoken.every((s) => s.rate === 1.25)).toBe(true);
    expect(reader.state).toMatchObject({ status: 'idle', unit: -1 });
  });

  it('pauses by cancelling and resumes by repeating the sentence (web)', () => {
    const { backend, reader } = setup(DOC);
    reader.play(1);
    expect(backend.spoken.at(-1)?.text).toBe('The English paragraph.');
    reader.pause();
    expect(reader.state.status).toBe('paused');
    expect(backend.cancels).toBe(1);
    reader.resume();
    expect(reader.state).toMatchObject({ status: 'playing', unit: 1 });
    expect(backend.spoken.map((s) => s.text)).toEqual(['The English paragraph.', 'The English paragraph.']);
  });

  it('uses the engine pause when the backend has a reliable one (native)', () => {
    const { backend, reader } = setup(DOC, [AR, EN], true);
    reader.play(0);
    reader.toggle();
    expect(reader.state.status).toBe('paused');
    expect(backend.pauses).toBe(1);
    expect(backend.cancels).toBe(0);
    reader.toggle();
    expect(reader.state.status).toBe('playing');
    expect(backend.spoken).toHaveLength(1);
  });

  it('ignores events of cancelled utterances', () => {
    const { backend, reader } = setup(DOC);
    reader.play(0);
    const stale = backend.current!;
    reader.next();
    expect(reader.state.unit).toBe(1);
    stale.end();
    stale.error('interrupted');
    expect(reader.state.unit).toBe(1);
    expect(backend.spoken.map((s) => s.text)).toEqual(['مقدمة التقرير', 'The English paragraph.']);
  });

  it('next and previous jump by paragraph and clamp at the ends', () => {
    const { backend, reader } = setup(DOC);
    reader.play(0);
    reader.next();
    reader.next();
    expect(reader.state.unit).toBe(2);
    expect(backend.spoken.at(-1)?.text).toBe('يقرأ تطبيق');
    reader.previous();
    expect(reader.state.unit).toBe(1);
    reader.previous();
    reader.previous();
    expect(reader.state.unit).toBe(0);
    reader.play(3);
    reader.next();
    expect(reader.state).toMatchObject({ status: 'idle', unit: -1 });
  });

  it('skips runs with no installed voice and reports the missing language', () => {
    const { backend, reader } = setup(DOC, [EN]);
    expect(reader.missingLangs()).toEqual(['ar']);
    reader.play(0);
    expect(reader.state.unit).toBe(1);
    expect(backend.spoken[0]?.text).toBe('The English paragraph.');
  });

  it('remembers a changed voice: the current sentence restarts with it', () => {
    const AR2: SpeechVoice = { id: 'ar-2', name: 'Laila', lang: 'ar-EG', quality: 'premium' };
    const { backend, reader, prefs } = setup(DOC, [AR, AR2, EN]);
    expect(prefs.voices).toEqual({});
    reader.play(0);
    expect(backend.spoken[0]?.voice).toBe('ar-2');
    reader.setPrefs({ ...prefs, voices: { ar: 'ar-1' } });
    reader.refresh();
    expect(backend.spoken.map((s) => s.voice)).toEqual(['ar-2', 'ar-1']);
  });

  it('stops after repeated engine errors and says why', () => {
    const { backend, reader } = setup(DOC);
    reader.play(0);
    backend.fail('synthesis-failed');
    backend.fail('synthesis-failed');
    backend.fail('synthesis-failed');
    expect(reader.state.status).toBe('idle');
    expect(reader.state.error).toBe('synthesis-failed');
  });

  it('stop cancels and resets', () => {
    const { backend, reader, states } = setup(DOC);
    reader.play(2);
    reader.stop();
    expect(reader.state).toMatchObject({ status: 'idle', unit: -1 });
    expect(backend.cancels).toBeGreaterThan(0);
    expect(states.at(-1)).toBe('idle:-1');
  });
});

describe('where reading starts', () => {
  it('starts at the first paragraph of the current page', () => {
    expect(startUnitFor(DOC, { page: 1 })).toBe(3);
    expect(startUnitFor(DOC, { page: 0 })).toBe(0);
    expect(startUnitFor(DOC, { page: 5 })).toBe(0);
  });

  it('starts at the paragraph holding the selection, else the next one below it', () => {
    expect(startUnitFor(DOC, { page: 0, point: { x: 100, y: 60 } })).toBe(1);
    expect(startUnitFor(DOC, { page: 0, point: { x: 100, y: 85 } })).toBe(2);
    expect(startUnitFor(DOC, { page: 0, point: { x: 100, y: 500 } })).toBe(3);
  });
});
