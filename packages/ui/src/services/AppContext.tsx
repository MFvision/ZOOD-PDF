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
  saveDocument(id: string, opts?: { saveAs?: boolean }): Promise<boolean>;
  updateRecent(id: string, patch: Partial<Pick<RecentItem, 'starred' | 'tags'>>): Promise<void>;
  removeRecent(id: string): Promise<void>;
  registerViewer(docId: string, api: ViewerApi | null): void;
  viewer(docId: string): ViewerApi | undefined;
  markSensitive(docId: string): void;
  storeThumbnail(docId: string, png: Uint8Array): Promise<void>;
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
    sensitive.current.delete(id);
    dispatch({ type: 'CLOSE_DOCUMENT', id });
  }, []);

  const saveDocument = useCallback(
    async (id: string, opts: { saveAs?: boolean } = {}) => {
      const doc: OpenDocument | undefined = stateRef.current.documents[id];
      if (!doc) return false;
      try {
        let out: Uint8Array;
        if (doc.warraqOwnsDocument) {
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
    storeThumbnail: async (docId, png) => {
      const rid = stateRef.current.documents[docId]?.recentId;
      if (!rid || sensitive.current.has(docId)) return;
      await recents.setThumbnail(rid, png);
      await refreshRecents();
    },
  };

  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}
