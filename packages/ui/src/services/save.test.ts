import { describe, expect, it, vi } from 'vitest';
import { rebaseOnOriginal, looksProtected, saveStrategy } from './save';
import { EngineError, type EngineClient } from './engine';

function fakeEngine(impl: Partial<EngineClient>): EngineClient {
  return {
    open: vi.fn(async () => ({ json: null, blobs: [] })),
    call: vi.fn(async () => ({ json: null, blobs: [] })),
    callStatic: vi.fn(),
    close: vi.fn(async () => {}),
    terminate: vi.fn(),
    ...impl,
  } as EngineClient;
}

describe('rebaseOnOriginal', () => {
  it('opens the ORIGINAL bytes and calls doc.rebase with PDFium bytes as a blob', async () => {
    const original = new Uint8Array([1, 2, 3]);
    const pdfium = new Uint8Array([9, 9]);
    const engine = fakeEngine({
      call: vi.fn(async (_d: string, _m: string, _p?: unknown, blobs?: Uint8Array[]) => ({
        json: { appended: 1 },
        blobs: [new Uint8Array([...original, ...(blobs?.[0] ?? [])])],
      })) as EngineClient['call'],
    });
    const res = await rebaseOnOriginal(engine, original, pdfium);
    expect(engine.open).toHaveBeenCalledWith(expect.any(String), original);
    expect(engine.call).toHaveBeenCalledWith(expect.any(String), 'doc.rebase', {}, [pdfium]);
    expect(res.mode).toBe('incremental');
    expect(Array.from(res.bytes.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(engine.close).toHaveBeenCalled();
  });

  it('propagates engine errors (never silently writes a whole file)', async () => {
    const engine = fakeEngine({
      call: vi.fn(async () => {
        throw new EngineError('parse_error', 'bad xref');
      }) as EngineClient['call'],
    });
    await expect(rebaseOnOriginal(engine, new Uint8Array([1]), new Uint8Array([2]))).rejects.toMatchObject({
      code: 'parse_error',
    });
  });

  it('only a build without an engine falls back to the PDFium rewrite, and says so', async () => {
    const engine = fakeEngine({
      open: vi.fn(async () => {
        throw new EngineError('engine_missing', 'no engine');
      }),
    });
    const res = await rebaseOnOriginal(engine, new Uint8Array([1]), new Uint8Array([2]));
    expect(res).toEqual({ bytes: new Uint8Array([2]), mode: 'rewrite', reason: 'engine_missing' });
  });
});

describe('saveStrategy', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const plain = enc('%PDF-1.7\ntrailer\n<< /Size 3 /Root 1 0 R >>\n%%EOF');
  const locked = enc('%PDF-1.7\ntrailer\n<< /Size 3 /Encrypt 5 0 R /Root 1 0 R >>\n%%EOF');

  it('is incremental for ordinary edits', () => {
    expect(saveStrategy({ original: plain, pdfium: plain, redacted: false })).toEqual({ mode: 'incremental' });
  });

  it('rewrites the whole file after redaction so no earlier revision keeps the content', () => {
    expect(saveStrategy({ original: plain, pdfium: plain, redacted: true })).toEqual({ mode: 'rewrite', reason: 'redaction' });
  });

  it('rewrites when protection is added or removed', () => {
    expect(saveStrategy({ original: plain, pdfium: locked, redacted: false }).reason).toBe('protection');
    expect(saveStrategy({ original: locked, pdfium: plain, redacted: false }).reason).toBe('protection');
  });
});

describe('looksProtected', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('detects an /Encrypt entry in the trailer', () => {
    expect(looksProtected(enc('%PDF-1.7\n...trailer\n<< /Size 9 /Encrypt 8 0 R /Root 1 0 R >>\n%%EOF'))).toBe(true);
    expect(looksProtected(enc('%PDF-1.7\n...trailer\n<< /Size 9 /Root 1 0 R >>\n%%EOF'))).toBe(false);
  });
});

// Protect: encrypted originals go through the engine with their password
describe('encrypted originals', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const plain = enc('%PDF-1.7\ntrailer\n<< /Size 3 /Root 1 0 R >>\n%%EOF');
  const locked = enc('%PDF-1.7\ntrailer\n<< /Size 3 /Encrypt 5 0 R /Root 1 0 R >>\n%%EOF');

  it('rebases even when PDFium saved the protected file decrypted (the engine re-encrypts)', () => {
    expect(saveStrategy({ original: locked, pdfium: plain, redacted: false, encrypted: true })).toEqual({ mode: 'incremental' });
  });

  it('opens the original with the password the user typed', async () => {
    const engine = fakeEngine({
      call: vi.fn(async () => ({ json: { mode: 'incremental' }, blobs: [new Uint8Array([1, 2, 3, 4])] })) as EngineClient['call'],
    });
    const original = new Uint8Array([1, 2, 3]);
    await rebaseOnOriginal(engine, original, new Uint8Array([7]), 'سر');
    expect(engine.open).toHaveBeenCalledWith(expect.any(String), original, 'سر');
  });
});
