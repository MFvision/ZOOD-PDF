import { describe, expect, it } from 'vitest';
import { appReducer, createInitialState, hasUnsavedEdits, PANE_MAX_WIDTH } from './appReducer';
import type { AppState, DocumentInfo } from './appReducer';
import { MAX_ZOOM, MIN_ZOOM } from './zoom';
import { pdfFileName } from './saveFile';
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
    expect(
      appReducer(createInitialState(), { type: 'SCROLL_TO_PAGE', page: 2 }).scrollRequest,
    ).toBeNull();
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

const entry = { page: 1, paragraphIndex: 0, before: 'قديم', after: 'جديد' };

describe('appReducer edit state', () => {
  it('enters and leaves Edit mode with the Edit tool', () => {
    let state = appReducer(withDocument(), { type: 'SET_ACTIVE_TOOL', tool: 'edit' });
    expect(state.edit.active).toBe(true);
    state = appReducer(state, { type: 'SET_ACTIVE_TOOL', tool: 'organize' });
    expect(state.edit.active).toBe(false);
    expect(appReducer(state, { type: 'EDIT_MODE', active: true }).rightPane.activeTool).toBe(
      'edit',
    );
  });

  it('opens and cancels the in-place editor', () => {
    let state = appReducer(withDocument(), { type: 'EDIT_OPEN', page: 1, paragraphIndex: 2 });
    expect(state.edit).toMatchObject({ active: true, editing: { page: 1, paragraphIndex: 2 } });
    state = appReducer(state, { type: 'EDIT_CANCEL' });
    expect(state.edit.editing).toBeNull();
  });

  it('a commit records the entry and bumps the page revision only for that page', () => {
    const state = appReducer(withDocument(), {
      type: 'EDIT_APPLIED',
      entry,
      fontSubstituted: false,
    });
    expect(state.edit.stack.entries).toEqual([entry]);
    expect(state.edit.stack.cursor).toBe(1);
    expect(state.edit.revision).toBe(1);
    expect(state.edit.pageRevisions).toEqual({ 1: 1 });
    expect(state.edit.editing).toBeNull();
    expect(state.edit.busy).toBe(false);
  });

  it('shows the font notice until it is dismissed, and never un-shows it by itself', () => {
    let state = appReducer(withDocument(), { type: 'EDIT_APPLIED', entry, fontSubstituted: true });
    expect(state.edit.fontSubstituted).toBe(true);
    state = appReducer(state, { type: 'EDIT_APPLIED', entry, fontSubstituted: false });
    expect(state.edit.fontSubstituted).toBe(true);
    expect(appReducer(state, { type: 'EDIT_NOTICE_DISMISSED' }).edit.fontSubstituted).toBe(false);
  });

  it('marks the document edited until it is saved', () => {
    const opened = withDocument();
    expect(hasUnsavedEdits(opened)).toBe(false);
    const edited = appReducer(opened, { type: 'EDIT_APPLIED', entry, fontSubstituted: false });
    expect(hasUnsavedEdits(edited)).toBe(true);
    const saved = appReducer(edited, { type: 'DOCUMENT_SAVED' });
    expect(hasUnsavedEdits(saved)).toBe(false);
    // Undo is a change of its own: the file on disk is stale again.
    const undone = appReducer(saved, {
      type: 'EDIT_STEPPED',
      stack: { entries: [entry], cursor: 0 },
      page: entry.page,
      fontSubstituted: false,
    });
    expect(hasUnsavedEdits(undone)).toBe(true);
    expect(undone.edit.pageRevisions).toEqual({ 1: 2 });
  });

  it('forgets the history when another document is opened', () => {
    const edited = appReducer(withDocument(), {
      type: 'EDIT_APPLIED',
      entry,
      fontSubstituted: true,
    });
    const reopened = appReducer(edited, { type: 'DOCUMENT_OPENED', document: doc });
    expect(reopened.edit.stack.entries).toHaveLength(0);
    expect(reopened.edit.revision).toBe(0);
    expect(reopened.edit.fontSubstituted).toBe(false);
    expect(appReducer(edited, { type: 'DOCUMENT_CLOSED' }).edit.active).toBe(false);
  });
});

describe('pdfFileName', () => {
  it('keeps one .pdf extension whatever the original name looks like', () => {
    expect(pdfFileName('فاتورة.pdf')).toBe('فاتورة.pdf');
    expect(pdfFileName('report.PDF')).toBe('report.PDF');
    expect(pdfFileName('notes')).toBe('notes.pdf');
    expect(pdfFileName('  ')).toBe('document.pdf');
  });
});

describe('sanitizePreferences', () => {
  it('drops invalid stored values', () => {
    expect(
      sanitizePreferences({ lang: 'xx', theme: 'dark', leftPaneWidth: -3, leftTab: 'layers' }),
    ).toEqual({
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

describe('placing new text', () => {
  it('turns Edit mode on, because the overlay that takes the click lives there', () => {
    const state = appReducer(createInitialState(), { type: 'EDIT_PLACE', placing: true });
    expect(state.edit.placing).toBe(true);
    expect(state.edit.active).toBe(true);
  });

  it('remembers the point until the line is drawn or dropped', () => {
    let state = appReducer(createInitialState(), { type: 'EDIT_PLACE', placing: true });
    state = appReducer(state, { type: 'EDIT_ADD_AT', page: 2, x: 120, y: 340 });
    expect(state.edit.adding).toEqual({ page: 2, x: 120, y: 340 });
    expect(state.edit.placing).toBe(false);
    expect(appReducer(state, { type: 'EDIT_CANCEL' }).edit.adding).toBeNull();
    const drawn = appReducer(state, { type: 'EDIT_ADDED', page: 2 });
    expect(drawn.edit.adding).toBeNull();
    expect(drawn.edit.pageRevisions[2]).toBe(1);
  });
});

describe('opening a file that has a password', () => {
  it('asks for the password instead of reporting a failure', () => {
    const loading = appReducer(createInitialState(), { type: 'DOCUMENT_LOADING', name: 'locked.pdf' });
    const asked = appReducer(loading, { type: 'PASSWORD_NEEDED', name: 'locked.pdf', wrong: false });
    expect(asked.passwordPrompt).toEqual({ name: 'locked.pdf', wrong: false });
    expect(asked.loadingName).toBeNull();
    expect(asked.error).toBeNull();
  });

  it('stays up while the password is tried, and says so when it was wrong', () => {
    const asked = appReducer(createInitialState(), { type: 'PASSWORD_NEEDED', name: 'locked.pdf', wrong: false });
    const trying = appReducer(asked, { type: 'DOCUMENT_LOADING', name: 'locked.pdf' });
    expect(trying.passwordPrompt).toEqual({ name: 'locked.pdf', wrong: false });
    const wrong = appReducer(trying, { type: 'PASSWORD_NEEDED', name: 'locked.pdf', wrong: true });
    expect(wrong.passwordPrompt?.wrong).toBe(true);
  });

  it('closes when the person cancels, the file opens, or it fails for another reason', () => {
    const asked = appReducer(createInitialState(), { type: 'PASSWORD_NEEDED', name: 'locked.pdf', wrong: false });
    expect(appReducer(asked, { type: 'PASSWORD_CANCELLED' }).passwordPrompt).toBeNull();
    expect(appReducer(asked, { type: 'DOCUMENT_OPENED', document: doc }).passwordPrompt).toBeNull();
    expect(appReducer(asked, { type: 'DOCUMENT_FAILED', error: 'error.open' }).passwordPrompt).toBeNull();
  });
});
