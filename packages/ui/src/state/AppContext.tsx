import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, ReactNode } from 'react';
import { getSharedCoreClient } from '../core/client';
import type { CoreClient, RemoteDocument } from '../core/client';
import { loadEditFont } from '../edit/editFont';
import { redo as redoStack, undo as undoStack } from '../edit/editStack';
import type { EditEntry, StackStep } from '../edit/editStack';
import type { TKey } from '../i18n/messages';
import { appReducer, createInitialState } from './appReducer';
import type { AppAction, AppState } from './appReducer';
import { readPreferences, writePreferences } from './preferences';
import { addRecent, clearRecent as clearStoredRecent, readRecent } from './recent';
import { downloadPdf } from './saveFile';

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
  /** Replaces a paragraph and records it on the undo stack. */
  commitParagraph: (entry: EditEntry) => Promise<void>;
  /** Re-applies the previous text of the last edit. */
  undoEdit: () => Promise<void>;
  /** Re-applies the text that was undone. */
  redoEdit: () => Promise<void>;
  /** `save()` plus a download of `<original-name>.pdf`. */
  saveDocument: () => Promise<void>;
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
  // Async work reads the latest state through this ref, never a stale closure.
  const stateRef = useRef(state);
  const openSequence = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const client = useMemo(() => getSharedCoreClient(), []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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

  /**
   * One call per applied change, shared by commit, undo and redo: the core is
   * always asked for the same thing — "this paragraph now reads like this".
   * `busy` keeps a second click from racing the first, and a failure leaves the
   * stack untouched so the UI never claims an edit the document does not have.
   */
  const replaceParagraph = useCallback(
    async (page: number, paragraphIndex: number, text: string): Promise<boolean | null> => {
      const doc = documentRef.current;
      if (!doc || stateRef.current.edit.busy) return null;
      dispatch({ type: 'EDIT_BUSY', busy: true });
      try {
        const font = await loadEditFont();
        const result = await doc.replace_paragraph(page, paragraphIndex, text, font);
        return result.fontSubstituted;
      } catch {
        dispatch({ type: 'EDIT_BUSY', busy: false });
        dispatch({ type: 'DOCUMENT_FAILED', error: 'edit.failed' });
        return null;
      }
    },
    [],
  );

  const commitParagraph = useCallback(
    async (entry: EditEntry) => {
      if (entry.after === entry.before) {
        dispatch({ type: 'EDIT_CANCEL' });
        return;
      }
      const fontSubstituted = await replaceParagraph(entry.page, entry.paragraphIndex, entry.after);
      if (fontSubstituted === null) return;
      dispatch({ type: 'EDIT_APPLIED', entry, fontSubstituted });
    },
    [replaceParagraph],
  );

  const step = useCallback(
    async (next: (stack: AppState['edit']['stack']) => StackStep | null) => {
      const taken = next(stateRef.current.edit.stack);
      if (!taken) return;
      const { change, stack } = taken;
      const fontSubstituted = await replaceParagraph(change.page, change.paragraphIndex, change.text);
      if (fontSubstituted === null) return;
      dispatch({ type: 'EDIT_STEPPED', stack, page: change.page, fontSubstituted });
    },
    [replaceParagraph],
  );

  const undoEdit = useCallback(() => step(undoStack), [step]);
  const redoEdit = useCallback(() => step(redoStack), [step]);

  const saveDocument = useCallback(async () => {
    const doc = documentRef.current;
    const name = stateRef.current.document?.name;
    if (!doc || !name) return;
    try {
      const bytes = await doc.save();
      downloadPdf(bytes, name);
      dispatch({ type: 'DOCUMENT_SAVED' });
      dispatch({ type: 'TOAST', key: 'file.saved' });
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'file.saveFailed' });
    }
  }, []);

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) void openFiles(files);
    event.target.value = '';
  };

  const services = useMemo<AppServices>(
    () => ({
      client,
      document,
      recent,
      openFile,
      openFiles,
      closeDocument,
      requestOpenFile,
      clearRecent,
      commitParagraph,
      undoEdit,
      redoEdit,
      saveDocument,
    }),
    [
      client,
      document,
      recent,
      openFile,
      openFiles,
      closeDocument,
      requestOpenFile,
      clearRecent,
      commitParagraph,
      undoEdit,
      redoEdit,
      saveDocument,
    ],
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
