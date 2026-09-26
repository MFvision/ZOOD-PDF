import { describe, expect, it, vi } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { fontUrl, groupByClause, loadFonts, messageArgs, MODES, StandardsSession, suggestedName, type Finding } from './standards';
import type { EngineClient } from './engine';
import { initialState, reducer } from './state';

const f = (rule: string, clause: string, extra: Partial<Finding> = {}): Finding => ({
  rule,
  variant: 'x',
  key: `standards.finding.${rule}.x`,
  clause,
  standard: 'ISO 19005-2:2011',
  object: '3 0 R',
  page: 0,
  params: {},
  message: 'm',
  severity: 'error',
  fixable: true,
  ...extra,
});

describe('standards service', () => {
  it('suggests <name>-<suffix>.pdf', () => {
    expect(suggestedName('report.pdf', 'PDFA-2b')).toBe('report-PDFA-2b.pdf');
    expect(suggestedName('تقرير.PDF', 'PDFX-4')).toBe('تقرير-PDFX-4.pdf');
    expect(suggestedName('.pdf', 'PDFA-1b')).toBe('document-PDFA-1b.pdf');
  });

  it('groups findings by clause in engine order', () => {
    const g = groupByClause([f('trailer-id', '6.1.3'), f('eof-marker', '6.1.3'), f('font-embedded', '6.2.11.4.1'), f('trailer-id', '6.1.3')]);
    expect(g.map((x) => x.clause)).toEqual(['6.1.3', '6.2.11.4.1']);
    expect(g[0]!.rules.map((r) => [r.rule, r.items.length])).toEqual([
      ['trailer-id', 2],
      ['eof-marker', 1],
    ]);
  });

  it('turns numeric parameters into numbers (locale digits)', () => {
    expect(messageArgs({ count: '12', font: 'Helvetica', code: '0x41', declared: '-3.5' })).toEqual({ count: 12, font: 'Helvetica', code: '0x41', declared: -3.5 });
  });

  it('bundles the 12 Liberation fonts as assets and loads only the requested ones', async () => {
    for (const fam of ['Sans', 'Serif', 'Mono']) {
      for (const style of ['Regular', 'Bold', 'Italic', 'BoldItalic']) expect(fontUrl(`Liberation${fam}-${style}`), `${fam}-${style}`).toBeTruthy();
    }
    expect(fontUrl('Symbol')).toBeUndefined();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const fonts = await loadFonts(['LiberationSans-Regular', 'LiberationSans-Regular', 'Nope'], fetchImpl as unknown as typeof fetch);
    expect(fonts).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('calls the engine with the profile, the clock and the font blobs', async () => {
    const calls: unknown[][] = [];
    const engine = {
      open: vi.fn(async () => ({ json: {}, blobs: [] })),
      close: vi.fn(async () => {}),
      call: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return { json: { ok: true }, blobs: [new Uint8Array([37, 80, 68, 70])] };
      }),
      callStatic: vi.fn(),
      terminate: vi.fn(),
    } as unknown as EngineClient;
    const s = new StandardsSession(engine);
    await s.load(new Uint8Array([1]));
    await s.validate('pdfa-2b');
    const now = new Date(Date.UTC(2026, 8, 25, 12));
    const out = await s.convert('pdfa-2u', [new Uint8Array([9])], now);
    expect(out.bytes).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(calls[0]!.slice(1, 3)).toEqual(['standards.validate', { profile: 'pdfa-2b' }]);
    expect(calls[1]![1]).toBe('standards.convert');
    expect(calls[1]![2]).toEqual({ profile: 'pdfa-2u', now: now.getTime(), tzOffsetMinutes: -now.getTimezoneOffset() });
    expect(calls[1]![3]).toEqual([new Uint8Array([9])]);
    s.close();
    expect(engine.close).toHaveBeenCalled();
  });

  it('keeps a tool panel per document in the reducer', () => {
    let s = reducer(initialState('en'), { type: 'OPEN_DOCUMENT', id: 'd', name: 'a.pdf', bytes: new Uint8Array([1]) });
    s = reducer(s, { type: 'SET_PANEL', id: 'd', panel: 'standards' });
    expect(s.documents.d!.panel).toBe('standards');
    s = reducer(s, { type: 'SET_PANEL', id: 'd', panel: undefined });
    expect(s.documents.d!.panel).toBeUndefined();
  });
});

describe('standards strings', () => {
  it('describes every mode in both languages', () => {
    for (const m of MODES) {
      for (const k of [`standards.profile.${m}`, `standards.desc.${m}`]) {
        expect(en, k).toHaveProperty([k]);
        expect(ar, k).toHaveProperty([k]);
      }
    }
  });
});
