import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient } from '../core/client';
import {
  LIBRARY_API,
  LIBRARY_FILES,
  MAX_FONT_BYTES,
  clearLibrary,
  dismissLibraryQuestion,
  fromLibrary,
  libraryConsent,
  libraryId,
  libraryUsage,
  parseMetadata,
  resetLibraryForTests,
  setLibraryConsent,
  subsetFor,
} from './fontLibrary';
import type { OriginalFace } from './fontMatch';

const TAJAWAL = new Uint8Array(readFileSync(new URL('../../../../tests/fonts/Tajawal-Regular.ttf', import.meta.url)));

const face = (family: string, weight = 400, italic = false): OriginalFace => ({ family, weight, italic, kind: 'sans' });

const METADATA = {
  id: 'tajawal',
  family: 'Tajawal',
  subsets: ['arabic', 'latin'],
  weights: [200, 300, 400, 500, 700, 800, 900],
  styles: ['normal'],
  license: { type: 'OFL-1.1', url: 'https://scripts.sil.org/OFL' },
  category: 'sans-serif',
};

/** The network, answered from here: every address asked is recorded. */
function stubNetwork(answers: Record<string, () => Response>): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    const answer = answers[url];
    return Promise.resolve(answer ? answer() : new Response('not found', { status: 404 }));
  });
  return asked;
}

/** Cache Storage, in memory. */
function stubCaches(): Map<string, Uint8Array> {
  const kept = new Map<string, Uint8Array>();
  const store = {
    match: (url: string | { url: string }) => {
      const body = kept.get(typeof url === 'string' ? url : url.url);
      return Promise.resolve(body ? new Response(body.slice().buffer) : undefined);
    },
    put: async (url: string, response: Response) => {
      kept.set(url, new Uint8Array(await response.arrayBuffer()));
    },
    keys: () => Promise.resolve([...kept.keys()].map((url) => ({ url }))),
  };
  vi.stubGlobal('caches', {
    open: () => Promise.resolve(store),
    delete: () => {
      kept.clear();
      return Promise.resolve(true);
    },
  });
  return kept;
}

/** The core's `font.check`, answered as the test says; what it was asked is kept. */
function stubClient(usable: (text: string) => boolean = () => true): { client: CoreClient; checks: { text: string; family: string; bytes: number }[] } {
  const checks: { text: string; family: string; bytes: number }[] = [];
  const client = {
    callStatic: (op: string, args: { text: string; family: string }, blobs: ArrayBuffer[]) => {
      expect(op).toBe('font.check');
      checks.push({ text: args.text, family: args.family, bytes: blobs[0]?.byteLength ?? 0 });
      return Promise.resolve({ result: { usable: usable(args.text) }, blobs: [] });
    },
  } as unknown as CoreClient;
  return { client, checks };
}

const FILE = `${LIBRARY_FILES}tajawal@latest/latin-400-normal.ttf`;
const answers = () => ({
  [`${LIBRARY_API}tajawal`]: () => new Response(JSON.stringify(METADATA)),
  [FILE]: () => new Response(TAJAWAL.slice().buffer),
});

beforeEach(() => {
  resetLibraryForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe('a family\'s name in an address', () => {
  it('is small letters, digits and hyphens', () => {
    expect(libraryId('Montserrat')).toBe('montserrat');
    expect(libraryId('IBM Plex Sans Arabic')).toBe('ibm-plex-sans-arabic');
    expect(libraryId('Source Sans 3')).toBe('source-sans-3');
    expect(libraryId('Noto  Naskh - Arabic')).toBe('noto-naskh-arabic');
  });

  it('is refused for anything that is not plain, and for families no open library has', () => {
    for (const hostile of ['', ' ', '../etc', 'a/b', 'a%2Fb', 'a?b=c', 'a#b', 'a.b', 'نسخ', 'x'.repeat(65), '-', 'a\nb']) {
      expect(libraryId(hostile), JSON.stringify(hostile)).toBeNull();
    }
    for (const closed of ['Arial', 'Times New Roman', 'Helvetica Neue', 'Calibri', 'Geeza Pro']) expect(libraryId(closed)).toBeNull();
    // And the families the app carries whole need no download.
    for (const bundled of ['Amiri', 'Cairo', 'Inter']) expect(libraryId(bundled)).toBeNull();
  });
});

describe('the subset a text needs', () => {
  it('follows its script', () => {
    expect(subsetFor('Family Budget')).toBe('latin');
    expect(subsetFor('Invoice فاتورة')).toBe('arabic');
    expect(subsetFor('Привет')).toBe('cyrillic');
    expect(subsetFor('Ωmega')).toBe('greek');
    expect(subsetFor('Łódź')).toBe('latin-ext');
  });
});

describe('what the library says of a family', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  it('is used only under an open licence', () => {
    expect(parseMetadata(bytes(METADATA))?.licence).toBe('OFL-1.1');
    expect(parseMetadata(bytes({ ...METADATA, license: 'Apache-2.0' }))?.licence).toBe('Apache-2.0');
    expect(parseMetadata(bytes({ ...METADATA, license: { type: 'UFL-1.0' } }))?.licence).toBe('UFL-1.0');
    for (const license of ['Proprietary', 'GPL-3.0', '', undefined, { type: 'CC-BY-NC' }]) {
      expect(parseMetadata(bytes({ ...METADATA, license }))).toBeNull();
    }
  });

  it('is nothing when it is not what was expected', () => {
    expect(parseMetadata(new TextEncoder().encode('<html>'))).toBeNull();
    expect(parseMetadata(bytes({ ...METADATA, weights: [] }))).toBeNull();
    expect(parseMetadata(bytes({ ...METADATA, weights: ['bold', 12345] }))).toBeNull();
    expect(parseMetadata(bytes({ ...METADATA, family: 7 }))).toBeNull();
    expect(parseMetadata(bytes(null))).toBeNull();
  });
});

describe('the family from the open library', () => {
  it('fetches nothing until the question is answered, and nothing at all on no', async () => {
    const asked = stubNetwork(answers());
    stubCaches();
    const { client } = stubClient();
    const pending = fromLibrary(client, face('Tajawal'), 'Meeting box');
    await Promise.resolve();
    expect(asked).toEqual([]);
    expect(libraryConsent()).toBeNull();
    setLibraryConsent(false);
    expect(await pending).toBeNull();
    expect(asked).toEqual([]);
    // Remembered: not asked again, still nothing fetched.
    expect(await fromLibrary(client, face('Tajawal'), 'Meeting box')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('closing the question is "not now": nothing fetched, and nothing remembered', async () => {
    const asked = stubNetwork(answers());
    const { client } = stubClient();
    const pending = fromLibrary(client, face('Tajawal'), 'Meeting box');
    dismissLibraryQuestion();
    expect(await pending).toBeNull();
    expect(libraryConsent()).toBeNull();
    expect(asked).toEqual([]);
  });

  it('on yes, asks the two addresses with the family\'s name only, checks the file and keeps it', async () => {
    const asked = stubNetwork(answers());
    const kept = stubCaches();
    const { client, checks } = stubClient();
    setLibraryConsent(true);
    const found = await fromLibrary(client, face('Tajawal'), 'Meeting box');
    expect(found?.name).toBe('Tajawal');
    expect(found?.bytes.byteLength).toBe(TAJAWAL.byteLength);
    expect(asked).toEqual([`${LIBRARY_API}tajawal`, FILE]);
    // Nothing of the document is in what was sent.
    for (const url of asked) expect(url).not.toMatch(/Meeting|box/);
    expect(checks.map((c) => c.family)).toEqual(['Tajawal', 'Tajawal']);
    expect(checks.at(-1)?.text).toBe('Meeting box');
    expect([...kept.keys()]).toEqual([`${LIBRARY_API}tajawal`, FILE]);
    expect(await libraryUsage()).toEqual({ bytes: kept.get(FILE)!.byteLength + kept.get(`${LIBRARY_API}tajawal`)!.byteLength, fonts: 1 });

    // The next edit asks no one.
    asked.length = 0;
    expect((await fromLibrary(client, face('Tajawal'), 'Meeting again'))?.name).toBe('Tajawal');
    expect(asked).toEqual([]);

    await clearLibrary();
    expect(await libraryUsage()).toEqual({ bytes: 0, fonts: 0 });
  });

  it('takes the nearest weight the library has, within reach, and the slant asked for', async () => {
    const medium = `${LIBRARY_FILES}tajawal@latest/latin-500-normal.ttf`;
    const light = `${LIBRARY_FILES}tajawal@latest/latin-200-normal.ttf`;
    const font = () => new Response(TAJAWAL.slice().buffer);
    const asked = stubNetwork({ ...answers(), [medium]: font, [light]: font });
    stubCaches();
    const { client } = stubClient();
    setLibraryConsent(true);
    // SemiBold is not published: Medium and Bold are as near; the lighter comes first.
    expect(await fromLibrary(client, face('Tajawal', 600), 'x')).not.toBeNull();
    expect(asked.at(-1)).toBe(medium);
    // Thin is not published either: ExtraLight is a hundred away.
    asked.length = 0;
    expect(await fromLibrary(client, face('Tajawal', 100), 'x')).not.toBeNull();
    expect(asked).toEqual([light]);
    // There is no italic, and no file is asked for one.
    asked.length = 0;
    expect(await fromLibrary(client, face('Tajawal', 400, true), 'x')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('does not take a weight too far from the one the paragraph is set in', async () => {
    const asked = stubNetwork({ [`${LIBRARY_API}tajawal`]: () => new Response(JSON.stringify({ ...METADATA, weights: [700, 900] })) });
    stubCaches();
    const { client } = stubClient();
    setLibraryConsent(true);
    // Regular is wanted and only Bold and Black exist: the closest bundled face is truer.
    expect(await fromLibrary(client, face('Tajawal', 400), 'x')).toBeNull();
    expect(asked).toEqual([`${LIBRARY_API}tajawal`]);
  });

  it('falls through when the library lacks the family, the script or an open licence', async () => {
    stubCaches();
    const { client } = stubClient();
    setLibraryConsent(true);
    stubNetwork({});
    expect(await fromLibrary(client, face('Tajawal'), 'x')).toBeNull();
    stubNetwork({ [`${LIBRARY_API}tajawal`]: () => new Response(JSON.stringify({ ...METADATA, subsets: ['arabic'] })) });
    expect(await fromLibrary(client, face('Tajawal'), 'Latin text')).toBeNull();
    await clearLibrary();
    const asked = stubNetwork({ [`${LIBRARY_API}tajawal`]: () => new Response(JSON.stringify({ ...METADATA, license: 'Proprietary' })) });
    expect(await fromLibrary(client, face('Tajawal'), 'x')).toBeNull();
    expect(asked).toEqual([`${LIBRARY_API}tajawal`]);
  });

  it('uses nothing that is not a font: a page, an oversized file, one the core refuses', async () => {
    const kept = stubCaches();
    setLibraryConsent(true);
    const meta = { [`${LIBRARY_API}tajawal`]: () => new Response(JSON.stringify(METADATA)) };
    const refused = stubClient(() => false);
    for (const body of [
      () => new Response('<!doctype html><title>jsDelivr</title>'),
      () => new Response(new Uint8Array(MAX_FONT_BYTES + 1)),
      () => new Response(TAJAWAL.slice(0, 8).buffer),
      () => new Response('gone', { status: 404 }),
    ]) {
      stubNetwork({ ...meta, [FILE]: body });
      expect(await fromLibrary(stubClient().client, face('Tajawal'), 'x')).toBeNull();
      expect(kept.has(FILE)).toBe(false);
    }
    stubNetwork({ ...meta, [FILE]: () => new Response(TAJAWAL.slice().buffer) });
    expect(await fromLibrary(refused.client, face('Tajawal'), 'x')).toBeNull();
    expect(kept.has(FILE), 'a file the core refuses is not kept').toBe(false);
  });

  it('does not draw text a kept file has no glyphs for', async () => {
    stubNetwork(answers());
    stubCaches();
    setLibraryConsent(true);
    // The file is a font (the empty text passes) but lacks this text's letters.
    const { client } = stubClient((text) => text === '' || text === 'Meeting');
    expect(await fromLibrary(client, face('Tajawal'), 'Meeting')).not.toBeNull();
    expect(await fromLibrary(client, face('Tajawal'), 'Zürich')).toBeNull();
  });

  it('asks nothing for a name that cannot be an address or a family that is not open', async () => {
    const asked = stubNetwork(answers());
    const { client } = stubClient();
    setLibraryConsent(true);
    expect(await fromLibrary(client, face('../../etc/passwd'), 'x')).toBeNull();
    expect(await fromLibrary(client, face('Arial'), 'x')).toBeNull();
    expect(asked).toEqual([]);
  });
});

/**
 * The real thing, over the network — off unless asked for:
 * `WARRAQ_NET_TESTS=1 pnpm --filter @warraq/ui test fontLibrary`.
 */
describe.skipIf(!process.env.WARRAQ_NET_TESTS)('the open library, really', () => {
  it('downloads Montserrat SemiBold, and the core reads it as that font', async () => {
    // The core itself (the WASM build, `pnpm build:core`), not a stand-in:
    // what is downloaded has to pass the same check the app puts it through.
    const root = new URL('../core-wasm/', import.meta.url);
    const core = (await import(/* @vite-ignore */ new URL('warraq_core.js', root).href)) as {
      default(options: { module_or_path: Uint8Array }): Promise<unknown>;
      call_static(op: string, args: string, blobs: Uint8Array[]): { json: string };
    };
    await core.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', root)) });
    const answers: Record<string, unknown>[] = [];
    const client = {
      callStatic: (op: string, args: unknown, blobs: ArrayBuffer[]) => {
        const result = JSON.parse(core.call_static(op, JSON.stringify(args), blobs.map((blob) => new Uint8Array(blob))).json) as Record<string, unknown>;
        answers.push(result);
        return Promise.resolve({ result, blobs: [] });
      },
    } as unknown as CoreClient;
    setLibraryConsent(true);
    const found = await fromLibrary(client, { family: 'Montserrat', weight: 600, italic: false, kind: 'sans' }, 'Family Budget');
    expect(found?.name).toBe('Montserrat');
    expect(found!.bytes.byteLength).toBeGreaterThan(10_000);
    expect(found!.bytes.byteLength).toBeLessThan(MAX_FONT_BYTES);
    // The file names itself after the variable font's default instance
    // ("Montserrat Thin") at every weight; its weight is the one asked for.
    expect(answers.at(-1)).toMatchObject({ usable: true, reason: null, weight: 600, italic: false });
    expect(String(answers.at(-1)?.family)).toMatch(/^Montserrat/);
  }, 30_000);
});
