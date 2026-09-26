/**
 * AppContext: the reducer state plus the services the interface uses (host files, recents, engine,
 * viewers). Components never talk to IndexedDB, the host or the engine directly.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { createTranslator, detectLocale, dirFor, isLocale, type Locale, type Translate } from '../i18n';
import { initialState, reducer, type Action, type AppState, type OpenDocument } from './state';
import { createRecentsStore, type RecentItem, type RecentsStore } from './recents';
import { getHost, type HostBridge, type OpenedFile } from './host';
import { engine as sharedEngine, type EngineClient } from './engine';
import { isPdfBytes } from './files';
import { looksProtected, rebaseOnOriginal, saveStrategy } from './save';
import { runOnBytes, type CoreCall, type CoreResult } from './coreOps';
import { createHistory, type History } from './history';
import type { ViewerApi } from '../viewer/Viewer';
import type { Platform } from '../tools/registry';

export type ThemePref = 'system' | 'light' | 'dark';

export interface AppServices {
  state: AppState;
  dispatch: (a: Action) => void;
  t: Translate;
  platform: Platform;
  host: HostBridge;
  theme: ThemePref;
  scheme: 'light' | 'dark';
  setTheme(theme: ThemePref): void;
  setLocale(locale: Locale): void;
  toast(message: string, tone?: 'info' | 'success' | 'error'): void;
  openFromHost(tool?: string): Promise<void>;
  openFiles(files: OpenedFile[], tool?: string): Promise<void>;
  openRecent(item: RecentItem): Promise<void>;
  closeDocument(id: string): void;
  /** `bytes`: save these instead (a core tool's finished incremental update, e.g. a signature). */
  saveDocument(id: string, opts?: { saveAs?: boolean; bytes?: Uint8Array }): Promise<boolean>;
  updateRecent(id: string, patch: Partial<Pick<RecentItem, 'starred' | 'tags'>>): Promise<void>;
  removeRecent(id: string): Promise<void>;
  registerViewer(docId: string, api: ViewerApi | null): void;
  viewer(docId: string): ViewerApi | undefined;
  markSensitive(docId: string): void;
  storeThumbnail(docId: string, png: Uint8Array): Promise<void>;
  // ---- core tools (Organize, Combine, Compress) ----
  /** The engine client (shared worker; core tools: Organize, Combine, Compress, Export, Compare…). */
  engine(): EngineClient;
  /** The document's bytes including unsaved viewer (PDFium) edits, folded in as an incremental update
   * (`doc.rebase` on the current bytes; PDFium's whole rewrite after an applied redaction). */
  currentBytes(docId: string): Promise<Uint8Array>;
  /** Runs engine calls on the current bytes WITHOUT changing the document (extract, split, compress…). */
  runOnDocument<J = unknown>(docId: string, calls: CoreCall[]): Promise<CoreResult<J>>;
  /** Runs mutating engine calls; the result replaces the document (undoable). Null when nothing changed. */
  coreEdit<J = unknown>(docId: string, calls: CoreCall[], label: string): Promise<CoreResult<J> | null>;
  undoCore(docId: string): Promise<boolean>;
  redoCore(docId: string): Promise<boolean>;
  historyOf(docId: string): { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string };
  /** Opens bytes made by a tool (e.g. Combine) as a new, unsaved document. */
  openNewDocument(name: string, bytes: Uint8Array): Promise<void>;
  /** Saves bytes made by a tool as a new file (always asks where). */
  saveNewFile(name: string, bytes: Uint8Array, mimeType?: string): Promise<boolean>;
}

const Ctx = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside <AppProvider>');
  return v;
}

const LOCALE_KEY = 'zood.locale';
const THEME_KEY = 'zood.theme';

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: preference just isn't remembered */
  }
}

function startLocale(): Locale {
  const saved = readPref(LOCALE_KEY);
  if (isLocale(saved)) return saved;
  return detectLocale(typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []);
}

function useSystemScheme(): 'light' | 'dark' {
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark ? 'dark' : 'light';
}

let docCounter = 0;
const newDocId = () => `doc-${Date.now().toString(36)}-${++docCounter}`;

export interface AppProviderProps {
  children: ReactNode;
  platform?: Platform;
  host?: HostBridge;
  recents?: RecentsStore;
  engine?: EngineClient;
  initialLocale?: Locale;
}

export function AppProvider({ children, platform = 'web', host: hostProp, recents: recentsProp, engine: engineProp, initialLocale }: AppProviderProps) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(initialLocale ?? startLocale()));
  const host = useMemo(() => hostProp ?? getHost(), [hostProp]);
  const recents = useMemo(() => recentsProp ?? createRecentsStore(), [recentsProp]);
  const engineRef = useRef<EngineClient | null>(engineProp ?? null);
  const getEngine = () => (engineRef.current ??= sharedEngine());
  const viewers = useRef(new Map<string, ViewerApi>());
  const histories = useRef(new Map<string, History>());
  const [, setHistoryTick] = useState(0);
  const historyFor = (docId: string): History => {
    let h = histories.current.get(docId);
    if (!h) {
      h = createHistory();
      histories.current.set(docId, h);
    }
    return h;
  };
  const sensitive = useRef(new Set<string>());
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const [theme, setThemeState] = useState<ThemePref>(() => {
    const v = readPref(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  });
  const system = useSystemScheme();
  const scheme = theme === 'system' ? system : theme;
  const t = useMemo(() => createTranslator(state.locale), [state.locale]);

  // <html lang dir>, title and theme follow the app state.
  useEffect(() => {
    const html = document.documentElement;
    html.lang = state.locale;
    html.dir = dirFor(state.locale);
    document.title = t('app.name');
  }, [state.locale, t]);
  useEffect(() => {
    const html = document.documentElement;
    if (theme === 'system') html.removeAttribute('data-theme');
    else html.dataset.theme = theme;
  }, [theme]);

  const toast = useCallback((message: string, tone: 'info' | 'success' | 'error' = 'info') => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    dispatch({ type: 'TOAST', toast: { id, message, tone } });
    setTimeout(() => dispatch({ type: 'DISMISS_TOAST', id }), tone === 'error' ? 6000 : 3200);
  }, []);

  const refreshRecents = useCallback(async () => {
    try {
      dispatch({ type: 'SET_RECENTS', recents: await recents.list() });
    } catch {
      /* IndexedDB unavailable (private mode): recents simply stay empty */
    }
  }, [recents]);

  useEffect(() => {
    void refreshRecents();
  }, [refreshRecents]);

  const openFiles = useCallback(
    async (files: OpenedFile[], tool?: string) => {
      for (const f of files) {
        if (!isPdfBytes(f.bytes)) {
          toast(t('toast.notPdf', { name: f.name }), 'error');
          continue;
        }
        const id = newDocId();
        let recentId: string | undefined;
        try {
          recentId = (await recents.add({ name: f.name, bytes: f.bytes })).id;
        } catch {
          /* recents are a convenience (IndexedDB may be unavailable) */
        }
        dispatch({ type: 'OPEN_DOCUMENT', id, name: f.name, bytes: f.bytes, handle: f.handle, recentId, tool });
        void refreshRecents();
      }
    },
    [recents, refreshRecents, t, toast],
  );

  const openFromHost = useCallback(async (tool?: string) => {
    try {
      const files = await host.openFiles({ multiple: !tool });
      await openFiles(files, tool);
    } catch (e) {
      toast(t('toast.openFailed', { name: e instanceof Error ? e.message : '' }), 'error');
    }
  }, [host, openFiles, t, toast]);

  const openRecent = useCallback(
    async (item: RecentItem) => {
      // Already open (possibly with unsaved edits): switch to it instead of opening a second copy.
      const open = Object.values(stateRef.current.documents).find((d) => d.recentId === item.id);
      if (open) {
        dispatch({ type: 'SET_ROUTE', route: { name: 'document', id: open.id } });
        return;
      }
      const bytes = item.hasBytes ? await recents.getBytes(item.id) : undefined;
      if (!bytes) {
        toast(t('recents.reselect', { name: item.name }));
        await openFromHost();
        return;
      }
      await recents.add({ name: item.name, bytes });
      dispatch({ type: 'OPEN_DOCUMENT', id: newDocId(), name: item.name, bytes, recentId: item.id });
      void refreshRecents();
    },
    [openFromHost, recents, refreshRecents, t, toast],
  );

  const closeDocument = useCallback((id: string) => {
    viewers.current.delete(id);
    histories.current.delete(id);
    sensitive.current.delete(id);
    dispatch({ type: 'CLOSE_DOCUMENT', id });
  }, []);

  const saveDocument = useCallback(
    async (id: string, opts: { saveAs?: boolean; bytes?: Uint8Array } = {}) => {
      const doc: OpenDocument | undefined = stateRef.current.documents[id];
      if (!doc) return false;
      try {
        let out: Uint8Array;
        if (opts.bytes) {
          out = opts.bytes;
        } else if (doc.warraqOwnsDocument) {
          out = doc.bytes; // the core already produced an incremental update
        } else if (doc.edited) {
          const api = viewers.current.get(id);
          if (!api) throw new Error('viewer not ready');
          const pdfium = await api.exportBytes();
          const strategy = saveStrategy({ original: doc.originalBytes, pdfium, redacted: sensitive.current.has(id) });
          out = strategy.mode === 'rewrite' ? pdfium : (await rebaseOnOriginal(getEngine(), doc.originalBytes, pdfium)).bytes;
        } else {
          out = doc.originalBytes;
        }
        const res = await host.saveFile(doc.name, out, { handle: doc.handle, saveAs: opts.saveAs });
        if (!res) return false;
        dispatch({ type: 'SAVED', id, bytes: out, name: res.name, handle: res.handle });
        // Saved bytes are the new baseline: earlier versions are no longer "the document".
        histories.current.get(id)?.clear();
        setHistoryTick((n) => n + 1);
        if (doc.recentId) {
          if (sensitive.current.has(id) || looksProtected(out)) {
            await recents.forgetThumbnail(doc.recentId);
          } else {
            await recents.putBytes(doc.recentId, out);
          }
          await refreshRecents();
        }
        toast(t('toast.saved', { name: res.name }), 'success');
        return true;
      } catch (e) {
        const reason = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
        toast(t('toast.saveFailed', { reason }), 'error');
        return false;
      }
    },
    [host, recents, refreshRecents, t, toast],
  );

  const registerViewer = useCallback((docId: string, api: ViewerApi | null) => {
    if (api) viewers.current.set(docId, api);
    else viewers.current.delete(docId);
  }, []);
  const viewer = useCallback((docId: string) => viewers.current.get(docId), []);

  const currentBytes = useCallback(
    async (docId: string): Promise<Uint8Array> => {
      const doc = stateRef.current.documents[docId];
      if (!doc) throw new Error('document is not open');
      if (!doc.edited || doc.warraqOwnsDocument) return doc.bytes;
      const api = viewers.current.get(docId);
      if (!api) return doc.bytes;
      const pdfium = await api.exportBytes();
      // Redaction must not leave the old content in the file: keep PDFium's whole rewrite.
      if (sensitive.current.has(docId)) return pdfium;
      return (await rebaseOnOriginal(getEngine(), doc.bytes, pdfium)).bytes;
    },
    [],
  );

  const replaceBytes = useCallback((docId: string, before: Uint8Array, after: Uint8Array, label: string) => {
    historyFor(docId).record(before, after, label);
    dispatch({ type: 'CORE_REPLACED_BYTES', id: docId, bytes: after });
    setHistoryTick((n) => n + 1);
  }, []);

  const coreEdit = useCallback(
    async <J,>(docId: string, calls: CoreCall[], label: string): Promise<CoreResult<J> | null> => {
      const doc = stateRef.current.documents[docId];
      if (!doc) return null;
      const base = await currentBytes(docId);
      if (base !== doc.bytes) replaceBytes(docId, doc.bytes, base, 'viewer');
      const res = await runOnBytes<J>(getEngine(), base, calls);
      if (!res.bytes || res.bytes.byteLength === 0) return null;
      replaceBytes(docId, base, res.bytes, label);
      return res;
    },
    [currentBytes, replaceBytes],
  );

  const stepHistory = useCallback(
    async (docId: string, dir: 'undo' | 'redo'): Promise<boolean> => {
      const doc = stateRef.current.documents[docId];
      if (!doc) return false;
      const h = historyFor(docId);
      // Unsaved viewer edits become their own step first, so undo never silently drops them.
      const base = await currentBytes(docId);
      if (base !== doc.bytes) {
        if (dir === 'redo') return false;
        h.record(doc.bytes, base, 'viewer');
      }
      const step = dir === 'undo' ? h.undo(base) : h.redo(base);
      if (!step) return false;
      dispatch({ type: 'CORE_REPLACED_BYTES', id: docId, bytes: step.bytes });
      setHistoryTick((n) => n + 1);
      return true;
    },
    [currentBytes],
  );

  const services: AppServices = {
    state,
    dispatch,
    t,
    platform,
    host,
    theme,
    scheme,
    setTheme: (v) => {
      setThemeState(v);
      writePref(THEME_KEY, v);
    },
    setLocale: (l) => {
      writePref(LOCALE_KEY, l);
      dispatch({ type: 'SET_LOCALE', locale: l });
    },
    toast,
    openFromHost,
    openFiles,
    openRecent,
    closeDocument,
    saveDocument,
    updateRecent: async (rid, patch) => {
      await recents.update(rid, patch);
      await refreshRecents();
    },
    removeRecent: async (rid) => {
      await recents.remove(rid);
      await refreshRecents();
    },
    registerViewer,
    viewer,
    markSensitive: (docId) => {
      sensitive.current.add(docId);
      const rid = stateRef.current.documents[docId]?.recentId;
      if (rid) void recents.forgetThumbnail(rid).then(refreshRecents);
    },
    engine: getEngine,
    currentBytes,
    runOnDocument: async (docId, calls) => runOnBytes(getEngine(), await currentBytes(docId), calls),
    coreEdit,
    undoCore: (docId) => stepHistory(docId, 'undo'),
    redoCore: (docId) => stepHistory(docId, 'redo'),
    historyOf: (docId) => {
      const h = histories.current.get(docId);
      return { canUndo: !!h?.canUndo(), canRedo: !!h?.canRedo(), undoLabel: h?.undoLabel(), redoLabel: h?.redoLabel() };
    },
    openNewDocument: async (name, bytes) => {
      let recentId: string | undefined;
      try {
        recentId = (await recents.add({ name, bytes })).id;
      } catch {
        /* recents are a convenience */
      }
      dispatch({ type: 'OPEN_DOCUMENT', id: newDocId(), name, bytes, recentId, unsaved: true });
      void refreshRecents();
    },
    saveNewFile: async (name, bytes, mimeType) => {
      try {
        const res = await host.saveFile(name, bytes, { saveAs: true, mimeType });
        if (!res) return false;
        toast(t('toast.saved', { name: res.name }), 'success');
        return true;
      } catch (e) {
        const reason = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
        toast(t('toast.saveFailed', { reason }), 'error');
        return false;
      }
    },
    storeThumbnail: async (docId, png) => {
      const rid = stateRef.current.documents[docId]?.recentId;
      if (!rid || sensitive.current.has(docId)) return;
      await recents.setThumbnail(rid, png);
      await refreshRecents();
    },
  };

  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}
