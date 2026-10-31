import { describe, expect, it } from 'vitest';
import { appReducer, createInitialState, hasUnsavedEdits, PANE_MAX_WIDTH, warraqOwnsDocument } from './appReducer';
import type { AppState, DocumentInfo } from './appReducer';
import { MAX_ZOOM, MIN_ZOOM } from './zoom';
import { combinedFileName, comparisonFileName, extractedFileName, pdfFileName } from './saveFile';
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

  it('a picture or link change goes on the same stack as text, after it', () => {
    let state = appReducer(withDocument(), { type: 'EDIT_APPLIED', entry, fontSubstituted: false });
    state = appReducer(state, { type: 'EDIT_FILE_CHANGED', page: 2, snapshot: 4 });
    expect(state.edit.stack.entries).toEqual([entry, { page: 2, snapshot: 4 }]);
    expect(state.edit.stack.cursor).toBe(2);
    expect(state.edit.pageRevisions).toEqual({ 1: 1, 2: 1 });
    expect(state.edit.busy).toBe(false);
    expect(hasUnsavedEdits(state)).toBe(true);
  });

  it('shows the font notice until it is dismissed, and never un-shows it by itself', () => {
    let state = appReducer(withDocument(), { type: 'EDIT_APPLIED', entry, fontSubstituted: true });
    expect(state.edit.fontSubstituted).toBe(true);
    state = appReducer(state, { type: 'EDIT_APPLIED', entry, fontSubstituted: false });
    expect(state.edit.fontSubstituted).toBe(true);
    expect(appReducer(state, { type: 'EDIT_NOTICE_DISMISSED' }).edit.fontSubstituted).toBe(false);
  });

  it('keeps the undo history through a change that leaves the text alone, not through others', () => {
    const edited = appReducer(withDocument(), { type: 'EDIT_APPLIED', entry, fontSubstituted: false });
    const shape = { pageCount: 3, pageSizes: [[595, 842], [595, 842], [595, 842]] as [number, number][], selection: [] };
    // An attachment added or removed: the paragraphs are where they were.
    const attached = appReducer(edited, { type: 'DOCUMENT_RESHAPED', ...shape, keepEditHistory: true });
    expect(attached.edit.stack.entries).toEqual([entry]);
    expect(attached.edit.revision).toBeGreaterThan(edited.edit.revision);
    // Pages turned, text recognised, marks drawn: the history names what may have moved.
    const reshaped = appReducer(edited, { type: 'DOCUMENT_RESHAPED', ...shape });
    expect(reshaped.edit.stack.entries).toEqual([]);
  });

  it('takes the name a file was saved under, and keeps its edits', () => {
    const edited = appReducer(withDocument(), { type: 'EDIT_APPLIED', entry, fontSubstituted: false });
    const renamed = appReducer(edited, { type: 'DOCUMENT_RENAMED', name: 'تقرير نهائي.pdf' });
    expect(renamed.document?.name).toBe('تقرير نهائي.pdf');
    expect(renamed.edit).toBe(edited.edit);
    const home = createInitialState({});
    expect(appReducer(home, { type: 'DOCUMENT_RENAMED', name: 'x.pdf' })).toBe(home);
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

  it('names a comparison report after the file, as an HTML page', () => {
    expect(comparisonFileName('فاتورة.pdf')).toBe('فاتورة (comparison).html');
    expect(comparisonFileName('notes')).toBe('notes (comparison).html');
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
    const drawn = appReducer(state, { type: 'EDIT_FILE_CHANGED', page: 2, snapshot: 1 });
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

describe('organizing pages', () => {
  const inOrganize = () => appReducer(withDocument(), { type: 'SET_ACTIVE_TOOL', tool: 'organize' });

  it('hands the document to Warraq’s engine while Organize or Edit is open', () => {
    expect(warraqOwnsDocument(withDocument())).toBe(false);
    expect(warraqOwnsDocument(inOrganize())).toBe(true);
    expect(warraqOwnsDocument(appReducer(withDocument(), { type: 'SET_ACTIVE_TOOL', tool: 'edit' }))).toBe(true);
    expect(warraqOwnsDocument(appReducer(inOrganize(), { type: 'SET_ACTIVE_TOOL', tool: 'comment' }))).toBe(false);
  });

  it('selects with clicks and starts empty each time Organize opens', () => {
    let state = inOrganize();
    expect(state.organize.selection.pages).toEqual([]);
    state = appReducer(state, { type: 'ORGANIZE_SELECT', index: 0, how: 'only' });
    state = appReducer(state, { type: 'ORGANIZE_SELECT', index: 2, how: 'range' });
    expect(state.organize.selection.pages).toEqual([0, 1, 2]);
    state = appReducer(state, { type: 'SET_ACTIVE_TOOL', tool: 'comment' });
    state = appReducer(state, { type: 'SET_ACTIVE_TOOL', tool: 'organize' });
    expect(state.organize.selection.pages).toEqual([]);
    expect(appReducer(state, { type: 'ORGANIZE_SELECT_ALL' }).organize.selection.pages).toEqual([0, 1, 2]);
  });

  it('takes the document’s new shape after a change, and redraws', () => {
    const state = appReducer(
      appReducer(inOrganize(), { type: 'ORGANIZE_SELECT', index: 2, how: 'only' }),
      { type: 'DOCUMENT_RESHAPED', pageCount: 2, pageSizes: [[842, 595], [595, 842]], selection: [1] },
    );
    expect(state.document?.pageCount).toBe(2);
    expect(state.document?.pageSizes[0]).toEqual([842, 595]);
    expect(state.organize.selection.pages).toEqual([1]);
    expect(state.organize.revision).toBeGreaterThan(inOrganize().organize.revision);
    expect(state.currentPage).toBeLessThanOrEqual(2);
    expect(hasUnsavedEdits(state)).toBe(true);
  });
});

describe('extractedFileName', () => {
  it('names the new file after the pages it holds, counted from one', () => {
    expect(extractedFileName('report.pdf', [1, 3, 4, 5])).toBe('report (2, 4-6).pdf');
    expect(extractedFileName('تقرير.pdf', [0])).toBe('تقرير (1).pdf');
    expect(extractedFileName('scan', [2, 1, 1])).toBe('scan (2-3).pdf');
  });
});

describe('switching engines', () => {
  it('is in flight from the first step until the other engine has the file', () => {
    let state = appReducer(withDocument(), { type: 'SWITCH_ENGINE', direction: 'in' });
    expect(state.switching).toBe('in');
    state = appReducer(state, { type: 'SWITCH_DONE' });
    expect(state.switching).toBeNull();
  });

  it('starts the moment the document changes engine, not a frame later', () => {
    const organizing = appReducer(withDocument(), { type: 'SET_ACTIVE_TOOL', tool: 'organize' });
    expect(organizing.switching).toBe('in');
    const settled = appReducer(organizing, { type: 'SWITCH_DONE' });
    expect(appReducer(settled, { type: 'SET_ACTIVE_TOOL', tool: null }).switching).toBe('out');
    expect(appReducer(settled, { type: 'SET_ACTIVE_TOOL', tool: 'edit' }).switching, 'Organize to Edit: one engine').toBeNull();
    expect(appReducer(withDocument(), { type: 'SET_ACTIVE_TOOL', tool: 'comment' }).switching).toBeNull();
    expect(appReducer(createInitialState(), { type: 'SET_ACTIVE_TOOL', tool: 'organize' }).switching, 'no document').toBeNull();
  });

  it('never stays in flight after a failure or a close', () => {
    const inFlight = appReducer(withDocument(), { type: 'SWITCH_ENGINE', direction: 'out' });
    expect(appReducer(inFlight, { type: 'DOCUMENT_FAILED', error: 'error.open' }).switching).toBeNull();
    expect(appReducer(inFlight, { type: 'DOCUMENT_CLOSED' }).switching).toBeNull();
  });
});

describe('combinedFileName', () => {
  it('is the first file’s name and how many more', () => {
    expect(combinedFileName(['report.pdf', 'annex.pdf', 'scan.pdf'])).toBe('report (3 files combined).pdf');
    expect(combinedFileName(['عقد.pdf', 'ملحق.pdf'], 'دمج 2 ملفات')).toBe('عقد (دمج 2 ملفات).pdf');
  });
});
