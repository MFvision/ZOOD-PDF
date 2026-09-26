import { describe, expect, it } from 'vitest';
import { initialState, reducer, type AppState } from './state';

const bytes = (...b: number[]) => new Uint8Array(b);

function open(state: AppState = initialState('en')): AppState {
  return reducer(state, { type: 'OPEN_DOCUMENT', id: 'd1', name: 'a.pdf', bytes: bytes(1, 2, 3) });
}

describe('app reducer', () => {
  it('opens a document as bytes and routes to it', () => {
    const s = open();
    expect(s.documents.d1?.bytes).toEqual(bytes(1, 2, 3));
    expect(s.documents.d1?.originalBytes).toEqual(bytes(1, 2, 3));
    expect(s.documents.d1?.name).toBe('a.pdf');
    expect(s.documents.d1?.warraqOwnsDocument).toBe(false);
    expect(s.documents.d1?.switching).toBe(true);
    expect(s.route).toEqual({ name: 'document', id: 'd1' });
    expect(s.order).toEqual(['d1']);
  });

  it('keeps the original bytes as a separate copy (never aliased)', () => {
    const s = open();
    expect(s.documents.d1?.originalBytes).not.toBe(s.documents.d1?.bytes);
  });

  it('marks the viewer ready only for the current revision', () => {
    let s = open();
    s = reducer(s, { type: 'VIEWER_READY', id: 'd1', revision: 0, pageCount: 4 });
    expect(s.documents.d1?.switching).toBe(false);
    expect(s.documents.d1?.pageCount).toBe(4);
    s = reducer(s, { type: 'CORE_REPLACED_BYTES', id: 'd1', bytes: bytes(9) });
    // a late "ready" from the old viewer must not clear the switch
    s = reducer(s, { type: 'VIEWER_READY', id: 'd1', revision: 0, pageCount: 4 });
    expect(s.documents.d1?.switching).toBe(true);
  });

  it('flips switching synchronously when a core tool replaces bytes', () => {
    let s = open();
    s = reducer(s, { type: 'VIEWER_READY', id: 'd1', revision: 0, pageCount: 1 });
    s = reducer(s, { type: 'CORE_REPLACED_BYTES', id: 'd1', bytes: bytes(7, 7) });
    const d = s.documents.d1!;
    expect(d.switching).toBe(true);
    expect(d.warraqOwnsDocument).toBe(true);
    expect(d.bytes).toEqual(bytes(7, 7));
    expect(d.revision).toBe(1);
    expect(d.edited).toBe(true);
    // original bytes are untouched until save
    expect(d.originalBytes).toEqual(bytes(1, 2, 3));
  });

  it('records viewer edits (EmbedPDF owns pending changes)', () => {
    let s = open();
    s = reducer(s, { type: 'CORE_REPLACED_BYTES', id: 'd1', bytes: bytes(7) });
    s = reducer(s, { type: 'VIEWER_EDITED', id: 'd1' });
    expect(s.documents.d1?.edited).toBe(true);
    expect(s.documents.d1?.warraqOwnsDocument).toBe(false);
  });

  it('after save the saved bytes become the new original and the viewer reloads', () => {
    let s = open();
    s = reducer(s, { type: 'VIEWER_EDITED', id: 'd1' });
    s = reducer(s, { type: 'SAVED', id: 'd1', bytes: bytes(1, 2, 3, 4), name: 'a.pdf' });
    const d = s.documents.d1!;
    expect(d.edited).toBe(false);
    expect(d.originalBytes).toEqual(bytes(1, 2, 3, 4));
    expect(d.bytes).toEqual(bytes(1, 2, 3, 4));
    expect(d.revision).toBe(1);
    expect(d.switching).toBe(true);
  });

  it('closes documents and goes home when none remain', () => {
    let s = open();
    s = reducer(s, { type: 'CLOSE_DOCUMENT', id: 'd1' });
    expect(s.documents.d1).toBeUndefined();
    expect(s.order).toEqual([]);
    expect(s.route).toEqual({ name: 'home', section: 'home' });
  });

  it('ignores actions for unknown documents', () => {
    const s = initialState('en');
    expect(reducer(s, { type: 'VIEWER_EDITED', id: 'nope' })).toBe(s);
    expect(reducer(s, { type: 'CORE_REPLACED_BYTES', id: 'nope', bytes: bytes(1) })).toBe(s);
  });

  it('remembers a tool picked before the document was open, until it starts', () => {
    let s = reducer(initialState('en'), { type: 'OPEN_DOCUMENT', id: 'd1', name: 'a.pdf', bytes: bytes(1), tool: 'comment' });
    expect(s.documents.d1?.pendingTool).toBe('comment');
    s = reducer(s, { type: 'TOOL_STARTED', id: 'd1' });
    expect(s.documents.d1?.pendingTool).toBeUndefined();
  });

  it('switches locale', () => {
    const s = reducer(initialState('en'), { type: 'SET_LOCALE', locale: 'ar' });
    expect(s.locale).toBe('ar');
  });

  it('queues and dismisses HUD toasts', () => {
    let s = reducer(initialState('en'), { type: 'TOAST', toast: { id: 't1', message: 'Saved' } });
    expect(s.toasts).toHaveLength(1);
    s = reducer(s, { type: 'DISMISS_TOAST', id: 't1' });
    expect(s.toasts).toHaveLength(0);
  });

  it('stores recents from IndexedDB', () => {
    const item = { id: 'r1', name: 'a.pdf', openedAt: 1, size: 3, starred: false, tags: [], hasBytes: false };
    const s = reducer(initialState('en'), { type: 'SET_RECENTS', recents: [item] });
    expect(s.recents).toEqual([item]);
  });
});

// Redact / Protect (core-backed whole rewrites)
describe('whole rewrites and passwords', () => {
  it('a whole rewrite (redaction) replaces the original, so later viewer edits never rebase on the old bytes', () => {
    let s = reducer(initialState('en'), { type: 'OPEN_DOCUMENT', id: 'd1', name: 'a.pdf', bytes: bytes(1, 2, 3), password: 'pw' });
    expect(s.documents.d1?.password).toBe('pw');
    s = reducer(s, { type: 'CORE_REPLACED_BYTES', id: 'd1', bytes: bytes(5, 5), wholeRewrite: true });
    expect(s.documents.d1?.originalBytes).toEqual(bytes(5, 5));
    expect(s.documents.d1?.originalBytes).not.toBe(s.documents.d1?.bytes);
    expect(s.documents.d1?.password).toBe('pw');
    expect(s.documents.d1?.edited).toBe(true);
  });

  it('protection changes carry the new password (null = removed)', () => {
    let s = reducer(initialState('en'), { type: 'OPEN_DOCUMENT', id: 'd1', name: 'a.pdf', bytes: bytes(1) });
    s = reducer(s, { type: 'CORE_REPLACED_BYTES', id: 'd1', bytes: bytes(2), wholeRewrite: true, password: 'new' });
    expect(s.documents.d1?.password).toBe('new');
    s = reducer(s, { type: 'CORE_REPLACED_BYTES', id: 'd1', bytes: bytes(3), wholeRewrite: true, password: null });
    expect(s.documents.d1?.password).toBeUndefined();
  });
});
