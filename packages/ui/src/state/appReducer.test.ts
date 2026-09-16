import { describe, expect, it } from 'vitest';
import { appReducer, createInitialState, PANE_MAX_WIDTH } from './appReducer';
import type { AppState, DocumentInfo } from './appReducer';
import { MAX_ZOOM, MIN_ZOOM } from './zoom';
import { sanitizePreferences } from './preferences';

const doc: DocumentInfo = {
  id: 1,
  name: 'a.pdf',
  pageCount: 3,
  pageSizes: [
    [595, 842],
    [595, 842],
    [595, 842],
  ],
  metadata: { pages: 3, encrypted: false },
};

function withDocument(): AppState {
  return appReducer(createInitialState(), { type: 'DOCUMENT_OPENED', document: doc });
}

describe('appReducer', () => {
  it('opens and closes documents', () => {
    const opened = withDocument();
    expect(opened.view).toBe('viewer');
    expect(opened.currentPage).toBe(1);
    expect(appReducer(opened, { type: 'DOCUMENT_CLOSED' }).view).toBe('home');
  });

  it('steps zoom through presets and clamps to 25–400 %', () => {
    let state: AppState = { ...withDocument(), zoom: 1, zoomMode: 'fit-width' };
    state = appReducer(state, { type: 'ZOOM_IN' });
    expect(state.zoom).toBe(1.25);
    expect(state.zoomMode).toBe('custom');
    for (let i = 0; i < 20; i += 1) state = appReducer(state, { type: 'ZOOM_IN' });
    expect(state.zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 40; i += 1) state = appReducer(state, { type: 'ZOOM_OUT' });
    expect(state.zoom).toBe(MIN_ZOOM);
    expect(appReducer(state, { type: 'SET_ZOOM', zoom: 99 }).zoom).toBe(MAX_ZOOM);
  });

  it('clamps scroll requests to the page range', () => {
    const state = appReducer(withDocument(), { type: 'SCROLL_TO_PAGE', page: 42 });
    expect(state.currentPage).toBe(3);
    expect(state.scrollRequest?.page).toBe(3);
    expect(appReducer(createInitialState(), { type: 'SCROLL_TO_PAGE', page: 2 }).scrollRequest).toBeNull();
  });

  it('cycles through find results', () => {
    let state = appReducer(withDocument(), { type: 'FIND_RESULTS', matches: [0, 2] });
    expect(state.find.cursor).toBe(0);
    expect(state.currentPage).toBe(1);
    state = appReducer(state, { type: 'FIND_STEP', delta: 1 });
    expect(state.currentPage).toBe(3);
    state = appReducer(state, { type: 'FIND_STEP', delta: 1 });
    expect(state.currentPage).toBe(1);
  });

  it('toggles panes and clamps widths', () => {
    let state = createInitialState({ leftPaneOpen: false, rightPaneWidth: 5000 });
    expect(state.leftPane.open).toBe(false);
    expect(state.rightPane.width).toBe(PANE_MAX_WIDTH);
    state = appReducer(state, { type: 'TOGGLE_LEFT_PANE' });
    expect(state.leftPane.open).toBe(true);
    expect(appReducer(state, { type: 'SET_LEFT_WIDTH', width: 10 }).leftPane.width).toBe(160);
  });
});

describe('sanitizePreferences', () => {
  it('drops invalid stored values', () => {
    expect(sanitizePreferences({ lang: 'xx', theme: 'dark', leftPaneWidth: -3, leftTab: 'layers' })).toEqual({
      lang: undefined,
      theme: 'dark',
      leftPaneOpen: undefined,
      leftPaneWidth: undefined,
      leftTab: 'layers',
      rightPaneOpen: undefined,
      rightPaneWidth: undefined,
    });
    expect(sanitizePreferences('garbage')).toEqual({});
  });
});
