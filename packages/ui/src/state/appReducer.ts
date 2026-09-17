import type { TKey } from '../i18n/messages';
import { DEFAULT_EDIT_FONT } from '../edit/editFont';
import type { EditFontId } from '../edit/editFont';
import type { CoreStatus, DocumentMetadata, PageSize } from '../core/types';
import { applyEdit, EMPTY_EDIT_STACK } from '../edit/editStack';
import type { EditEntry, EditStack } from '../edit/editStack';
import type { ToolId } from '../tools/tools';
import type { LeftTab, Preferences, ThemeMode } from './preferences';
import { clampZoom, nextZoomStep, previousZoomStep } from './zoom';
import type { ZoomMode } from './zoom';

export interface DocumentInfo {
  id: number;
  name: string;
  pageCount: number;
  pageSizes: readonly PageSize[];
  metadata: DocumentMetadata;
}

export interface EditState {
  /** Edit mode: paragraphs are outlined on hover and open an in-place editor. */
  active: boolean;
  /** The paragraph whose editor is open, if any (`page` is 0-based). */
  editing: { page: number; paragraphIndex: number } | null;
  stack: EditStack;
  /** Bumped by every applied change, including undo and redo. */
  revision: number;
  /** `revision` at the last save; a difference is what "edited" means. */
  savedRevision: number;
  /** Per-page nonce: only the page that changed re-renders and re-reads boxes. */
  pageRevisions: Readonly<Record<number, number>>;
  /** Brief §15.5: the bundled face was substituted and the user must be told. */
  fontSubstituted: boolean;
  /** A core call is in flight; the editor and the undo buttons wait for it. */
  busy: boolean;
  /** Waiting for the click that says where new text should go. */
  placing: boolean;
  /** Where that text will start, in page points from the top-left corner. */
  adding: { page: number; x: number; y: number } | null;
  /** Points, chosen in the panel before placing. */
  addSize: number;
  /** The bundled face an edit is shaped with. */
  font: EditFontId;
}

export interface AppState {
  view: 'home' | 'viewer';
  document: DocumentInfo | null;
  loadingName: string | null;
  error: TKey | null;
  toast: { key: TKey; nonce: number } | null;
  /** 1-based. */
  currentPage: number;
  zoom: number;
  zoomMode: ZoomMode;
  theme: ThemeMode;
  leftPane: { open: boolean; width: number; tab: LeftTab };
  rightPane: { open: boolean; width: number; activeTool: ToolId | null };
  find: { open: boolean; query: string; matches: number[]; cursor: number; searched: boolean };
  dialog: 'goto' | 'shortcuts' | 'about' | null;
  /** Consumed by the viewer; the nonce makes repeated requests distinct. */
  scrollRequest: { page: number; nonce: number } | null;
  core: CoreStatus | null;
  edit: EditState;
}

export type AppAction =
  | { type: 'DOCUMENT_LOADING'; name: string }
  | { type: 'DOCUMENT_OPENED'; document: DocumentInfo }
  | { type: 'DOCUMENT_FAILED'; error: TKey }
  | { type: 'DOCUMENT_CLOSED' }
  | { type: 'ERROR_DISMISSED' }
  | { type: 'TOAST'; key: TKey }
  | { type: 'TOAST_CLEARED' }
  | { type: 'CORE_STATUS'; status: CoreStatus }
  | { type: 'SET_CURRENT_PAGE'; page: number }
  | { type: 'SCROLL_TO_PAGE'; page: number }
  | { type: 'SET_ZOOM'; zoom: number }
  | { type: 'ZOOM_IN' }
  | { type: 'ZOOM_OUT' }
  | { type: 'SET_ZOOM_MODE'; mode: ZoomMode }
  | { type: 'FIT_ZOOM_COMPUTED'; zoom: number }
  | { type: 'SET_THEME'; theme: ThemeMode }
  | { type: 'TOGGLE_LEFT_PANE'; open?: boolean }
  | { type: 'SET_LEFT_TAB'; tab: LeftTab }
  | { type: 'SET_LEFT_WIDTH'; width: number }
  | { type: 'TOGGLE_RIGHT_PANE'; open?: boolean }
  | { type: 'SET_RIGHT_WIDTH'; width: number }
  | { type: 'SET_ACTIVE_TOOL'; tool: ToolId | null }
  | { type: 'FIND_OPEN' }
  | { type: 'FIND_CLOSE' }
  | { type: 'FIND_QUERY'; query: string }
  | { type: 'FIND_RESULTS'; matches: number[] }
  | { type: 'FIND_STEP'; delta: 1 | -1 }
  | { type: 'DIALOG'; dialog: AppState['dialog'] }
  | { type: 'EDIT_MODE'; active: boolean }
  | { type: 'EDIT_OPEN'; page: number; paragraphIndex: number }
  | { type: 'EDIT_CANCEL' }
  | { type: 'EDIT_PLACE'; placing: boolean }
  | { type: 'EDIT_ADD_AT'; page: number; x: number; y: number }
  | { type: 'EDIT_ADD_SIZE'; size: number }
  | { type: 'EDIT_FONT'; font: EditFontId }
  | { type: 'EDIT_ADDED'; page: number }
  | { type: 'EDIT_BUSY'; busy: boolean }
  | { type: 'EDIT_APPLIED'; entry: EditEntry; fontSubstituted: boolean }
  | { type: 'EDIT_STEPPED'; stack: EditStack; page: number; fontSubstituted: boolean }
  | { type: 'EDIT_NOTICE_DISMISSED' }
  | { type: 'DOCUMENT_SAVED' };

export const PANE_MIN_WIDTH = 160;
export const PANE_MAX_WIDTH = 560;
const DEFAULT_LEFT_WIDTH = 220;
const DEFAULT_RIGHT_WIDTH = 280;

export function clampPaneWidth(width: number): number {
  return Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH, Math.round(width)));
}

export function createEditState(): EditState {
  return {
    active: false,
    editing: null,
    stack: EMPTY_EDIT_STACK,
    revision: 0,
    savedRevision: 0,
    pageRevisions: {},
    fontSubstituted: false,
    busy: false,
    placing: false,
    adding: null,
    addSize: 14,
    font: DEFAULT_EDIT_FONT,
  };
}

/** True while the document holds edits that have not been written to disk. */
export function hasUnsavedEdits(state: AppState): boolean {
  return state.edit.revision !== state.edit.savedRevision;
}

/** Records one applied change: a new revision for the document and for `page`. */
function bumpRevision(edit: EditState, page: number, fontSubstituted: boolean): EditState {
  return {
    ...edit,
    editing: null,
    busy: false,
    placing: false,
    adding: null,
    revision: edit.revision + 1,
    pageRevisions: { ...edit.pageRevisions, [page]: (edit.pageRevisions[page] ?? 0) + 1 },
    fontSubstituted: edit.fontSubstituted || fontSubstituted,
  };
}

export function createInitialState(prefs: Preferences = {}): AppState {
  return {
    view: 'home',
    document: null,
    loadingName: null,
    error: null,
    toast: null,
    currentPage: 1,
    zoom: 1,
    zoomMode: 'fit-width',
    theme: prefs.theme ?? 'system',
    leftPane: {
      open: prefs.leftPaneOpen ?? true,
      width: clampPaneWidth(prefs.leftPaneWidth ?? DEFAULT_LEFT_WIDTH),
      tab: prefs.leftTab ?? 'thumbnails',
    },
    rightPane: {
      open: prefs.rightPaneOpen ?? true,
      width: clampPaneWidth(prefs.rightPaneWidth ?? DEFAULT_RIGHT_WIDTH),
      activeTool: null,
    },
    find: { open: false, query: '', matches: [], cursor: 0, searched: false },
    dialog: null,
    scrollRequest: null,
    core: null,
    edit: createEditState(),
  };
}

function scrollTo(state: AppState, page: number): AppState {
  const total = state.document?.pageCount ?? 0;
  if (total === 0) return state;
  const clamped = Math.min(total, Math.max(1, Math.round(page)));
  const nonce = (state.scrollRequest?.nonce ?? 0) + 1;
  return { ...state, currentPage: clamped, scrollRequest: { page: clamped, nonce } };
}

function findStep(state: AppState, delta: 1 | -1): AppState {
  const { matches, cursor } = state.find;
  if (matches.length === 0) return state;
  const next = (cursor + delta + matches.length) % matches.length;
  const page = (matches[next] ?? 0) + 1;
  return scrollTo({ ...state, find: { ...state.find, cursor: next } }, page);
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'DOCUMENT_LOADING':
      return { ...state, loadingName: action.name, error: null };
    case 'DOCUMENT_OPENED':
      return {
        ...state,
        view: 'viewer',
        document: action.document,
        loadingName: null,
        error: null,
        currentPage: 1,
        scrollRequest: null,
        find: { ...state.find, matches: [], cursor: 0, searched: false },
        edit: { ...createEditState(), active: state.edit.active },
      };
    case 'DOCUMENT_FAILED':
      return { ...state, loadingName: null, error: action.error };
    case 'DOCUMENT_CLOSED':
      return {
        ...state,
        view: 'home',
        document: null,
        currentPage: 1,
        scrollRequest: null,
        find: { open: false, query: '', matches: [], cursor: 0, searched: false },
        edit: createEditState(),
      };
    case 'ERROR_DISMISSED':
      return { ...state, error: null };
    case 'TOAST':
      return { ...state, toast: { key: action.key, nonce: (state.toast?.nonce ?? 0) + 1 } };
    case 'TOAST_CLEARED':
      return { ...state, toast: null };
    case 'CORE_STATUS':
      return { ...state, core: action.status };
    case 'SET_CURRENT_PAGE':
      return state.currentPage === action.page ? state : { ...state, currentPage: action.page };
    case 'SCROLL_TO_PAGE':
      return scrollTo(state, action.page);
    case 'SET_ZOOM':
      return { ...state, zoom: clampZoom(action.zoom), zoomMode: 'custom' };
    case 'ZOOM_IN':
      return { ...state, zoom: nextZoomStep(state.zoom), zoomMode: 'custom' };
    case 'ZOOM_OUT':
      return { ...state, zoom: previousZoomStep(state.zoom), zoomMode: 'custom' };
    case 'SET_ZOOM_MODE':
      return { ...state, zoomMode: action.mode };
    case 'FIT_ZOOM_COMPUTED':
      return Math.abs(state.zoom - action.zoom) < 0.0005 ? state : { ...state, zoom: action.zoom };
    case 'SET_THEME':
      return { ...state, theme: action.theme };
    case 'TOGGLE_LEFT_PANE':
      return {
        ...state,
        leftPane: { ...state.leftPane, open: action.open ?? !state.leftPane.open },
      };
    case 'SET_LEFT_TAB':
      return { ...state, leftPane: { ...state.leftPane, tab: action.tab, open: true } };
    case 'SET_LEFT_WIDTH':
      return { ...state, leftPane: { ...state.leftPane, width: clampPaneWidth(action.width) } };
    case 'TOGGLE_RIGHT_PANE':
      return {
        ...state,
        rightPane: { ...state.rightPane, open: action.open ?? !state.rightPane.open },
      };
    case 'SET_RIGHT_WIDTH':
      return { ...state, rightPane: { ...state.rightPane, width: clampPaneWidth(action.width) } };
    case 'SET_ACTIVE_TOOL':
      // Picking the Edit tool is what "enter Edit mode" means; leaving it exits.
      return {
        ...state,
        rightPane: {
          ...state.rightPane,
          activeTool: action.tool,
          open: action.tool ? true : state.rightPane.open,
        },
        edit:
          action.tool === 'edit'
            ? { ...state.edit, active: true }
            : { ...state.edit, active: false, editing: null },
      };
    case 'FIND_OPEN':
      return { ...state, find: { ...state.find, open: true } };
    case 'FIND_CLOSE':
      return { ...state, find: { ...state.find, open: false } };
    case 'FIND_QUERY':
      return { ...state, find: { ...state.find, query: action.query, searched: false } };
    case 'FIND_RESULTS': {
      const next = {
        ...state,
        find: { ...state.find, matches: action.matches, cursor: 0, searched: true },
      };
      return action.matches.length > 0 ? scrollTo(next, (action.matches[0] ?? 0) + 1) : next;
    }
    case 'FIND_STEP':
      return findStep(state, action.delta);
    case 'DIALOG':
      return { ...state, dialog: action.dialog };
    case 'EDIT_MODE':
      return {
        ...state,
        edit: {
          ...state.edit,
          active: action.active,
          editing: action.active ? state.edit.editing : null,
        },
        rightPane: action.active
          ? { ...state.rightPane, activeTool: 'edit', open: true }
          : state.rightPane,
      };
    case 'EDIT_OPEN':
      return {
        ...state,
        edit: {
          ...state.edit,
          active: true,
          editing: { page: action.page, paragraphIndex: action.paragraphIndex },
        },
      };
    case 'EDIT_CANCEL':
      return {
        ...state,
        edit: { ...state.edit, editing: null, busy: false, placing: false, adding: null },
      };
    case 'EDIT_PLACE':
      // Arming placement closes any open paragraph editor: one at a time.
      return {
        ...state,
        edit: { ...state.edit, placing: action.placing, adding: null, editing: null },
      };
    case 'EDIT_ADD_AT':
      return {
        ...state,
        edit: {
          ...state.edit,
          placing: false,
          adding: { page: action.page, x: action.x, y: action.y },
        },
      };
    case 'EDIT_ADD_SIZE':
      return { ...state, edit: { ...state.edit, addSize: action.size } };
    case 'EDIT_FONT':
      return { ...state, edit: { ...state.edit, font: action.font } };
    case 'EDIT_ADDED':
      // Added text is not on the undo stack: the stack replays paragraph
      // replacements, and there is no paragraph here to replay. The panel says
      // so rather than offering an Undo that would quietly do nothing.
      return { ...state, edit: bumpRevision(state.edit, action.page, false) };
    case 'EDIT_BUSY':
      return { ...state, edit: { ...state.edit, busy: action.busy } };
    case 'EDIT_APPLIED':
      return {
        ...state,
        edit: {
          ...bumpRevision(state.edit, action.entry.page, action.fontSubstituted),
          stack: applyEdit(state.edit.stack, action.entry),
        },
      };
    case 'EDIT_STEPPED':
      return {
        ...state,
        edit: {
          ...bumpRevision(state.edit, action.page, action.fontSubstituted),
          stack: action.stack,
        },
      };
    case 'EDIT_NOTICE_DISMISSED':
      return { ...state, edit: { ...state.edit, fontSubstituted: false } };
    case 'DOCUMENT_SAVED':
      return { ...state, edit: { ...state.edit, savedRevision: state.edit.revision } };
    default:
      return state;
  }
}
