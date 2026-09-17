import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ChangeEvent, Dispatch, ReactNode } from 'react';
import { getSharedCoreClient } from '../core/client';
import {
  isTauriHost,
  onNativeFileDrop,
  pickPdfFile,
  savePdfFile,
  takeStartupFile,
} from '../core/host-tauri';
import type { PickedFile } from '../core/host-tauri';
import type { CoreClient, RemoteDocument } from '../core/client';
import { loadEditFont } from '../edit/editFont';
import { redo as redoStack, undo as undoStack } from '../edit/editStack';
import type { EditEntry, StackStep } from '../edit/editStack';
import type { TKey } from '../i18n/messages';
import { appReducer, createInitialState } from './appReducer';
import type { AppAction, AppState } from './appReducer';
import { readPreferences, writePreferences } from './preferences';
import { addRecent, clearRecent as clearStoredRecent, readRecent } from './recent';
import { downloadPdf, pdfFileName } from './saveFile';

export interface AppServices {
  client: CoreClient;
  /** Live handle of the open document (not serializable, so it lives outside the reducer). */
  document: RemoteDocument | null;
  recent: string[];
  openFile: (file: File) => Promise<void>;
  /** Opens the first PDF in a drop or picker selection. */
  openFiles: (files: ArrayLike<File>) => Promise<void>;
  closeDocument: () => void;
  /** Shows the file picker: the native panel on desktop, `<input type="file">` in a browser. */
  requestOpenFile: () => void;
  clearRecent: () => void;
  /** Replaces a paragraph and records it on the undo stack. */
  commitParagraph: (entry: EditEntry) => Promise<void>;
  /** Draws a new line of text at a point on a page, in page points. */
  addText: (page: number, x: number, y: number, size: number, text: string) => Promise<void>;
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

/** A file the desktop host read for us, in the shape the open path expects. */
function toFile(picked: PickedFile): File {
  return new File([picked.bytes], picked.name, { type: 'application/pdf' });
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function errorKeyFor(err: unknown): TKey {
  const code = (err as { code?: string } | null)?.code;
  return code === 'E_PASSWORD' ? 'error.password' : 'error.open';
}

const TOAST_MS = 3000;

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, undefined, () =>
    createInitialState(readPreferences()),
  );
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
        if (sequence === openSequence.current)
          dispatch({ type: 'DOCUMENT_FAILED', error: errorKeyFor(err) });
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

  /**
   * A browser opens the hidden `<input type="file">`; the desktop webview
   * ignores that element entirely, so it goes through the native open panel.
   * A failure here used to be invisible — the click simply did nothing — so
   * it now reports itself like any other failed open.
   */
  const requestOpenFile = useCallback(() => {
    if (!isTauriHost()) {
      fileInputRef.current?.click();
      return;
    }
    void (async () => {
      try {
        const picked = await pickPdfFile();
        if (!picked) return;
        await openFile(toFile(picked));
      } catch {
        dispatch({ type: 'DOCUMENT_FAILED', error: 'error.open' });
      }
    })();
  }, [openFile]);

  // A file named on the command line, opened once. The host hands it over
  // only the first time it is asked, so a reload does not reopen it.
  useEffect(() => {
    let cancelled = false;
    void takeStartupFile()
      .then((picked) => {
        if (picked && !cancelled) void openFile(toFile(picked));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [openFile]);

  /**
   * Under Tauri the OS drop is swallowed natively and re-emitted by the host,
   * so the shell's HTML5 `drop` listener never fires. In a browser this is a
   * no-op and that listener is the only one.
   */
  useEffect(() => onNativeFileDrop((files) => void openFiles(files.map(toFile))), [openFiles]);

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
        const font = await loadEditFont(stateRef.current.edit.font);
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

  /**
   * A new line of text where the user pointed. Unlike a paragraph replacement
   * this is not recorded on the undo stack — the stack replays replacements,
   * and there is no paragraph here to replay — so the panel says so plainly
   * instead of offering an Undo that would do nothing.
   */
  const addText = useCallback(
    async (page: number, x: number, y: number, size: number, text: string) => {
      const doc = documentRef.current;
      if (!doc || stateRef.current.edit.busy) return;
      if (text.trim().length === 0) {
        dispatch({ type: 'EDIT_CANCEL' });
        return;
      }
      dispatch({ type: 'EDIT_BUSY', busy: true });
      try {
        const font = await loadEditFont(stateRef.current.edit.font);
        await doc.add_text(page, x, y, size, text, font);
        dispatch({ type: 'EDIT_ADDED', page });
      } catch {
        dispatch({ type: 'EDIT_BUSY', busy: false });
        dispatch({ type: 'DOCUMENT_FAILED', error: 'edit.failed' });
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
      const fontSubstituted = await replaceParagraph(
        change.page,
        change.paragraphIndex,
        change.text,
      );
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
      if (isTauriHost()) {
        // Cancelling the panel is not a failure, and not a save either.
        if (!(await savePdfFile(bytes, pdfFileName(name)))) return;
      } else {
        downloadPdf(bytes, name);
      }
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
      addText,
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
      addText,
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
