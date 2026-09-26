import { describe, expect, it, vi } from 'vitest';
import { buildReport, compareText, reportFileName, reportLabels, visualDiff } from './comparer';
import type { EngineClient } from './engine';
import { createTranslator } from '../i18n';

function engine() {
  const calls: { kind: string; method?: string; params?: unknown; blobs?: Uint8Array[] }[] = [];
  const e = {
    open: vi.fn(async () => {
      calls.push({ kind: 'open' });
      return { json: {}, blobs: [] };
    }),
    close: vi.fn(async () => void calls.push({ kind: 'close' })),
    terminate: vi.fn(),
    call: vi.fn(async (_d: string, method: string, params: unknown, blobs: Uint8Array[] = []) => {
      calls.push({ kind: 'call', method, params, blobs });
      return { json: { summary: { changed: 1 }, changes: [] }, blobs: [] };
    }),
    callStatic: vi.fn(async (method: string, params: unknown, blobs: Uint8Array[] = []) => {
      calls.push({ kind: 'static', method, params, blobs });
      return { json: { width: 2, height: 1, changedPixels: 1, ratio: 0.5, boxes: [[0, 0, 1, 1]] }, blobs: [new Uint8Array([60])] };
    }),
  };
  return { e: e as unknown as EngineClient, calls };
}

describe('comparer', () => {
  it('compare.text runs on a private copy of A with B as a blob, then closes', async () => {
    const { e, calls } = engine();
    const r = await compareText(e, new Uint8Array([1]), new Uint8Array([2]), { ignoreDiacritics: true, normalizeLetters: false });
    expect(r.summary.changed).toBe(1);
    expect(calls.map((c) => c.kind)).toEqual(['open', 'call', 'close']);
    expect(calls[1]!.method).toBe('compare.text');
    expect(calls[1]!.params).toEqual({ options: { ignoreDiacritics: true, normalizeLetters: false } });
    expect(calls[1]!.blobs![0]![0]).toBe(2);
  });

  it('visual diff passes both rasters with their sizes', async () => {
    const { e, calls } = engine();
    const v = await visualDiff(e, { width: 2, height: 1, rgba: new Uint8Array(8) }, { width: 1, height: 1, rgba: new Uint8Array(4) });
    expect(v.boxes).toEqual([[0, 0, 1, 1]]);
    expect(v.overlay[0]).toBe(60);
    expect(calls[0]!.params).toEqual({ widthA: 2, heightA: 1, widthB: 1, heightB: 1, threshold: 48 });
  });

  it('report gets localised labels and overlay indices', async () => {
    const { e, calls } = engine();
    const labels = reportLabels(createTranslator('ar'));
    expect(labels.changed).toBeTruthy();
    await buildReport(e, {
      locale: 'ar',
      nameA: 'a.pdf',
      nameB: 'b.pdf',
      labels,
      text: { summary: { inserted: 0, deleted: 0, changed: 0, wordsA: 0, wordsB: 0, pagesA: 1, pagesB: 1, truncated: false }, changes: [] },
      visual: [{ page: 3, regions: 2, overlay: new Uint8Array([1]) }],
    });
    const p = calls[0]!.params as { visual: unknown[]; labels: { title: string } };
    expect(calls[0]!.method).toBe('compare.report');
    expect(p.visual).toEqual([{ page: 3, regions: 2, blob: 0 }]);
    expect(p.labels.title).toBe(labels.title);
    expect(reportFileName('عقد.pdf', 'مقارنة')).toBe('عقد-مقارنة.html');
  });
});
