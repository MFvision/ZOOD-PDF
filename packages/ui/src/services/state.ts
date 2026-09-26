/**
 * App state: the open documents as bytes, the route, recents and HUD toasts.
 *
 * Document ownership (see docs/BRIEF.md): EmbedPDF displays and edits; the Rust core owns everything
 * else. When a core tool replaces a document's bytes the reducer flips `switching` in the SAME
 * dispatch and bumps `revision`, so the viewer (keyed by revision) remounts on the new bytes and never
 * shows or saves stale PDFium state.
 */
import type { Locale } from '../i18n';
import type { RecentItem } from './recents';

export interface OpenDocument {
  id: string;
  name: string;
  /** Current bytes shown by the viewer. */
  bytes: Uint8Array;
  /** Bytes as last opened or saved. Never mutated; saves are incremental on top of these. */
  originalBytes: Uint8Array;
  /** Bumped whenever the viewer must reload from `bytes`. */
  revision: number;
  /** True while the viewer is (re)loading `bytes` for the current revision. */
  switching: boolean;
  /** True when the latest bytes came from the core (not from PDFium). */
  warraqOwnsDocument: boolean;
  /** Unsaved changes exist (in PDFium or from the core). */
  edited: boolean;
  pageCount: number;
  /** Recents entry this document belongs to. */
  recentId?: string;
  /** Opaque host handle for "Save" in place (File System Access / native path). */
  handle?: unknown;
  /** Tool to start once the viewer is ready (picked before a document was open). */
  pendingTool?: string;
  /** Password the document was opened with (kept in memory only; the engine and the viewer need it). */
  password?: string;
}

export type HomeSection = 'home' | 'recents' | 'starred' | 'tags';
export type Route = { name: 'home'; section: HomeSection; tag?: string } | { name: 'document'; id: string };

export interface Toast {
  id: string;
  message: string;
  tone?: 'info' | 'success' | 'error';
}

export interface AppState {
  locale: Locale;
  documents: Record<string, OpenDocument>;
  order: string[];
  route: Route;
  recents: RecentItem[];
  toasts: Toast[];
}

export type Action =
  | { type: 'OPEN_DOCUMENT'; id: string; name: string; bytes: Uint8Array; recentId?: string; handle?: unknown; tool?: string; unsaved?: boolean; password?: string }
  | { type: 'TOOL_STARTED'; id: string }
  | { type: 'CLOSE_DOCUMENT'; id: string }
  | { type: 'VIEWER_READY'; id: string; revision: number; pageCount: number }
  | { type: 'VIEWER_EDITED'; id: string }
  /** `wholeRewrite` (redaction, hidden-information removal, password changes): the earlier bytes are gone
   * for good, so later viewer edits are rebased on the new bytes, never on the old original. `password`:
   * the protection changed (null = removed). */
  | { type: 'CORE_REPLACED_BYTES'; id: string; bytes: Uint8Array; edited?: boolean; wholeRewrite?: boolean; password?: string | null }
  | { type: 'SAVED'; id: string; bytes: Uint8Array; name: string; handle?: unknown }
  | { type: 'SET_RECENT_ID'; id: string; recentId: string }
  | { type: 'SET_ROUTE'; route: Route }
  | { type: 'SET_LOCALE'; locale: Locale }
  | { type: 'SET_RECENTS'; recents: RecentItem[] }
  | { type: 'TOAST'; toast: Toast }
  | { type: 'DISMISS_TOAST'; id: string };

export function initialState(locale: Locale): AppState {
  return { locale, documents: {}, order: [], route: { name: 'home', section: 'home' }, recents: [], toasts: [] };
}

function updateDoc(state: AppState, id: string, fn: (d: OpenDocument) => OpenDocument): AppState {
  const doc = state.documents[id];
  if (!doc) return state;
  return { ...state, documents: { ...state.documents, [id]: fn(doc) } };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'OPEN_DOCUMENT': {
      const doc: OpenDocument = {
        id: action.id,
        name: action.name,
        bytes: action.bytes,
        originalBytes: action.bytes.slice(),
        revision: 0,
        switching: true,
        // A document made by a tool (Combine, Create PDF) exists only in memory until the user saves it.
        warraqOwnsDocument: !!action.unsaved,
        edited: !!action.unsaved,
        pageCount: 0,
        recentId: action.recentId,
        handle: action.handle,
        pendingTool: action.tool,
        password: action.password,
      };
      return {
        ...state,
        documents: { ...state.documents, [action.id]: doc },
        order: state.order.includes(action.id) ? state.order : [...state.order, action.id],
        route: { name: 'document', id: action.id },
      };
    }
    case 'CLOSE_DOCUMENT': {
      if (!state.documents[action.id]) return state;
      const documents = { ...state.documents };
      delete documents[action.id];
      const order = state.order.filter((x) => x !== action.id);
      const last = order[order.length - 1];
      const route: Route =
        state.route.name === 'document' && state.route.id === action.id
          ? last
            ? { name: 'document', id: last }
            : { name: 'home', section: 'home' }
          : state.route;
      return { ...state, documents, order, route };
    }
    case 'VIEWER_READY':
      return updateDoc(state, action.id, (d) =>
        d.revision === action.revision ? { ...d, switching: false, pageCount: action.pageCount } : d,
      );
    case 'VIEWER_EDITED':
      return updateDoc(state, action.id, (d) =>
        d.edited && !d.warraqOwnsDocument ? d : { ...d, edited: true, warraqOwnsDocument: false },
      );
    case 'CORE_REPLACED_BYTES':
      return updateDoc(state, action.id, (d) => ({
        ...d,
        bytes: action.bytes,
        originalBytes: action.wholeRewrite ? action.bytes.slice() : d.originalBytes,
        password: action.password === undefined ? d.password : (action.password ?? undefined),
        revision: d.revision + 1,
        switching: true,
        warraqOwnsDocument: true,
        edited: action.edited ?? true,
      }));
    case 'SAVED':
      return updateDoc(state, action.id, (d) => ({
        ...d,
        name: action.name,
        bytes: action.bytes,
        originalBytes: action.bytes.slice(),
        revision: d.revision + 1,
        switching: true,
        warraqOwnsDocument: false,
        edited: false,
        handle: action.handle ?? d.handle,
      }));
    case 'TOOL_STARTED':
      return updateDoc(state, action.id, (d) => (d.pendingTool ? { ...d, pendingTool: undefined } : d));
    case 'SET_RECENT_ID':
      return updateDoc(state, action.id, (d) => ({ ...d, recentId: action.recentId }));
    case 'SET_ROUTE':
      return { ...state, route: action.route };
    case 'SET_LOCALE':
      return state.locale === action.locale ? state : { ...state, locale: action.locale };
    case 'SET_RECENTS':
      return { ...state, recents: action.recents };
    case 'TOAST':
      return { ...state, toasts: [...state.toasts.filter((t) => t.id !== action.toast.id), action.toast].slice(-3) };
    case 'DISMISS_TOAST':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
  }
}
