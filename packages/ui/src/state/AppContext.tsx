import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, ReactNode } from 'react';
import { getSharedCoreClient } from '../core/client';
import type { CoreClient, RemoteDocument } from '../core/client';
import type { TKey } from '../i18n/messages';
import { appReducer, createInitialState } from './appReducer';
import type { AppAction, AppState } from './appReducer';
import { readPreferences, writePreferences } from './preferences';
import { addRecent, clearRecent as clearStoredRecent, readRecent } from './recent';

export interface AppServices {
  client: CoreClient;
  /** Live handle of the open document (not serializable, so it lives outside the reducer). */
  document: RemoteDocument | null;
  recent: string[];
  openFile: (file: File) => Promise<void>;
  /** Opens the first PDF in a drop or picker selection. */
  openFiles: (files: ArrayLike<File>) => Promise<void>;
  closeDocument: () => void;
  /** Shows the native file picker (`<input type="file">`). */
  requestOpenFile: () => void;
  clearRecent: () => void;
}

const StateContext = createContext<AppState | null>(null);
const DispatchContext = createContext<Dispatch<AppAction> | null>(null);
const ServicesContext = createContext<AppServices | null>(null);

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function errorKeyFor(err: unknown): TKey {
  const code = (err as { code?: string } | null)?.code;
  return code === 'E_PASSWORD' ? 'error.password' : 'error.open';
}

const TOAST_MS = 3000;

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, undefined, () => createInitialState(readPreferences()));
  const [document, setDocument] = useState<RemoteDocument | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const documentRef = useRef<RemoteDocument | null>(null);
  const openSequence = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const client = useMemo(() => getSharedCoreClient(), []);

  useEffect(() => {
    let cancelled = false;
    client.init().then((status) => {
      if (!cancelled) dispatch({ type: 'CORE_STATUS', status });
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Theme: manual override lives on <html data-theme>; "system" removes it.
  useEffect(() => {
    const root = globalThis.document.documentElement;
    if (state.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = state.theme;
    writePreferences({ theme: state.theme });
  }, [state.theme]);

  const { open: leftOpen, width: leftWidth, tab: leftTab } = state.leftPane;
  const { open: rightOpen, width: rightWidth } = state.rightPane;
  useEffect(() => {
    writePreferences({
      leftPaneOpen: leftOpen,
      leftPaneWidth: leftWidth,
      leftTab,
      rightPaneOpen: rightOpen,
      rightPaneWidth: rightWidth,
    });
  }, [leftOpen, leftWidth, leftTab, rightOpen, rightWidth]);

  const toastNonce = state.toast?.nonce;
  useEffect(() => {
    if (toastNonce === undefined) return;
    const timer = setTimeout(() => dispatch({ type: 'TOAST_CLEARED' }), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toastNonce]);

  const openFile = useCallback(
    async (file: File) => {
      if (!isPdfFile(file)) {
        dispatch({ type: 'DOCUMENT_FAILED', error: 'error.notPdf' });
        return;
      }
      openSequence.current += 1;
      const sequence = openSequence.current;
      dispatch({ type: 'DOCUMENT_LOADING', name: file.name });
      try {
        const bytes = await file.arrayBuffer();
        const opened = await client.open(bytes);
        if (sequence !== openSequence.current) {
          void opened.free();
          return;
        }
        void documentRef.current?.free();
        documentRef.current = opened;
        setDocument(opened);
        dispatch({
          type: 'DOCUMENT_OPENED',
          document: {
            id: opened.id,
            name: file.name,
            pageCount: opened.pageCount,
            pageSizes: opened.pageSizes,
            metadata: opened.info,
          },
        });
        setRecent(addRecent(file.name));
      } catch (err) {
        if (sequence === openSequence.current) dispatch({ type: 'DOCUMENT_FAILED', error: errorKeyFor(err) });
      }
    },
    [client],
  );

  const openFiles = useCallback(
    async (files: ArrayLike<File>) => {
      const list = Array.from(files);
      const pdf = list.find(isPdfFile) ?? list[0];
      if (pdf) await openFile(pdf);
    },
    [openFile],
  );

  const closeDocument = useCallback(() => {
    openSequence.current += 1;
    void documentRef.current?.free();
    documentRef.current = null;
    setDocument(null);
    dispatch({ type: 'DOCUMENT_CLOSED' });
  }, []);

  const requestOpenFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const clearRecent = useCallback(() => {
    clearStoredRecent();
    setRecent([]);
  }, []);

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) void openFiles(files);
    event.target.value = '';
  };

  const services = useMemo<AppServices>(
    () => ({ client, document, recent, openFile, openFiles, closeDocument, requestOpenFile, clearRecent }),
    [client, document, recent, openFile, openFiles, closeDocument, requestOpenFile, clearRecent],
  );

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <ServicesContext.Provider value={services}>
          {children}
          {/* Hidden picker behind File → Open and Ctrl/Cmd+O. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={onFileInput}
          />
        </ServicesContext.Provider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

function useRequired<T>(context: React.Context<T | null>, name: string): T {
  const value = useContext(context);
  if (value === null) throw new Error(`${name} must be used inside <AppProvider>`);
  return value;
}

export function useAppState(): AppState {
  return useRequired(StateContext, 'useAppState');
}

export function useAppDispatch(): Dispatch<AppAction> {
  return useRequired(DispatchContext, 'useAppDispatch');
}

export function useServices(): AppServices {
  return useRequired(ServicesContext, 'useServices');
}
