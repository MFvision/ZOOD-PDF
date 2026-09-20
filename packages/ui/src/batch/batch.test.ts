import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { translate } from '../i18n/messages';
import type { TKey, TParams } from '../i18n/messages';
import { deleteAction, readActions, saveAction, sanitizeActions, sequenceOf } from './actions';
import { cleanSuffix, resultName, uniqueName, zipFolder, zipResults } from './names';
import { choosePages, parseList, sanitizeChoice } from './pages';
import { runBatch } from './run';
import type { BatchInput, FileState } from './run';
import { STEPS, findStep, sequenceProblem } from './steps';
import type { SequenceStep, StepContext } from './steps';

describe('which pages a step works on', () => {
  it('reads a list against each file, cutting a range at its last page', () => {
    expect(choosePages({ which: 'list', list: '1-3, 5, 8-' }, 10)).toEqual([0, 1, 2, 4, 7, 8, 9]);
    expect(choosePages({ which: 'list', list: '1-3, 5, 8-' }, 2)).toEqual([0, 1]);
    expect(choosePages({ which: 'list', list: '٢، ٤–٥' }, 6)).toEqual([1, 3, 4]);
    expect(choosePages({ which: 'odd', list: '' }, 5)).toEqual([0, 2, 4]);
    expect(choosePages({ which: 'even', list: '' }, 5)).toEqual([1, 3]);
    expect(choosePages({ which: 'all', list: '' }, 3)).toEqual([0, 1, 2]);
  });

  it('refuses what does not read as pages', () => {
    for (const bad of ['', 'abc', '0', '5-2', '1-2-3', '-']) expect(parseList(bad), bad).toBeNull();
    expect(choosePages({ which: 'list', list: 'x' }, 3)).toBeNull();
    expect(sanitizeChoice({ which: 'nonsense', list: 42 })).toEqual({ which: 'all', list: '' });
  });
});

describe("the results' names", () => {
  it('keep the original, add the suffix and take the new extension', () => {
    expect(resultName('تقرير.pdf', '-معالج', 'pdf')).toBe('تقرير-معالج.pdf');
    expect(resultName('Report.PDF', '-processed', 'docx')).toBe('Report-processed.docx');
    expect(cleanSuffix('../x:y')).toBe('..xy');
  });

  it('never take a name twice, whatever its case', () => {
    const taken = new Set<string>();
    expect(uniqueName('a.pdf', taken)).toBe('a.pdf');
    expect(uniqueName('A.pdf', taken)).toBe('A (2).pdf');
    expect(uniqueName('a.pdf', taken)).toBe('a (3).pdf');
  });

  it('keep a folder\'s subfolders in the zip, and nothing that climbs out', () => {
    expect(zipFolder('invoices/2026/a.pdf')).toBe('invoices/2026/');
    expect(zipFolder('../../etc/a.pdf')).toBe('etc/');
    expect(zipFolder(undefined)).toBe('');
    const zip = zipResults([
      { path: 'a-processed.pdf', bytes: new Uint8Array([37, 80, 68, 70]) },
      { path: 'sub/b-processed.txt', bytes: new TextEncoder().encode('نص') },
    ]);
    const back = unzipSync(zip);
    expect(Object.keys(back).sort()).toEqual(['a-processed.pdf', 'sub/b-processed.txt']);
    expect(new TextDecoder().decode(back['sub/b-processed.txt'])).toBe('نص');
  });
});

describe('a sequence', () => {
  const step = (id: string, options?: unknown): SequenceStep => {
    const definition = findStep(id)!;
    return { key: Math.random(), id: definition.id, options: options ?? definition.defaults() };
  };

  it('offers every step with its name in both languages', () => {
    for (const s of STEPS) {
      expect(translate('en', s.labelKey), s.id).not.toBe(s.labelKey);
      expect(translate('ar', s.noteKey), s.id).not.toBe(s.noteKey);
    }
  });

  it('says what stops it from running', () => {
    expect(sequenceProblem([])?.key).toBe('batch.problem.noSteps');
    expect(sequenceProblem([step('export'), step('compress')])).toEqual({ index: 0, key: 'batch.problem.exportLast' });
    expect(sequenceProblem([step('compress'), step('protect')])).toEqual({ index: 1, key: 'batch.problem.password' });
    expect(sequenceProblem([step('deletePages', { pages: { which: 'all', list: '' } })])?.key).toBe('batch.problem.deleteAll');
    expect(sequenceProblem([step('rotate', { pages: { which: 'list', list: 'x' }, turn: 1 })])?.key).toBe('batch.problem.pages');
    expect(sequenceProblem([step('ocr'), step('compress'), step('export')])).toBeNull();
  });
});

/** A `localStorage` for the node test environment. */
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

describe('saved actions', () => {
  let items: Map<string, string>;
  beforeEach(() => {
    items = installStorage();
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('are kept on this device without their passwords, and come back as they were', () => {
    const protect = { key: 1, id: 'protect' as const, options: { openPassword: 'secret-1', ownerPassword: 'secret-2', allowPrint: true, allowCopy: false, allowChange: false } };
    const compress = { key: 2, id: 'compress' as const, options: { level: 'smallest' } };
    saveAction('  للأرشيف  ', [compress, protect], 1000);
    expect(items.get('warraq.batch.actions')).not.toContain('secret');
    const [action] = readActions();
    expect(action?.name).toBe('للأرشيف');
    let n = 10;
    const steps = sequenceOf(action!, () => (n += 1));
    expect(steps.map((s) => s.id)).toEqual(['compress', 'protect']);
    expect(steps[0]?.options).toEqual({ level: 'smallest' });
    expect(steps[1]?.options).toMatchObject({ openPassword: '', ownerPassword: '', allowPrint: true });
    // Saving the same name again replaces it; deleting removes it.
    saveAction('للأرشيف', [compress], 2000);
    expect(readActions()).toHaveLength(1);
    expect(deleteAction('للأرشيف')).toEqual([]);
  });

  it('read back defensively: unknown steps and damaged entries are dropped', () => {
    const actions = sanitizeActions([
      { name: 'a', steps: [{ id: 'launchMissiles', options: {} }, { id: 'compress', options: { level: 'huge' } }] },
      { name: '', steps: [{ id: 'compress' }] },
      { name: 'only unknown', steps: [{ id: 'nope' }] },
      'garbage',
      null,
    ]);
    expect(actions).toEqual([{ name: 'a', steps: [{ id: 'compress', options: { level: 'balanced' } }], savedAt: 0 }]);
    expect(sanitizeActions({ not: 'a list' })).toEqual([]);
  });
});

/** A core that knows three kinds of file: good, broken, and locked (password `pw`). */
function fakeCore(log: string[]): StepContext['client'] {
  const kind = (bytes: ArrayBuffer) => new Uint8Array(bytes)[0];
  return {
    open: async (bytes: Uint8Array | ArrayBuffer, password?: string) => {
      const first = kind(bytes instanceof ArrayBuffer ? bytes : (bytes.buffer as ArrayBuffer));
      if (first === 0) throw Object.assign(new Error('E_PARSE: not a PDF'), { code: 'E_PARSE' });
      if (first === 2 && password !== 'pw') throw Object.assign(new Error('E_PASSWORD'), { code: 'E_PASSWORD' });
      return {
        pageCount: 3,
        info: { pages: 3, encrypted: first === 2 },
        call: async (op: string, args: unknown) => {
          log.push(`${op} ${JSON.stringify(args)}`);
          return { result: {}, blobs: [] };
        },
        save: async () => new Uint8Array([first!, 9]),
        free: async () => undefined,
      } as unknown as Awaited<ReturnType<StepContext['client']['open']>>;
    },
    callStatic: async <T,>(op: string, args: unknown, blobs: ArrayBuffer[] = []) => {
      log.push(`${op} ${JSON.stringify(args)}`);
      const first = new Uint8Array(blobs[0] ?? new ArrayBuffer(1))[0];
      return { result: (op === 'compress.file' && first === 2 ? { refused: 'protected' } : {}) as T, blobs: [new Uint8Array([first!, 7]).buffer] };
    },
  };
}

describe('running a batch', () => {
  const t = (key: TKey, params?: TParams) => translate('en', key, params);
  const input = (key: number, first: number, name = `f${key}.pdf`): BatchInput => ({ key, name, read: async () => new Uint8Array([first]).buffer });
  const context = (log: string[]) => ({
    client: fakeCore(log),
    lang: 'en' as const,
    t,
    pdfium: () => Promise.reject(new Error('not used')),
    recognizer: () => Promise.reject(new Error('not used')),
  });
  const steps: SequenceStep[] = [
    { key: 1, id: 'rotate', options: { pages: { which: 'odd', list: '' }, turn: 1 } },
    { key: 2, id: 'compress', options: { level: 'balanced' } },
  ];

  it('goes on past a file that fails, and says why each one did', async () => {
    const log: string[] = [];
    const states = new Map<number, FileState>();
    const delivered: string[] = [];
    const summary = await runBatch({
      inputs: [input(1, 1), input(2, 0), input(3, 2), input(4, 1)],
      steps,
      context: context(log),
      signal: new AbortController().signal,
      onState: (key, state) => states.set(key, state),
      deliver: async (file, doc) => {
        delivered.push(`${file.name}:${doc.extension}:${new Uint8Array(doc.bytes).join(',')}`);
        return file.name;
      },
    });
    expect(summary).toEqual({ done: 2, failed: 2, cancelled: 0 });
    expect(states.get(1)).toEqual({ state: 'done', output: 'f1.pdf' });
    expect(states.get(2)).toMatchObject({ state: 'failed', key: 'batch.error.notPdf' });
    expect(states.get(3)).toMatchObject({ state: 'failed', key: 'batch.error.needsPassword' });
    // Rotated (odd pages of three), then compressed: the core's answer is the result.
    expect(log).toContain('pages.rotate {"pages":[0,2],"quarterTurns":1}');
    expect(delivered).toEqual(['f1.pdf:pdf:1,7', 'f4.pdf:pdf:1,7']);
  });

  it("tries the batch's password on a protected file, and a step can still refuse it", async () => {
    const states = new Map<number, FileState>();
    const summary = await runBatch({
      inputs: [input(1, 2)],
      steps,
      password: 'pw',
      context: context([]),
      signal: new AbortController().signal,
      onState: (key, state) => states.set(key, state),
      deliver: async (file) => file.name,
    });
    expect(summary.failed).toBe(1);
    // Compress leaves a protected file alone rather than strip its protection.
    expect(states.get(1)).toEqual({ state: 'failed', step: 1, key: 'batch.error.compressProtected', params: undefined });
  });

  it('stops after the step under way; what is left is marked as not done', async () => {
    const controller = new AbortController();
    const states = new Map<number, FileState>();
    const summary = await runBatch({
      inputs: [input(1, 1), input(2, 1), input(3, 1)],
      steps,
      context: context([]),
      signal: controller.signal,
      onState: (key, state) => states.set(key, state),
      deliver: async (file) => {
        controller.abort();
        return file.name;
      },
    });
    expect(summary).toEqual({ done: 1, failed: 0, cancelled: 2 });
    expect(states.get(3)).toEqual({ state: 'cancelled' });
  });

  it('says so when a result cannot be written, and goes on', async () => {
    const states = new Map<number, FileState>();
    const summary = await runBatch({
      inputs: [input(1, 1), input(2, 1)],
      steps,
      context: context([]),
      signal: new AbortController().signal,
      onState: (key, state) => states.set(key, state),
      deliver: async (file) => {
        if (file.key === 1) throw new Error('E_IO: disk full');
        return file.name;
      },
    });
    expect(summary).toEqual({ done: 1, failed: 1, cancelled: 0 });
    expect(states.get(1)).toMatchObject({ state: 'failed', key: 'batch.error.write', message: 'E_IO: disk full' });
  });
});
