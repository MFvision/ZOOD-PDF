import { describe, expect, it, vi } from 'vitest';
import { applyRedactions, encryptionOf, hitsByPage, passwordOpens, removeProtection, setProtection, ALL_PERMISSIONS, type FindHit } from './redact';
import { EngineError, type EngineClient } from './engine';

function fakeEngine(impl: Partial<EngineClient>): EngineClient {
  return {
    open: vi.fn(async () => ({ json: { encrypted: false }, blobs: [] })),
    call: vi.fn(async () => ({ json: {}, blobs: [new Uint8Array([1])] })),
    callStatic: vi.fn(async () => ({ json: { encrypted: true, needsPassword: true }, blobs: [] })),
    close: vi.fn(async () => {}),
    terminate: vi.fn(),
    ...impl,
  } as EngineClient;
}

const hit = (page: number, text: string): FindHit => ({ page, kind: 'query', text, rects: [[0, 0, 1, 1]], viewRects: [[0, 0, 1, 1]] });

describe('redact services', () => {
  it('groups hits by page in page order and keeps their indices', () => {
    const g = hitsByPage([hit(2, 'a'), hit(0, 'b'), hit(2, 'c')]);
    expect(g.map((x) => x.page)).toEqual([0, 2]);
    expect(g[1]!.hits.map((h) => h.index)).toEqual([0, 2]);
  });

  it('applies through redact.apply with the /Redact marks, the extra areas and an optional font blob', async () => {
    const engine = fakeEngine({
      call: vi.fn(async () => ({ json: { report: { content: {} }, revisions: 1 }, blobs: [new Uint8Array([9])] })) as EngineClient['call'],
    });
    const font = new Uint8Array([7, 7]);
    const r = await applyRedactions(engine, new Uint8Array([1]), 'pw', { areas: [{ page: 0, rect: [1, 2, 3, 4] }], overlayText: 'محجوب' }, font);
    expect(engine.open).toHaveBeenCalledWith(expect.any(String), new Uint8Array([1]), 'pw');
    expect(engine.call).toHaveBeenCalledWith(
      expect.any(String),
      'redact.apply',
      { areas: [{ page: 0, rect: [1, 2, 3, 4] }], annotations: true, overlayText: 'محجوب' },
      [font],
    );
    expect(r.bytes).toEqual(new Uint8Array([9]));
    expect(r.revisions).toBe(1);
    expect(engine.close).toHaveBeenCalled();
  });

  it('protect.set / protect.remove carry passwords and permissions', async () => {
    const engine = fakeEngine({});
    await setProtection(engine, new Uint8Array([1]), undefined, { userPassword: 'u', ownerPassword: 'o', permissions: ALL_PERMISSIONS });
    expect(engine.call).toHaveBeenCalledWith(expect.any(String), 'protect.set', { userPassword: 'u', ownerPassword: 'o', permissions: ALL_PERMISSIONS });
    await removeProtection(engine, new Uint8Array([1]), 'o');
    expect(engine.call).toHaveBeenLastCalledWith(expect.any(String), 'protect.remove', {});
  });

  it('checks passwords with the engine (wrong password → false, other errors propagate)', async () => {
    const wrong = fakeEngine({
      open: vi.fn(async () => {
        throw new EngineError('wrong_password', 'no');
      }),
    });
    expect(await passwordOpens(wrong, new Uint8Array([1]), 'x')).toBe(false);
    const broken = fakeEngine({
      open: vi.fn(async () => {
        throw new EngineError('parse_error', 'bad');
      }),
    });
    await expect(passwordOpens(broken, new Uint8Array([1]), 'x')).rejects.toMatchObject({ code: 'parse_error' });
    expect(await encryptionOf(fakeEngine({}), new Uint8Array([1]))).toEqual({ encrypted: true, needsPassword: true });
  });
});
