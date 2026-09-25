import { describe, expect, it, vi } from 'vitest';
import { rebaseOnOriginal, looksProtected } from './save';
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

describe('looksProtected', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('detects an /Encrypt entry in the trailer', () => {
    expect(looksProtected(enc('%PDF-1.7\n...trailer\n<< /Size 9 /Encrypt 8 0 R /Root 1 0 R >>\n%%EOF'))).toBe(true);
    expect(looksProtected(enc('%PDF-1.7\n...trailer\n<< /Size 9 /Root 1 0 R >>\n%%EOF'))).toBe(false);
  });
});
