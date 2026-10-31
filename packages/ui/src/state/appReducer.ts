import type { TKey } from '../i18n/messages';
import type { FontChoice, FontUsed } from '../edit/fontMatch';
import type { CoreStatus, DocumentMetadata, PageSize } from '../core/types';
import { applyEdit, EMPTY_EDIT_STACK } from '../edit/editStack';
import type { EditEntry, EditStack } from '../edit/editStack';
import type { ToolId } from '../tools/tools';
import type { LeftTab, Preferences, ThemeMode, UiLook } from './preferences';
import { getSettings } from './settings';
import { defaultLook } from './preferences';
import { clampZoom, nextZoomStep, previousZoomStep } from './zoom';
import { NO_SELECTION, clampSelection, select, selectAll } from '../organize/selection';
import type { SelectHow, Selection } from '../organize/selection';
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
  /** Brief §15.5: a font other than the paragraph's own was embedded and the user must be told. */
  fontSubstituted: boolean;
  /** What the last edit was drawn in, and where that font came from. */
  fontUsed: FontUsed | null;
  /** An edit's text had to be made smaller to fit its box; the user is told. */
  textShrunk: boolean;
  /** A core call is in flight; the editor and the undo buttons wait for it. */
  busy: boolean;
  /** Waiting for the click that says where new text should go. */
  placing: boolean;
  /** Where that text will start, in page points from the top-left corner. */
  adding: { page: number; x: number; y: number } | null;
  /** Points, chosen in the panel before placing. */
  addSize: number;
  /** The face an edit is shaped with: found for each paragraph, or a bundled one chosen. */
  font: FontChoice;
}

export interface OrganizeState {
  selection: Selection;
  /** Bumped by every page change, undo and redo: the grid redraws on it. */
  revision: number;
  /** A page change is in flight; the controls wait for it. */
  busy: boolean;
}

export interface AppState {
  view: 'home' | 'viewer';
  /**
   * The home screen shown over the open documents, which stay open behind it
   * (the Workbench look's Home tab). Any document opening or closing ends it.
   */
  homeShown: boolean;
  document: DocumentInfo | null;
  loadingName: string | null;
  error: TKey | null;
  /** The file an error is about, named in its message ({name}). */
  errorName: string | null;
  toast: { key: TKey; nonce: number } | null;
  /** 1-based. */
  currentPage: number;
  zoom: number;
  zoomMode: ZoomMode;
  theme: ThemeMode;
  look: UiLook;
  leftPane: { open: boolean; width: number; tab: LeftTab };
  rightPane: { open: boolean; width: number; activeTool: ToolId | null };
  find: { open: boolean; query: string; matches: number[]; cursor: number; searched: boolean };
  dialog: 'goto' | 'shortcuts' | 'about' | 'settings' | 'tour' | 'versions' | 'support' | null;
  /** A file that needs a password to open; `wrong` after a failed attempt. */
  passwordPrompt: { name: string; wrong: boolean } | null;
  /** Consumed by the viewer; the nonce makes repeated requests distinct. */
  scrollRequest: { page: number; nonce: number } | null;
  core: CoreStatus | null;
  edit: EditState;
  organize: OrganizeState;
  /**
   * The file is on its way between the engines: `in` to Warraq's, `out` back to
   * EmbedPDF. Until it arrives, the view shows neither engine's old copy as if
   * it were current, and nothing can be edited.
   */
  switching: 'in' | 'out' | null;
}

export type AppAction =
  /** `keepError`: going back to a tab already open, which says nothing about the error on screen. */
  | { type: 'DOCUMENT_LOADING'; name: string; keepError?: boolean }
  | { type: 'DOCUMENT_OPENED'; document: DocumentInfo; keepError?: boolean }
  | { type: 'DOCUMENT_FAILED'; error: TKey; name?: string }
  | { type: 'DOCUMENT_CLOSED' }
  | { type: 'PASSWORD_NEEDED'; name: string; wrong: boolean }
  | { type: 'SWITCH_ENGINE'; direction: 'in' | 'out' }
  | { type: 'SWITCH_DONE' }
  | { type: 'ORGANIZE_SELECT'; index: number; how: SelectHow }
  | { type: 'ORGANIZE_SELECT_ALL' }
  | { type: 'ORGANIZE_BUSY'; busy: boolean }
  /** The open document changed shape (Organize): new pages, and what to select. */
  | {
      type: 'DOCUMENT_RESHAPED';
      pageCount: number;
      pageSizes: readonly PageSize[];
      selection: number[];
      /** The change left every page's text as it was (an attachment): Edit text's undo history stays. */
      keepEditHistory?: boolean;
    }
  | { type: 'PASSWORD_CANCELLED' }
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
  | { type: 'SET_LOOK'; look: UiLook }
  | { type: 'SHOW_HOME'; shown: boolean }
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
  | { type: 'EDIT_FONT'; font: FontChoice }
  | { type: 'EDIT_BUSY'; busy: boolean }
  | { type: 'EDIT_APPLIED'; entry: EditEntry; fontSubstituted: boolean; fontUsed?: FontUsed; shrunk?: boolean }
  /** A picture, link or added-text change, the file before it kept as `snapshot` for undo. */
  | { type: 'EDIT_FILE_CHANGED'; page: number; snapshot: number }
  | { type: 'EDIT_STEPPED'; stack: EditStack; page: number; fontSubstituted: boolean; fontUsed?: FontUsed; shrunk?: boolean }
  | { type: 'EDIT_NOTICE_DISMISSED' }
  | { type: 'DOCUMENT_SAVED' }
  /** The file now has another name: saved under it in a cloud drive. */
  | { type: 'DOCUMENT_RENAMED'; name: string };

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
    fontUsed: null,
    textShrunk: false,
    busy: false,
    placing: false,
    adding: null,
    addSize: 14,
    font: 'auto',
  };
}

/** True while the document holds edits that have not been written to disk. */
export function hasUnsavedEdits(state: AppState): boolean {
  return state.edit.revision !== state.edit.savedRevision;
}

/** Records one applied change: a new revision for the document and for `page`. */
function bumpRevision(
  edit: EditState,
  page: number,
  fontSubstituted: boolean,
  fontUsed?: FontUsed,
  shrunk = false,
): EditState {
  return {
    ...edit,
    editing: null,
    busy: false,
    placing: false,
    adding: null,
    revision: edit.revision + 1,
    pageRevisions: { ...edit.pageRevisions, [page]: (edit.pageRevisions[page] ?? 0) + 1 },
    fontSubstituted: edit.fontSubstituted || fontSubstituted,
    // The notice speaks of the last substitution; an edit drawn in the
    // paragraph's own font leaves an earlier one standing.
    fontUsed: fontSubstituted ? (fontUsed ?? null) : edit.fontUsed,
    textShrunk: edit.textShrunk || shrunk,
  };
}

export function createInitialState(prefs: Preferences = {}): AppState {
  return {
    view: 'home',
    homeShown: false,
    document: null,
    loadingName: null,
    error: null,
    errorName: null,
    toast: null,
    currentPage: 1,
    zoom: 1,
    zoomMode: 'fit-width',
    theme: prefs.theme ?? 'system',
    look: prefs.look ?? defaultLook(),
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
    passwordPrompt: null,
    scrollRequest: null,
    core: null,
    edit: createEditState(),
    organize: { selection: NO_SELECTION, revision: 0, busy: false },
    switching: null,
  };
}

/**
 * Warraq's own engine holds the document — Edit text or Organize pages is
 * open — and EmbedPDF steps aside until it is handed back (ADR-0007).
 */
export function warraqOwnsDocument(state: AppState): boolean {
  return state.edit.active || state.rightPane.activeTool === 'organize';
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

/**
 * The engine switch is marked in the same change that moves the document from
 * one engine to the other, not an effect later: for one frame the panels
 * otherwise offered their controls on the copy about to be replaced, and a
 * click then raced the switch.
 */
export function appReducer(state: AppState, action: AppAction): AppState {
  const next = reduce(state, action);
  const owner = warraqOwnsDocument(next);
  if (
    action.type !== 'SWITCH_ENGINE' &&
    action.type !== 'SWITCH_DONE' &&
    state.document !== null &&
    next.document !== null &&
    warraqOwnsDocument(state) !== owner
  ) {
    return { ...next, switching: owner ? 'in' : 'out' };
  }
  return next;
}

function reduce(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'DOCUMENT_LOADING':
      // A password prompt stays up while its answer is tried.
      // A file named in an error stays named while the person goes back to another tab.
      return action.keepError && state.errorName !== null
        ? { ...state, loadingName: action.name }
        : { ...state, loadingName: action.name, error: null, errorName: null };
    case 'DOCUMENT_OPENED':
      return {
        ...state,
        // From the home screen, the panels open as Settings › Viewing says;
        // between documents they stay as the person left them.
        ...(state.view !== 'viewer' && {
          leftPane: { ...state.leftPane, open: getSettings().pagePanel },
          rightPane: { ...state.rightPane, open: getSettings().toolsPanel },
        }),
        view: 'viewer',
        homeShown: false,
        document: action.document,
        loadingName: null,
        ...(action.keepError && state.errorName !== null ? {} : { error: null, errorName: null }),
        passwordPrompt: null,
        currentPage: 1,
        scrollRequest: null,
        find: { ...state.find, matches: [], cursor: 0, searched: false },
        edit: { ...createEditState(), active: state.edit.active },
      };
    case 'DOCUMENT_FAILED':
      return { ...state, loadingName: null, error: action.error, errorName: action.name ?? null, passwordPrompt: null, switching: null };
    case 'SWITCH_ENGINE':
      return { ...state, switching: action.direction };
    case 'SWITCH_DONE':
      return { ...state, switching: null };
    case 'PASSWORD_NEEDED':
      return { ...state, loadingName: null, error: null, errorName: null, passwordPrompt: { name: action.name, wrong: action.wrong } };
    case 'PASSWORD_CANCELLED':
      return { ...state, passwordPrompt: null };
    case 'DOCUMENT_CLOSED':
      return {
        ...state,
        switching: null,
        view: 'home',
        homeShown: false,
        document: null,
        currentPage: 1,
        scrollRequest: null,
        find: { open: false, query: '', matches: [], cursor: 0, searched: false },
        edit: createEditState(),
      };
    case 'ERROR_DISMISSED':
      return { ...state, error: null, errorName: null };
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
    case 'SET_LOOK':
      // Only the Workbench look has a Home tab to come back from.
      return { ...state, look: action.look, homeShown: action.look === 'workbench' && state.homeShown };
    case 'SHOW_HOME':
      return { ...state, homeShown: action.shown && state.view === 'viewer' };
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
        // A tool works on the document: chosen from the home screen over it, it goes back to it.
        homeShown: action.tool ? false : state.homeShown,
        rightPane: {
          ...state.rightPane,
          activeTool: action.tool,
          open: action.tool ? true : state.rightPane.open,
        },
        edit:
          action.tool === 'edit'
            ? { ...state.edit, active: true }
            : { ...state.edit, active: false, editing: null },
        organize:
          action.tool === 'organize' && state.rightPane.activeTool !== 'organize'
            ? { ...state.organize, selection: NO_SELECTION }
            : state.organize,
      };
    case 'ORGANIZE_SELECT':
      return { ...state, organize: { ...state.organize, selection: select(state.organize.selection, action.index, action.how) } };
    case 'ORGANIZE_SELECT_ALL':
      return { ...state, organize: { ...state.organize, selection: selectAll(state.document?.pageCount ?? 0) } };
    case 'ORGANIZE_BUSY':
      return { ...state, organize: { ...state.organize, busy: action.busy } };
    case 'DOCUMENT_RESHAPED': {
      if (!state.document) return state;
      const selection = clampSelection({ pages: action.selection, anchor: action.selection[0] ?? null }, action.pageCount);
      return {
        ...state,
        document: { ...state.document, pageCount: action.pageCount, pageSizes: action.pageSizes },
        currentPage: Math.min(state.currentPage, Math.max(1, action.pageCount)),
        organize: { selection, revision: state.organize.revision + 1, busy: false },
        // A page change is an edit: the file must be handed back and saved. The
        // text-edit history goes — its entries name pages by position and
        // paragraphs by their place — unless the change left the text alone.
        edit: {
          ...state.edit,
          stack: action.keepEditHistory ? state.edit.stack : EMPTY_EDIT_STACK,
          editing: null,
          revision: state.edit.revision + 1,
        },
      };
    }
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
      // Arming placement closes any open paragraph editor: one at a time. It
      // also turns Edit mode on, because the overlay that takes the click only
      // exists in Edit mode — without this the button is a dead click.
      return {
        ...state,
        edit: {
          ...state.edit,
          placing: action.placing,
          active: action.placing || state.edit.active,
          adding: null,
          editing: null,
        },
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
    case 'EDIT_BUSY':
      return { ...state, edit: { ...state.edit, busy: action.busy } };
    case 'EDIT_APPLIED':
      return {
        ...state,
        edit: {
          ...bumpRevision(state.edit, action.entry.page, action.fontSubstituted, action.fontUsed, action.shrunk),
          stack: applyEdit(state.edit.stack, action.entry),
        },
      };
    case 'EDIT_FILE_CHANGED':
      return {
        ...state,
        edit: {
          ...bumpRevision(state.edit, action.page, false),
          stack: applyEdit(state.edit.stack, { page: action.page, snapshot: action.snapshot }),
        },
      };
    case 'EDIT_STEPPED':
      return {
        ...state,
        edit: {
          ...bumpRevision(state.edit, action.page, action.fontSubstituted, action.fontUsed, action.shrunk),
          stack: action.stack,
        },
      };
    case 'EDIT_NOTICE_DISMISSED':
      return { ...state, edit: { ...state.edit, fontSubstituted: false, fontUsed: null, textShrunk: false } };
    case 'DOCUMENT_SAVED':
      return { ...state, edit: { ...state.edit, savedRevision: state.edit.revision } };
    case 'DOCUMENT_RENAMED':
      return state.document ? { ...state, document: { ...state.document, name: action.name } } : state;
    default:
      return state;
  }
}
