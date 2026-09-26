import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FORM,
  buildSpec,
  describeMark,
  formFromSpec,
  looksRightToLeft,
  markPages,
  nowParts,
  numberPresets,
  previewCalls,
  applyCalls,
  listMarks,
  type MarkForm,
} from './marks';
import type { EngineClient, Reply } from './engine';

const form = (patch: Partial<MarkForm>): MarkForm => ({ ...DEFAULT_FORM, ...patch });

describe('page selection', () => {
  it('all, odd and even pages (1-based odd = indices 0, 2, …)', () => {
    expect(markPages('all', '', 5)).toEqual({ ok: true, pages: null });
    expect(markPages('odd', '', 5)).toEqual({ ok: true, pages: [0, 2, 4] });
    expect(markPages('even', '', 5)).toEqual({ ok: true, pages: [1, 3] });
    expect(markPages('even', '', 1)).toEqual({ ok: false, reason: 'empty' });
  });

  it('custom ranges accept Arabic-Indic digits and the Arabic comma', () => {
    expect(markPages('custom', '١-٢، ٤', 5)).toEqual({ ok: true, pages: [0, 1, 3] });
    expect(markPages('custom', '2, 2, 1', 5)).toEqual({ ok: true, pages: [0, 1] });
    expect(markPages('custom', '٩', 5)).toMatchObject({ ok: false, reason: 'outOfRange' });
    expect(markPages('custom', '', 5)).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('building the engine model', () => {
  const ctx = { pageCount: 9, fileName: 'تقرير.pdf', now: new Date(2026, 8, 26, 14, 30), locale: 'ar' as const };

  it('an Arabic diagonal watermark at 30 %', () => {
    const r = buildSpec(form({ tab: 'watermark', text: 'سري للغاية', diagonal: true, opacity: 30, color: '#c01010', font: 'amiri' }), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec).toMatchObject({ kind: 'watermark', text: 'سري للغاية', diagonal: true, opacity: 0.3, font: 'amiri', pages: null });
    expect(r.spec.color![0]).toBeCloseTo(0xc0 / 255);
    expect(r.spec.now).toEqual({ year: 2026, month: 9, day: 26, hour: 14, minute: 30 });
    expect(r.spec.fileName).toBe('تقرير.pdf');
  });

  it('a footer with slots, Arabic digits and the page range kept for editing', () => {
    const r = buildSpec(form({ tab: 'header', band: 'footer', center: 'صفحة {page} من {pages}', digits: 'arabic', rangeMode: 'custom', range: '١-٣' }), ctx);
    expect(r.ok && r.spec).toMatchObject({ kind: 'footer', slots: { start: '', center: 'صفحة {page} من {pages}', end: '' }, digits: 'arabic', lang: 'ar', pages: [0, 1, 2] });
    expect(r.ok && r.spec.ui).toMatchObject({ rangeMode: 'custom', range: '١-٣' });
  });

  it('page numbers and Bates', () => {
    const p = buildSpec(form({ tab: 'numbers', numberText: '{page}', vertical: 'top', horizontal: 'end' }), ctx);
    expect(p.ok && p.spec).toMatchObject({ kind: 'pageNumber', text: '{page}', vertical: 'top', horizontal: 'end' });
    const b = buildSpec(form({ tab: 'bates', batesPrefix: 'ZD-', batesSuffix: '', batesStart: '٧', batesDigits: '4' }), ctx);
    expect(b.ok && b.spec).toMatchObject({ kind: 'bates', bates: { prefix: 'ZD-', suffix: '', start: 7, digits: 4 } });
  });

  it('refuses empty text, a missing picture and bad numbers', () => {
    expect(buildSpec(form({ tab: 'watermark', text: '  ' }), ctx)).toEqual({ ok: false, error: 'noText' });
    expect(buildSpec(form({ tab: 'watermark', watermarkType: 'picture' }), ctx)).toEqual({ ok: false, error: 'noPicture' });
    expect(buildSpec(form({ tab: 'header', start: '', center: '', end: '' }), ctx)).toEqual({ ok: false, error: 'noText' });
    expect(buildSpec(form({ tab: 'bates', batesStart: 'x' }), ctx)).toEqual({ ok: false, error: 'badNumber' });
    expect(buildSpec(form({ tab: 'numbers', rangeMode: 'custom', range: '0' }), ctx)).toEqual({ ok: false, error: 'range', reason: 'outOfRange' });
  });

  it('a stored spec comes back as the same form (edit)', () => {
    const f = form({ tab: 'header', band: 'header', start: '{file}', end: '{hijri}', size: 11, rangeMode: 'odd', rtl: true });
    const r = buildSpec(f, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const back = formFromSpec(JSON.parse(JSON.stringify(r.spec)));
    expect(back).toMatchObject({ tab: 'header', band: 'header', start: '{file}', end: '{hijri}', size: 11, rangeMode: 'odd', rtl: true });
  });

  it('presets say «صفحة {page} من {pages}» in Arabic and "Page {page} of {pages}" in English', () => {
    expect(numberPresets('ar')).toContain('صفحة {page} من {pages}');
    expect(numberPresets('en')).toContain('Page {page} of {pages}');
  });

  it('dates are local wall-clock parts', () => {
    expect(nowParts(new Date(2026, 0, 2, 3, 4))).toEqual({ year: 2026, month: 1, day: 2, hour: 3, minute: 4 });
  });

  it('guesses the document direction from its text', () => {
    expect(looksRightToLeft('هذا نص عربي مع كلمة English')).toBe(true);
    expect(looksRightToLeft('An English page with one كلمة')).toBe(false);
    expect(looksRightToLeft('')).toBe(false);
  });
});

describe('engine calls', () => {
  const spec = { kind: 'pageNumber' as const, pages: null };

  it('preview draws on the shown page only; editing removes the old mark first', () => {
    expect(previewCalls(spec, 2)).toEqual([{ method: 'marks.add', params: { mark: spec, only: [2] }, blobs: [] }]);
    const pic = new Uint8Array([1]);
    expect(previewCalls(spec, 0, 'zm1', pic)).toEqual([
      { method: 'marks.remove', params: { id: 'zm1' } },
      { method: 'marks.add', params: { mark: spec, only: [0] }, blobs: [pic] },
    ]);
    expect(applyCalls(spec)).toEqual([{ method: 'marks.add', params: { mark: spec }, blobs: [] }]);
    expect(applyCalls(spec, 'zm1')).toEqual([{ method: 'marks.update', params: { id: 'zm1', mark: spec }, blobs: [] }]);
  });

  it('lists marks through a private engine document', async () => {
    const call = vi.fn(async () => ({ json: { marks: [{ id: 'zm1', spec, pages: [0] }], foreign: [] }, blobs: [] }) as Reply);
    const engine = { open: vi.fn(async () => {}), call, close: vi.fn(async () => {}) } as unknown as EngineClient;
    const r = await listMarks(engine, new Uint8Array([1]));
    expect(r.marks[0]!.id).toBe('zm1');
    expect(call).toHaveBeenCalledWith(expect.any(String), 'marks.list', {}, []);
  });

  it('describes marks for the list', () => {
    const t = (k: string, a?: Record<string, string | number>) => `${k}${a ? JSON.stringify(a) : ''}`;
    expect(describeMark({ kind: 'watermark', text: 'سري' }, t)).toBe('marks.kind.watermark: سري');
    expect(describeMark({ kind: 'watermark', picture: true }, t)).toBe('marks.kind.watermark: marks.picture');
    expect(describeMark({ kind: 'footer', slots: { start: '', center: '{page}', end: 'x' } }, t)).toBe('marks.kind.footer: {page} · x');
    expect(describeMark({ kind: 'bates', bates: { prefix: 'A', suffix: '', start: 1, digits: 3 } }, t)).toBe('marks.kind.bates: A001');
  });
});
