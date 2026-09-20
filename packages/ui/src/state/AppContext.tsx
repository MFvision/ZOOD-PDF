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
import { installDesktopFileBridge } from '../core/desktopFiles';
import { CREATE_ACCEPT, CREATE_EXTENSIONS } from '../create/createPdf';
import {
  isTauriHost,
  pickFiles,
  pickPdfFile,
  printAvailable,
  printMode,
  printPdf,
  printWebview,
  savePdfFile,
  takeStartupFile,
} from '../core/host-tauri';
import type { PickedFile } from '../core/host-tauri';
import type { CoreClient, RemoteDocument } from '../core/client';
import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import { EMBED_COMMANDS, NO_TOGGLES, addRedactionMarks, capability, disabledCategories, printAllowed, runCommand, scrollToPage, setKeyboard, watch, watchPendingRedactions, watchToggles } from '../embed/embedControl';
import type { RedactionMark, ViewCommand, ViewToggles } from '../embed/embedControl';
import { installViewText } from '../embed/embedText';
import { uuidV4 } from '@embedpdf/models';
import { loadEditFont } from '../edit/editFont';
import { resetEditPdf } from '../edit/editPdf';
import { canRedo as canRedoStack, canUndo as canUndoStack, isFileEntry, redo as redoStack, snapshotsIn, undo as undoStack } from '../edit/editStack';
import type { EditEntry, StackStep } from '../edit/editStack';
import type { TKey } from '../i18n/messages';
import { appReducer, createInitialState, warraqOwnsDocument } from './appReducer';
import type { AppAction, AppState } from './appReducer';
import { readJson, readPreferences, writePreferences } from './preferences';
import { drawPages, mountSheet } from '../print/printPages';
import { keepFirstPage } from '../home/recentPicture';
import { addRecent, clearRecent as clearStoredRecent, forgetRecentThumbnail, readRecent } from './recent';
import { isPdf, namedLikePdf } from './pdfFile';
import { combinedFileName, downloadPdf, extractedFileName, pdfFileName, saveBytes, splitArchiveName } from './saveFile';
import { zipSync } from 'fflate';
import { findTool } from '../tools/tools';
import { keepPolicy, mentionsSignature } from '../signatures/marker';
import type { OcrLanguage } from '../ocr/engine';
import { recognizeFile } from '../ocr/run';
import type { OcrProgress, OcrScope, ReadOptions } from '../ocr/run';
import { runSelfCheck } from '../ocr/selfCheck';

/** What Scan & OCR did. */
export interface OcrOutcome {
  /** Pages given a text layer. */
  pages: number;
  words: number;
  /** Pages that already had Warraq's text layer. */
  skipped: number;
  /** Tesseract's mean confidence over the words it read, 0–100. */
  confidence: number;
  /** Pages whose scan was replaced by the cleaned-up one, and pages that kept theirs. */
  images?: number;
  imagesKept?: number;
}

/** How much Compress may trade: `imageDpi` downsamples images (lossy); absent keeps them. */
export interface CompressChoice {
  imageDpi?: number;
  jpegQuality?: number;
}

/** What Compress did, and the smaller copy; or why it would not. */
export type CompressResult =
  | { refused: 'protected' | 'signed' }
  | {
      bytes: ArrayBuffer;
      before: number;
      after: number;
      images: number;
      duplicates: number;
      unused: number;
      unchanged: boolean;
    };

/** One file for Combine files; `password` for a protected one. */
export interface CombineInput {
  name: string;
  bytes: ArrayBuffer;
  password?: string;
}

/** The page changes of Organize pages (`warraq-core/src/tools/pages.rs`). */
export type OrganizeOp = 'rotate' | 'reorder' | 'delete' | 'insert_blank' | 'insert_file' | 'crop' | 'trim_margins';

/** A panel that takes the files dropped on the window, and what the drop overlay says it does. */
/** What a drop on an open document is for: joining it, or replacing it. */
export type DropIntent = 'combine' | 'open';

export interface DropTarget {
  label: TKey;
  take: (files: File[]) => void;
}

/** What became of inserting another file's pages. */
export type InsertOutcome = 'inserted' | 'locked' | 'wrongPassword' | 'failed';

/** How Print prints: the host prints the file (PDFKit), EmbedPDF does, or the pages are laid out here. */
export type PrintWay = 'pdfkit' | 'embed' | 'pages';

/** Pages drawn so far for printing by pages, of how many. */
export interface PrintProgress {
  done: number;
  total: number;
}

/** What a page change answers: the document's new shape. */
interface PageShape {
  pageCount: number;
  pageSizes: [number, number][];
}

/** How a file is opened. */
export interface OpenOptions {
  /** `false` keeps it out of the home screen's recent files (a cloud file is listed with its drive). */
  recent?: boolean;
}

/**
 * Where Save writes instead of this device, while something claims it: a
 * file opened from a cloud drive goes back to that drive (`cloud/`).
 */
export interface SaveTarget {
  /** Writes `bytes`. `saved` marks the file saved and shows `toast`; otherwise it stays edited. */
  save: (bytes: Uint8Array<ArrayBuffer>, name: string) => Promise<{ saved: true; toast: TKey } | { saved: false }>;
}

export interface AppServices {
  client: CoreClient;
  /** Live handle of the open document (not serializable, so it lives outside the reducer). */
  document: RemoteDocument | null;
  /**
   * The document's current bytes, for the EmbedPDF view (ADR-0007). A new
   * buffer by identity means the file changed and the view reopens it.
   */
  documentBytes: ArrayBuffer | null;
  /**
   * The file's own bytes as the view was given them: `documentBytes`, or —
   * while the view shows other layers by choice — the file with its own
   * layer visibility, not the view's copy. What its signatures are checked on.
   */
  fileBytes: ArrayBuffer | null;
  /** The password the open file was unlocked with, for the EmbedPDF view. Memory only. */
  documentPassword: string | undefined;
  recent: string[];
  /** Opens a PDF; a protected one asks for its password (`passwordPrompt`) first. */
  openFile: (file: File, password?: string, options?: OpenOptions) => Promise<void>;
  /** The File the open document came from, by identity (null with none open): who opened it can tell it is theirs. */
  openedFile: File | null;
  /** Tries the protected file again with this password. */
  unlockFile: (password: string) => void;
  cancelUnlock: () => void;
  /**
   * Files dropped on the window. A tool that claimed drops takes them; else,
   * with `combine`, they join the open file in Combine, and otherwise the PDF
   * opens — several PDFs with nothing open go to Combine together.
   */
  dropFiles: (files: ArrayLike<File>, intent?: DropIntent) => void;
  /** Files a drop sent to Combine, taken (once) by the panel as it opens. */
  takeCombineDrop: () => File[];
  /**
   * Create PDF: files of other kinds — Word, Excel, PowerPoint, web pages,
   * Markdown, text, pictures — to make into a PDF. The Create panel opens
   * and makes it at once; one already open adds them to its list.
   */
  startCreate: (files: readonly File[]) => void;
  /** Files `startCreate` sent to Create, taken (once) by its panel as it opens. */
  takeCreateFiles: () => File[];
  /** A panel claims the window's drops while it is open (`null` gives them back); Combine adds them to its list. */
  claimDrops: (target: DropTarget | null) => void;
  /** What the drop overlay says a drop will do. */
  dropLabel: TKey;
  /** A tool has claimed the window's drops. */
  dropClaimed: boolean;
  /** Opens the first PDF in a drop or picker selection. */
  openFiles: (files: ArrayLike<File>) => Promise<void>;
  closeDocument: () => void;
  /** Shows the file picker: the native panel on desktop, `<input type="file">` in a browser. */
  requestOpenFile: () => void;
  /**
   * Create PDF's picker: Word, Excel, PowerPoint, web pages, text and
   * pictures, several at once, which then go to `startCreate`. The same
   * hidden input as Open, so the page never has two.
   */
  requestCreateFiles: () => void;
  /** Called by the EmbedPDF view once its plugin registry is ready. */
  attachEmbed: (registry: PluginRegistry) => void;
  /** EmbedPDF's plugin registry once it is ready: the toolbar reads its zoom. */
  embedRegistry: PluginRegistry | null;
  /** Called by the EmbedPDF view each time it has opened a file, with the bytes it opened. */
  embedOpened: (bytes?: ArrayBuffer) => void;
  /** Runs one of the EmbedPDF viewer's registered commands (ADR-0007). */
  runEmbedCommand: (command: string) => void;
  /**
   * Whether EmbedPDF is the view on screen; Warraq's own takes over while
   * editing text. Menus, shortcuts and the toolbar act on whichever this
   * says — before, they always drove Warraq's view, and did nothing visible
   * while EmbedPDF showed the page.
   */
  embedShowing: boolean;
  /** Zoom, fit, find, the page sidebar, print, undo and redo, on the view on screen. */
  viewCommand: (command: ViewCommand) => void;
  /** Whether a toggle — fit width, fit page, the sidebar, find — is on in the view on screen. */
  viewCommandOn: (command: ViewCommand) => boolean;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * EmbedPDF prints through the browser's print dialog. The desktop app has no
   * route to the system one yet, so it offers no Print rather than a dead one.
   */
  canPrint: boolean;
  /** Printing by pages: how far drawing the pages for print has come; null when nothing is being prepared. */
  printing: PrintProgress | null;
  /** Stops preparing a print by pages. */
  cancelPrint: () => void;
  /** Brings a page (one-based) to the top of the view on screen. */
  goToPage: (page: number) => void;
  /** Organize pages: one change to the pages of the open document; `blobs` go with it to the core. `false` if it failed. */
  organizePages: (
    op: OrganizeOp,
    args: object,
    selectAfter: (pageCount: number) => number[],
    blobs?: ArrayBuffer[],
  ) => Promise<boolean>;
  /** Organize pages: the chosen pages as a new file, saved beside the open one. */
  extractPages: (pages: number[]) => Promise<void>;
  /**
   * Organize pages: every page of another PDF, inserted at `at` (0 is first),
   * as one change that can be undone. A protected file needs its password.
   */
  insertPagesFromFile: (file: { name: string; bytes: ArrayBuffer }, at: number, password?: string) => Promise<InsertOutcome>;
  /** Organize pages: the document as several files, `parts` of its pages each, saved as one zip; `false` if cancelled. */
  splitDocument: (parts: number[][], word: string) => Promise<boolean>;
  /** The open file as it stands now, with whatever either engine has changed. */
  currentFileBytes: () => Promise<ArrayBuffer | null>;
  /**
   * The same, for a tool that changes the file whole (Page marks): kept as an
   * update of the file's own bytes where it can be, so what the tool appends
   * comes after them and taking it off again gives them back.
   */
  fileBytesForChange: () => Promise<ArrayBuffer | null>;
  /** Areas marked for redaction in the EmbedPDF view and not yet applied: their text is still in the file. */
  pendingRedactions: number;
  /**
   * Search-and-redact: pending redaction marks in the EmbedPDF view, one per
   * match, over its glyph boxes; its Apply removes what is under them.
   * Returns how many were marked.
   */
  markForRedaction: (marks: readonly RedactionMark[]) => number;
  /**
   * The file as it stands — what either engine has changed, kept as an update
   * of the file's own bytes where it can be — with its own layer visibility,
   * not the one the view shows. What the document panes read and change.
   */
  readFile: () => Promise<ArrayBuffer | null>;
  /**
   * The open file, replaced by `bytes` in both views: a change made outside
   * them (Page marks, attachments, hidden information); it counts as an edit.
   * `textUnchanged` for a change that leaves every page's text as it was (an
   * attachment added or removed): Edit text's undo history stays.
   */
  replaceFile: (bytes: ArrayBuffer, options?: { textUnchanged?: boolean }) => Promise<void>;
  /** The layers the view shows by choice, by id; null while it shows the file's own visibility. */
  layersShown: readonly string[] | null;
  /** Shows exactly these layers, in a copy the view draws; the file is not changed. */
  showLayers: (visible: readonly string[]) => Promise<void>;
  /** Makes the layers shown now the file's own visibility, to be saved with it. */
  keepLayerVisibility: () => void;
  /** Back to the layer visibility the file has itself. */
  resetLayers: () => Promise<void>;
  /** Combine files: one new file of every page of `files`, in order, opened in place of the current one. */
  combineFiles: (files: readonly CombineInput[]) => Promise<void>;
  /** Compress: a smaller copy of the file as it stands now; the open one is not changed. */
  compressFile: (options: CompressChoice) => Promise<CompressResult>;
  /** Saves bytes as a new PDF beside the open one (the native panel on desktop). */
  saveCopy: (bytes: ArrayBuffer, name: string) => Promise<boolean>;
  /**
   * Scan & OCR: reads the scanned pages with Tesseract — cleaned up first, as
   * `options` say — and writes what it read into the file as an invisible
   * text layer, which then reopens in both views.
   */
  recognizeText: (
    languages: readonly OcrLanguage[],
    scope: OcrScope,
    onProgress: (progress: OcrProgress) => void,
    signal?: AbortSignal,
    options?: ReadOptions,
  ) => Promise<OcrOutcome>;
  /** Saves an HTML page — Compare's report — the same way; `false` if the panel was cancelled. */
  saveReport: (html: string, name: string) => Promise<boolean>;
  /**
   * A core operation on the file as it stands (`op` is static: the file goes
   * in, with the bundled Amiri after it when `font`), its answer opened in
   * place in both engines — Prepare form's fields and calculations. The file
   * goes in as an update of the bytes it was opened with, so what they held
   * stays as it was. Resolves to the operation's answer.
   */
  transformFile: <T>(op: string, args: object, options?: { font?: boolean }) => Promise<{ result: T; changed: boolean }>;
  clearRecent: () => void;
  /** Replaces a paragraph and records it on the undo stack. */
  commitParagraph: (entry: EditEntry) => Promise<void>;
  /** Draws a new line of text at a point on a page, in page points. */
  addText: (page: number, x: number, y: number, size: number, text: string) => Promise<void>;
  /**
   * Records a picture or link change on the undo stack: `before` is the
   * file as it was (`save()` just before the change), put back on Undo.
   */
  rememberFileChange: (page: number, before: Uint8Array) => void;
  /** Takes back the last edit: text, a picture or a link. */
  undoEdit: () => Promise<void>;
  /** Makes the edit that was undone again. */
  redoEdit: () => Promise<void>;
  /** `save()` plus a download of `<original-name>.pdf` — or, while a `SaveTarget` claims Save, to it. */
  saveDocument: () => Promise<void>;
  /** Save to this device (a download, or the native save panel), whatever claims Save. */
  saveToDevice: () => Promise<void>;
  /** The bytes Save writes: the file as it stands, kept as an update of its own bytes where it can be. */
  bytesForSave: () => Promise<Uint8Array<ArrayBuffer> | null>;
  /** Where Save writes while `target` claims it; `null` gives Save back to the device. */
  claimSave: (target: SaveTarget | null) => void;
}

const StateContext = createContext<AppState | null>(null);
const DispatchContext = createContext<Dispatch<AppAction> | null>(null);
const ServicesContext = createContext<AppServices | null>(null);

/** A file the desktop host read for us, in the shape the open path expects. */
function toFile(picked: PickedFile): File {
  return new File([picked.bytes], picked.name, { type: 'application/pdf' });
}

/** A dropped or picked file whose name or type says PDF; see `pdfFile.ts`. */
export const isPdfFile = namedLikePdf;

/** A file whose name says Create PDF can read it (Word, a picture…); its content decides later. */
function namedForCreate(file: File): boolean {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  return file.name.includes('.') && CREATE_EXTENSIONS.includes(extension);
}

function errorKeyFor(err: unknown): TKey {
  const code = (err as { code?: string } | null)?.code;
  return code === 'E_PASSWORD' ? 'error.password' : 'error.open';
}

const TOAST_MS = 3000;
/**
 * The largest file whose saves are kept as an update of it: the core holds
 * both copies at once to compare them (`file.rebase`), and past this a
 * browser tab runs short of memory.
 */
const REBASE_LIMIT = 150 * 1024 * 1024;

/** EmbedPDF's ink commitDelay (800 ms) plus a margin; see `bytesFromEmbed`. */
const INK_SETTLE_MS = 1000;

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, undefined, () =>
    createInitialState(readPreferences()),
  );
  const [document, setDocument] = useState<RemoteDocument | null>(null);
  const [documentBytes, setDocumentBytes] = useState<ArrayBuffer | null>(null);
  const [documentPassword, setDocumentPassword] = useState<string | undefined>(undefined);
  const passwordRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    passwordRef.current = documentPassword;
  }, [documentPassword]);
  // The protected file waiting for its password, and how it was being opened.
  const lockedFile = useRef<File | null>(null);
  const lockedOptions = useRef<OpenOptions | undefined>(undefined);
  const [openedFile, setOpenedFile] = useState<File | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  // Something was marked for redaction in the open file: the home screen keeps
  // no picture of its first page until it is opened again (home/recentPicture.ts).
  const pictureBlocked = useRef(false);
  const documentRef = useRef<RemoteDocument | null>(null);
  // The EmbedPDF view's registry (ADR-0007): the document as it holds it —
  // annotations, redactions, filled fields — is read back through its engine.
  const embedRef = useRef<PluginRegistry | null>(null);
  const [embed, setEmbed] = useState<PluginRegistry | null>(null);
  const [embedHistory, setEmbedHistory] = useState({ canUndo: false, canRedo: false });
  const [pendingRedactions, setPendingRedactions] = useState(0);
  // Layers shown by choice (the Layers pane): the view draws a copy whose
  // default configuration shows them, and the file keeps its own until the
  // person keeps these with it. `layerOwnRef` is the file with its own.
  const layerOwnRef = useRef<ArrayBuffer | null>(null);
  // The same, for what renders from it (`fileBytes`).
  const [layerOwn, setLayerOwn] = useState<ArrayBuffer | null>(null);
  // A redaction was marked since `layerOwnRef` was taken: its bytes still
  // hold what the redaction removes, so nothing may be kept as an update of
  // them. Unlike `redactedRef` below, which follows the bytes the view was
  // given, a switch of engines or a replaced view does not clear it: only
  // taking new own bytes does.
  const layerOwnRedactedRef = useRef(false);
  const keepLayerOwn = useCallback((bytes: ArrayBuffer | null) => {
    layerOwnRef.current = bytes;
    layerOwnRedactedRef.current = false;
    setLayerOwn(bytes);
  }, []);
  const layersShownRef = useRef<readonly string[] | null>(null);
  const [layersShown, setLayersShown] = useState<readonly string[] | null>(null);
  const forgetLayerView = useCallback(() => {
    keepLayerOwn(null);
    layersShownRef.current = null;
    setLayersShown(null);
  }, [keepLayerOwn]);
  // The page to come back to when the view reopens a copy of the same file.
  const returnToPage = useRef<number | null>(null);
  const syncedRevision = useRef(0);
  const wasWarraqs = useRef(false);
  /** A switch between the engines is being carried out (the effect below). */
  const switchInFlight = useRef(false);
  // Organize pages: the file as it was before each change, for undo and redo.
  const organizeHistory = useRef<{ undo: Uint8Array[]; redo: Uint8Array[] }>({ undo: [], redo: [] });
  /** The file on the other side of each picture or link change on the edit stack. */
  const fileSnapshots = useRef(new Map<number, Uint8Array>());
  const nextSnapshot = useRef(1);
  const [organizeSteps, setOrganizeSteps] = useState({ undo: 0, redo: 0 });
  // Async work reads the latest state through this ref, never a stale closure.
  const stateRef = useRef(state);
  const openSequence = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // What the hidden input was last opened for: Open (a PDF) or Create PDF (anything it reads).
  const inputPurpose = useRef<'open' | 'create'>('open');
  const pickFor = (purpose: 'open' | 'create') => {
    const input = fileInputRef.current;
    if (!input) return;
    inputPurpose.current = purpose;
    input.accept = purpose === 'create' ? CREATE_ACCEPT : 'application/pdf,.pdf';
    input.multiple = purpose === 'create';
    input.click();
  };

  const client = useMemo(() => getSharedCoreClient(), []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Desktop only: file inputs and download links through the native panels.
  useEffect(() => installDesktopFileBridge(), []);

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
    async (file: File, password?: string, options?: OpenOptions) => {
      // By content, not by name: see `pdfFile.ts`.
      if (!(await isPdf(file))) {
        dispatch({ type: 'DOCUMENT_FAILED', error: 'error.notPdf' });
        return;
      }
      openSequence.current += 1;
      const sequence = openSequence.current;
      dispatch({ type: 'DOCUMENT_LOADING', name: file.name });
      try {
        const bytes = await file.arrayBuffer();
        // Kept before the core takes `bytes` over (it is transferred to the worker).
        const kept = bytes.slice(0);
        const opened = await client.open(bytes, password);
        if (sequence !== openSequence.current) {
          void opened.free();
          return;
        }
        lockedFile.current = null;
        lockedOptions.current = undefined;
        void documentRef.current?.free();
        documentRef.current = opened;
        setDocument(opened);
        setDocumentPassword(password);
        setDocumentBytes(kept);
        setOpenedFile(file);
        forgetLayerView();
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
        pictureBlocked.current = false;
        // A file from a drive is listed with its drive, and pictured there
        // under the drive's own key (`cloud/`) — not among this device's.
        if (options?.recent !== false) {
          setRecent(addRecent(file.name));
          void keepFirstPage(file.name, opened, password, () => !pictureBlocked.current);
        }
      } catch (err) {
        if (sequence !== openSequence.current) return;
        if (errorKeyFor(err) === 'error.password') {
          // Not a failure: ask, and keep the file for the answer.
          lockedFile.current = file;
          lockedOptions.current = options;
          dispatch({ type: 'PASSWORD_NEEDED', name: file.name, wrong: password !== undefined });
          return;
        }
        dispatch({ type: 'DOCUMENT_FAILED', error: errorKeyFor(err) });
      }
    },
    [client, forgetLayerView],
  );

  const unlockFile = useCallback(
    (password: string) => {
      if (lockedFile.current) void openFile(lockedFile.current, password, lockedOptions.current);
    },
    [openFile],
  );

  const cancelUnlock = useCallback(() => {
    lockedFile.current = null;
    lockedOptions.current = undefined;
    dispatch({ type: 'PASSWORD_CANCELLED' });
  }, []);

  const openFiles = useCallback(
    async (files: ArrayLike<File>) => {
      const list = Array.from(files);
      const pdf = list.find(isPdfFile) ?? list[0];
      if (pdf) await openFile(pdf);
    },
    [openFile],
  );

  const dropTarget = useRef<DropTarget | null>(null);
  const [dropLabel, setDropLabel] = useState<TKey>('drop.overlay');
  const claimDrops = useCallback((target: DropTarget | null) => {
    dropTarget.current = target;
    setDropLabel(target?.label ?? 'drop.overlay');
  }, []);
  const combineDrop = useRef<File[]>([]);
  const takeCombineDrop = useCallback(() => combineDrop.current.splice(0), []);
  const createFiles = useRef<File[]>([]);
  const takeCreateFiles = useCallback(() => createFiles.current.splice(0), []);
  const startCreate = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    // An open Create panel has claimed the window's drops: the files join its list.
    if (dropTarget.current && stateRef.current.rightPane.activeTool === 'create') {
      dropTarget.current.take([...files]);
      return;
    }
    createFiles.current = [...files];
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'create' });
  }, []);
  const dropFiles = useCallback(
    (files: ArrayLike<File>, intent?: DropIntent) => {
      const list = Array.from(files);
      if (dropTarget.current) {
        dropTarget.current.take(list);
        return;
      }
      // No PDF among them, but files Create can make one of: that is what the drop is for.
      if (!list.some(isPdfFile) && list.some(namedForCreate)) {
        startCreate(list);
        return;
      }
      // Combine reads each file's first bytes, so a PDF without `.pdf` in its
      // name joins too, and anything else is refused there, by name — rather
      // than replacing the open document.
      const open = stateRef.current.document !== null;
      if (list.length > 0 && ((open && intent !== 'open') || (!open && list.length > 1))) {
        combineDrop.current = list;
        dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'combine' });
        return;
      }
      void openFiles(list);
    },
    [openFiles, startCreate],
  );

  const requestCreateFiles = useCallback(() => {
    if (!isTauriHost()) {
      pickFor('create');
      return;
    }
    void pickFiles([{ name: 'PDF', extensions: CREATE_EXTENSIONS }], true)
      .then((picked) => startCreate(picked.map((file) => new File([file.bytes], file.name))))
      .catch(() => dispatch({ type: 'DOCUMENT_FAILED', error: 'create.failed' }));
  }, [startCreate]);

  const closeDocument = useCallback(() => {
    openSequence.current += 1;
    void documentRef.current?.free();
    documentRef.current = null;
    setDocument(null);
    setDocumentBytes(null);
    setDocumentPassword(undefined);
    setOpenedFile(null);
    forgetLayerView();
    dispatch({ type: 'DOCUMENT_CLOSED' });
  }, [forgetLayerView]);

  /**
   * A browser opens the hidden `<input type="file">`; the desktop webview
   * ignores that element entirely, so it goes through the native open panel.
   * A failure here used to be invisible — the click simply did nothing — so
   * it now reports itself like any other failed open.
   */
  const requestOpenFile = useCallback(() => {
    if (!isTauriHost()) {
      pickFor('open');
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

  const attachEmbed = useCallback((registry: PluginRegistry) => {
    embedRef.current = registry;
    setEmbed(registry);
  }, []);

  /** EmbedPDF opened a file: a switch back to it is complete. */
  // The bytes EmbedPDF last opened, and who waits for it to catch up with
  // new ones: until it has, what it would hand over is the file before.
  const embedHolds = useRef<ArrayBuffer | null>(null);
  const embedWaiters = useRef<(() => void)[]>([]);

  const embedOpened = useCallback((bytes?: ArrayBuffer) => {
    if (bytes) {
      embedHolds.current = bytes;
      embedWaiters.current.splice(0).forEach((wake) => wake());
    }
    const page = returnToPage.current;
    returnToPage.current = null;
    // A copy of the same file, reopened: back to where the person was.
    if (page !== null && page > 1 && embedRef.current) {
      const registry = embedRef.current;
      setTimeout(() => scrollToPage(registry, page), 0);
    }
    if (stateRef.current.switching !== 'out') return;
    switchInFlight.current = false;
    dispatch({ type: 'SWITCH_DONE' });
  }, []);

  const runEmbedCommand = useCallback((command: string) => {
    if (embedRef.current) runCommand(embedRef.current, command);
  }, []);

  const warraqOwns = warraqOwnsDocument(state);
  const embedShowing = state.view === 'viewer' && documentBytes !== null && !warraqOwns;
  const embedShowingRef = useRef(embedShowing);
  useEffect(() => {
    embedShowingRef.current = embedShowing;
  }, [embedShowing]);

  // The toolbar's page and Go to page follow the page EmbedPDF shows, and the
  // Edit menu what its history can undo.
  useEffect(() => {
    if (!embed) return;
    return watch(embed, {
      onPage: (page) => {
        if (!warraqOwnsDocument(stateRef.current)) dispatch({ type: 'SET_CURRENT_PAGE', page });
      },
      onHistory: setEmbedHistory,
    });
  }, [embed]);

  useEffect(() => {
    if (embed) setKeyboard(embed, !warraqOwns, disabledCategories(isTauriHost()));
  }, [embed, warraqOwns]);

  // Marks not yet applied, for Export to warn about while they are there.
  useEffect(() => (embed ? watchPendingRedactions(embed, setPendingRedactions) : undefined), [embed]);

  // Which of EmbedPDF's toggles are on — fit width, fit page, its sidebar and
  // search — for the toolbar's pressed buttons and the menus' checks.
  const [embedToggles, setEmbedToggles] = useState<ViewToggles>(NO_TOGGLES);
  useEffect(() => {
    if (!embed) return;
    return watchToggles(embed, (next) =>
      setEmbedToggles((current) => (Object.entries(next).every(([key, on]) => current[key as keyof ViewToggles] === on) ? current : next)),
    );
  }, [embed]);

  // Choosing a tool puts the view in that tool's mode — Annotate, Form, Redact —
  // so the toolbar matches the panel the person just opened.
  const activeTool = state.rightPane.activeTool;
  useEffect(() => {
    const mode = activeTool ? findTool(activeTool)?.mode : undefined;
    if (mode && !warraqOwnsDocument(stateRef.current)) runEmbedCommand(mode);
  }, [activeTool, runEmbedCommand]);

  /**
   * The document exactly as EmbedPDF holds it, or null without a view.
   *
   * EmbedPDF keeps new annotations as pending ("commitState: new") until they
   * are committed to the engine. Reading the engine directly — the first
   * version of this did — saved the file without them: a drawing on screen,
   * nothing in the file. Found by the end-to-end suite. So pending work is
   * committed first and the bytes come from EmbedPDF's own export plugin.
   */
  /**
   * The file with Arabic drawn where PDFium drew nothing (ADR-0007): PDFium
   * stores Arabic typed into a form field or a text box but writes its
   * appearance with a font that has no Arabic, so the saved file shows the
   * field empty. Warraq's core redraws those appearances, as an incremental
   * update sealed with the file's own key. A file with nothing to redraw comes
   * back as it was, and a failure never costs the save.
   */
  // The bytes EmbedPDF was given, and whether redaction marks were made on
  // them since: saves are kept as an update of those bytes, but not after a
  // redaction, whose point is that nothing under it survives anywhere.
  const embedBytesRef = useRef<ArrayBuffer | null>(null);
  const redactedRef = useRef(false);
  useEffect(() => {
    embedBytesRef.current = documentBytes;
    redactedRef.current = false;
  }, [documentBytes]);
  useEffect(() => {
    if (pendingRedactions === 0) return;
    redactedRef.current = true;
    // A redaction also stops the layer view's own bytes being rebased on.
    layerOwnRedactedRef.current = true;
    // Nor a picture of what is under the marks on the home screen.
    pictureBlocked.current = true;
    const name = stateRef.current.document?.name;
    if (name) forgetRecentThumbnail(name);
  }, [pendingRedactions]);

  const withArabicAppearances = useCallback(
    async (bytes: ArrayBuffer): Promise<ArrayBuffer> => {
      try {
        const font = await loadEditFont('amiri');
        // The file as the view opened it: when it is signed, only what
        // changed since is redrawn — a third party's appearances redrawn
        // after the signature would show it changed on every save.
        const opened = embedBytesRef.current;
        const { blobs } = await client.callStatic<{ fields: number; comments: number }>(
          'forms.fix_appearances',
          { password: passwordRef.current ?? null },
          [bytes.slice(0), font.slice().buffer, ...(opened && opened.byteLength <= REBASE_LIMIT ? [opened.slice(0)] : [])],
        );
        return blobs[0] ?? bytes;
      } catch {
        return bytes;
      }
    },
    [client],
  );

  /**
   * EmbedPDF's save — PDFium writes a file whole — kept as an update of the
   * bytes it opened (`file.rebase`): what was signed stays signed, and a file
   * nothing was done to comes back as it was. Not after a redaction, nor for
   * a very large unsigned file, nor when the protection changed (the core
   * says so); then the rewrite is the file, as before. A large signed file is
   * kept as an update all the same, and if even that cannot be done the save
   * is refused (`E_SIGNED_TOO_LARGE`) rather than written over its signatures.
   */
  const keepOwnBytes = useCallback(
    async (rewritten: ArrayBuffer): Promise<ArrayBuffer> => {
      const own = embedBytesRef.current;
      if (!own) return rewritten;
      const policy = keepPolicy(own.byteLength, REBASE_LIMIT, redactedRef.current, () => mentionsSignature(own));
      if (policy === 'rewrite') return rewritten;
      try {
        const { result, blobs } = await client.callStatic<{ rebased: boolean }>(
          'file.rebase',
          { password: passwordRef.current ?? null },
          [own.slice(0), rewritten.slice(0)],
        );
        return result.rebased && blobs[0] ? blobs[0] : rewritten;
      } catch {
        if (policy === 'rebaseOrRefuse') throw new Error('E_SIGNED_TOO_LARGE: the signed file could not be kept as an update');
        return rewritten;
      }
    },
    [client],
  );

  const bytesFromEmbed = useCallback(async (): Promise<ArrayBuffer | null> => {
    // New bytes were just handed to the view (a change made outside it, a
    // copy with other layers shown): wait until it has them open, or it
    // would hand back the file as it was before. Bounded: a view that
    // cannot open them says so itself.
    const deadline = Date.now() + 20_000;
    while (embedBytesRef.current && embedHolds.current !== embedBytesRef.current && Date.now() < deadline) {
      await new Promise<void>((wake) => {
        embedWaiters.current.push(wake);
        setTimeout(wake, 250);
      });
    }
    const registry = embedRef.current;
    if (!registry) return null;
    type Task<T> = { toPromise(): Promise<T> };
    const provides = <T,>(id: string): T | undefined => capability<T>(registry, id);
    // EmbedPDF's ink tool gathers strokes and writes them 800 ms after the last
    // one (its commitDelay), so several strokes become one drawing. Putting the
    // tool down before then discards them — a first attempt at this did exactly
    // that — so while a drawing tool is active, Save waits the strokes out.
    const id = provides<{ getActiveDocumentId(): string | null }>('document-manager')?.getActiveDocumentId();
    if (id) {
      const scope = provides<{
        forDocument(documentId: string): { getActiveTool(): unknown; commit(): Task<boolean> };
      }>('annotation')?.forDocument(id);
      const tool = scope?.getActiveTool();
      const toolId = typeof tool === 'string' ? tool : (tool as { id?: string } | null)?.id;
      if (toolId && /ink/i.test(toolId)) await new Promise((resolve) => setTimeout(resolve, INK_SETTLE_MS));
      await scope?.commit().toPromise().catch(() => undefined);
    }
    const exporter = provides<{ saveAsCopy: () => Task<ArrayBuffer> }>('export');
    if (exporter) return withArabicAppearances(await exporter.saveAsCopy().toPromise());
    const active = provides<{ getActiveDocument(): unknown }>('document-manager')?.getActiveDocument();
    if (!active) return null;
    const engine = registry.getEngine() as unknown as { saveAsCopy(document: unknown): Task<ArrayBuffer> };
    return withArabicAppearances(await engine.saveAsCopy(active).toPromise());
  }, [withArabicAppearances]);

  // EmbedPDF's search and copy read the file through Warraq's engine, which
  // reads Arabic in logical order where PDFium does not (embed/embedText.ts).
  useEffect(() => {
    if (!embed) return;
    return installViewText(embed, {
      own: () => (warraqOwnsDocument(stateRef.current) || stateRef.current.switching ? null : documentRef.current),
      fromView: bytesFromEmbed,
      open: (bytes) => client.open(bytes, passwordRef.current),
    });
  }, [embed, bytesFromEmbed, client]);

  /**
   * The handover between the two engines. Opening Edit text or Organize pages,
   * Warraq's engine takes the file exactly as EmbedPDF holds it, so nothing
   * done there is lost; closing them, EmbedPDF reopens Warraq's changes. Bytes
   * are the only contract between them, which is what keeps two engines honest
   * about one document.
   */
  useEffect(() => {
    if (wasWarraqs.current === warraqOwns) {
      // The reducer marks a switch the moment ownership changes; one that
      // changed back before this ran has nothing to carry out.
      if (!switchInFlight.current && stateRef.current.switching !== null) dispatch({ type: 'SWITCH_DONE' });
      return;
    }
    wasWarraqs.current = warraqOwns;
    switchInFlight.current = true;
    const done = () => {
      switchInFlight.current = false;
      dispatch({ type: 'SWITCH_DONE' });
    };
    organizeHistory.current = { undo: [], redo: [] };
    setOrganizeSteps({ undo: 0, redo: 0 });
    // The switch takes a moment — EmbedPDF finishes a stroke and writes the
    // file, Warraq parses it — and until it is done neither engine's old copy
    // may pass for the current one: an edit made there was silently lost.
    dispatch({ type: 'SWITCH_ENGINE', direction: warraqOwns ? 'in' : 'out' });
    void (async () => {
      if (warraqOwns) {
        // Kept as an update of the file's own bytes, so Warraq's edits are
        // appended after them too.
        const rewritten = await bytesFromEmbed();
        const bytes = rewritten && (await keepOwnBytes(rewritten));
        const name = stateRef.current.document?.name;
        if (!bytes || !name) {
          done();
          return;
        }
        // EmbedPDF's copy keeps the file's protection, so it needs the password
        // too; without it this open failed and the editor showed a stale copy.
        const opened = await client.open(bytes, passwordRef.current);
        void documentRef.current?.free();
        documentRef.current = opened;
        setDocument(opened);
        dispatch({
          type: 'DOCUMENT_OPENED',
          document: {
            id: opened.id,
            name,
            pageCount: opened.pageCount,
            pageSizes: opened.pageSizes,
            metadata: opened.info,
          },
        });
        // DOCUMENT_OPENED starts the edit history again.
        syncedRevision.current = 0;
        done();
        return;
      }
      const doc = documentRef.current;
      if (!doc || stateRef.current.edit.revision === syncedRevision.current) {
        done();
        return;
      }
      const saved = await doc.save();
      syncedRevision.current = stateRef.current.edit.revision;
      // Done when EmbedPDF has opened these bytes: `embedOpened`.
      setDocumentBytes(saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength));
    })().catch(() => {
      switchInFlight.current = false;
      dispatch({ type: 'DOCUMENT_FAILED', error: 'error.open' });
    });
  }, [warraqOwns, bytesFromEmbed, keepOwnBytes, client]);

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

  // Edit PDF's own state (pictures or links, what is picked) belongs to Edit
  // mode: closed — by the toolbar's Edit text, the menu, another tool — it
  // goes back to text with nothing picked, so no picture control is left
  // acting on a document the view no longer shows, and Edit text opens text.
  useEffect(() => {
    if (!state.edit.active) resetEditPdf();
  }, [state.edit.active]);

  const rememberFileChange = useCallback((page: number, before: Uint8Array) => {
    const snapshot = nextSnapshot.current;
    nextSnapshot.current += 1;
    fileSnapshots.current.set(snapshot, before);
    dispatch({ type: 'EDIT_FILE_CHANGED', page, snapshot });
  }, []);

  // A snapshot the stack no longer names — undone and branched away from,
  // past the bound, or of another document — is let go.
  useEffect(() => {
    const kept = snapshotsIn(state.edit.stack);
    for (const id of [...fileSnapshots.current.keys()]) if (!kept.has(id)) fileSnapshots.current.delete(id);
  }, [state.edit.stack]);

  /**
   * A new line of text where the user pointed. There is no paragraph to
   * replay for it, so it goes on the undo stack as a picture or link change
   * does: the file as it was is kept, and Undo puts it back.
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
        const before = await doc.save();
        await doc.add_text(page, x, y, size, text, font);
        rememberFileChange(page, before);
      } catch {
        dispatch({ type: 'EDIT_BUSY', busy: false });
        dispatch({ type: 'DOCUMENT_FAILED', error: 'edit.failed' });
      }
    },
    [rememberFileChange],
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

  /**
   * Undo or redo of a picture or link change: the file goes back to the
   * snapshot's bytes, and the file as it is takes the snapshot's place, for
   * the step back. As Organize's undo does, byte for byte.
   */
  const restoreSnapshot = useCallback(
    async (snapshot: number): Promise<boolean> => {
      const doc = documentRef.current;
      const target = fileSnapshots.current.get(snapshot);
      if (!doc || !target || stateRef.current.edit.busy) return false;
      dispatch({ type: 'EDIT_BUSY', busy: true });
      try {
        const current = await doc.save();
        const opened = await client.open(target.slice(), passwordRef.current);
        fileSnapshots.current.set(snapshot, current);
        void doc.free();
        documentRef.current = opened;
        setDocument(opened);
        return true;
      } catch {
        dispatch({ type: 'EDIT_BUSY', busy: false });
        dispatch({ type: 'DOCUMENT_FAILED', error: 'edit.failed' });
        return false;
      }
    },
    [client],
  );

  const step = useCallback(
    async (next: (stack: AppState['edit']['stack']) => StackStep | null) => {
      const taken = next(stateRef.current.edit.stack);
      if (!taken) return;
      const { change, stack } = taken;
      if (isFileEntry(change)) {
        if (await restoreSnapshot(change.snapshot)) {
          dispatch({ type: 'EDIT_STEPPED', stack, page: change.page, fontSubstituted: false });
        }
        return;
      }
      const fontSubstituted = await replaceParagraph(
        change.page,
        change.paragraphIndex,
        change.text,
      );
      if (fontSubstituted === null) return;
      dispatch({ type: 'EDIT_STEPPED', stack, page: change.page, fontSubstituted });
    },
    [replaceParagraph, restoreSnapshot],
  );

  const undoEdit = useCallback(() => step(undoStack), [step]);
  const redoEdit = useCallback(() => step(redoStack), [step]);

  /** The last ten states of the file before a page change, and the undone ones. */
  const ORGANIZE_HISTORY = 10;
  const rememberSteps = () =>
    setOrganizeSteps({ undo: organizeHistory.current.undo.length, redo: organizeHistory.current.redo.length });

  /**
   * One page change (`pages.rotate`, `reorder`, `delete`, `insert_blank`) on
   * the document Warraq's engine holds, then its new shape. The file as it was
   * is kept first, so the change can be undone byte for byte.
   */
  const organizePages = useCallback(
    async (op: OrganizeOp, args: object, selectAfter: (pageCount: number) => number[], blobs: ArrayBuffer[] = []) => {
      const doc = documentRef.current;
      if (!doc || stateRef.current.organize.busy) return false;
      dispatch({ type: 'ORGANIZE_BUSY', busy: true });
      try {
        const before = await doc.save();
        const { result } = await doc.call<PageShape>(`pages.${op}`, args, blobs);
        const history = organizeHistory.current;
        history.undo = [...history.undo, before].slice(-ORGANIZE_HISTORY);
        history.redo = [];
        rememberSteps();
        dispatch({ type: 'DOCUMENT_RESHAPED', pageCount: result.pageCount, pageSizes: result.pageSizes, selection: selectAfter(result.pageCount) });
        return true;
      } catch {
        dispatch({ type: 'ORGANIZE_BUSY', busy: false });
        dispatch({ type: 'DOCUMENT_FAILED', error: 'organize.failed' });
        return false;
      }
    },
    [],
  );

  /** Undo or redo a page change: the file goes back to the bytes it had. */
  const organizeStep = useCallback(
    async (direction: 'undo' | 'redo') => {
      const doc = documentRef.current;
      const history = organizeHistory.current;
      const target = history[direction].at(-1);
      if (!doc || !target || stateRef.current.organize.busy) return;
      dispatch({ type: 'ORGANIZE_BUSY', busy: true });
      try {
        const current = await doc.save();
        const opened = await client.open(target.slice(), passwordRef.current);
        history[direction] = history[direction].slice(0, -1);
        const other = direction === 'undo' ? 'redo' : 'undo';
        history[other] = [...history[other], current].slice(-ORGANIZE_HISTORY);
        rememberSteps();
        void doc.free();
        documentRef.current = opened;
        setDocument(opened);
        dispatch({ type: 'DOCUMENT_RESHAPED', pageCount: opened.pageCount, pageSizes: opened.pageSizes, selection: [] });
      } catch {
        dispatch({ type: 'ORGANIZE_BUSY', busy: false });
        dispatch({ type: 'DOCUMENT_FAILED', error: 'organize.failed' });
      }
    },
    [client],
  );

  /** A new file of the chosen pages, saved beside the open one; the open file is untouched. */
  const extractPages = useCallback(async (pages: number[]) => {
    const doc = documentRef.current;
    const name = stateRef.current.document?.name;
    if (!doc || !name || pages.length === 0) return;
    try {
      const { blobs } = await doc.call<{ pageCount: number }>('pages.extract', { pages });
      const bytes = new Uint8Array(blobs[0] ?? new ArrayBuffer(0));
      const fileName = extractedFileName(name, pages);
      if (isTauriHost()) {
        if (!(await savePdfFile(bytes, fileName))) return;
      } else {
        downloadPdf(bytes, fileName);
      }
      dispatch({ type: 'TOAST', key: 'organize.extracted' });
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'organize.failed' });
    }
  }, []);

  const insertPagesFromFile = useCallback(
    async (file: { name: string; bytes: ArrayBuffer }, at: number, password?: string): Promise<InsertOutcome> => {
      // Opened once first: how many pages come in, and whether it is locked.
      let pages: number;
      try {
        const probe = await client.open(file.bytes.slice(0), password);
        pages = probe.pageCount;
        void probe.free();
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== 'E_PASSWORD') return 'failed';
        return password ? 'wrongPassword' : 'locked';
      }
      const done = await organizePages(
        'insert_file',
        { at, password: password ?? null },
        () => Array.from({ length: pages }, (_, k) => at + k),
        [file.bytes.slice(0)],
      );
      return done ? 'inserted' : 'failed';
    },
    [client, organizePages],
  );

  /** Every part through `pages.extract`, then one zip: one save, whatever the host. */
  const splitDocument = useCallback(async (parts: number[][], word: string): Promise<boolean> => {
    const doc = documentRef.current;
    const name = stateRef.current.document?.name;
    if (!doc || !name || parts.length === 0) return false;
    try {
      const files: Record<string, Uint8Array> = {};
      for (const part of parts) {
        const { blobs } = await doc.call<{ pageCount: number }>('pages.extract', { pages: part });
        files[extractedFileName(name, part)] = new Uint8Array(blobs[0] ?? new ArrayBuffer(0));
      }
      // Stored, not deflated: the parts are PDFs, already compressed inside.
      const zip = zipSync(files, { level: 0 });
      const saved = await saveBytes(zip, splitArchiveName(name, word), {
        mime: 'application/zip',
        filter: { name: 'ZIP', extensions: ['zip'] },
      });
      if (saved) dispatch({ type: 'TOAST', key: 'organize.splitDone' });
      return saved;
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'organize.failed' });
      return false;
    }
  }, []);

  /**
   * `bytes` with the layer visibility the file has itself, while the view
   * shows other layers by choice (`showLayers`): the view's choice is not
   * written into the file until the person keeps it. As an update of the
   * file's own bytes, unless a redaction since they were taken means it must
   * be written whole — an update would keep the redacted text in them, even
   * after Edit text or Organize pages has handed the file round again.
   */
  const withOwnLayers = useCallback(
    async (bytes: ArrayBuffer): Promise<ArrayBuffer> => {
      const own = layerOwnRef.current;
      if (!own) return bytes;
      const rebase = !redactedRef.current && !layerOwnRedactedRef.current && own.byteLength <= REBASE_LIMIT;
      const { blobs } = await client.callStatic<{ rebased: boolean }>(
        'layers.restore',
        { password: passwordRef.current ?? null, rebase },
        [own.slice(0), bytes.slice(0)],
      );
      return blobs[0] ?? bytes;
    },
    [client],
  );

  const currentFileBytes = useCallback(async (): Promise<ArrayBuffer | null> => {
    let bytes: ArrayBuffer | null;
    if (!warraqOwnsDocument(stateRef.current)) bytes = await bytesFromEmbed();
    else {
      const saved = await documentRef.current?.save();
      bytes = saved ? saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) : null;
    }
    return bytes && withOwnLayers(bytes);
  }, [bytesFromEmbed, withOwnLayers]);

  const readFile = useCallback(async (): Promise<ArrayBuffer | null> => {
    let bytes: ArrayBuffer | null;
    if (warraqOwnsDocument(stateRef.current)) {
      const saved = await documentRef.current?.save();
      bytes = saved ? saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) : null;
    } else {
      const rewritten = await bytesFromEmbed();
      bytes = rewritten && (await keepOwnBytes(rewritten));
    }
    return bytes && withOwnLayers(bytes);
  }, [bytesFromEmbed, keepOwnBytes, withOwnLayers]);

  const markForRedaction = useCallback((marks: readonly RedactionMark[]): number => {
    const registry = embedRef.current;
    if (!registry || !embedShowingRef.current) return 0;
    const added = addRedactionMarks(registry, marks, uuidV4);
    const first = marks.find((mark) => mark.rects.length > 0);
    if (added > 0 && first) scrollToPage(registry, first.page + 1);
    return added;
  }, []);

  const fileBytesForChange = useCallback(async (): Promise<ArrayBuffer | null> => {
    if (warraqOwnsDocument(stateRef.current)) return currentFileBytes();
    const rewritten = await bytesFromEmbed();
    // With the file's own layer visibility: a signature (or a mark) made now
    // must not take in the layers the view shows by choice.
    return rewritten ? withOwnLayers(await keepOwnBytes(rewritten)) : null;
  }, [currentFileBytes, bytesFromEmbed, keepOwnBytes, withOwnLayers]);

  const combineFiles = useCallback(
    async (files: readonly CombineInput[]) => {
      if (files.length < 2) return;
      try {
        // Copies: the core takes the buffers over, and the list keeps its own.
        const { result, blobs } = await client.callStatic<{ pageCount: number }>(
          'pages.combine',
          { passwords: files.map((file) => file.password ?? null) },
          files.map((file) => file.bytes.slice(0)),
        );
        const bytes = blobs[0];
        if (!bytes || result.pageCount < 1) throw new Error('E_EDIT: nothing combined');
        dispatch({ type: 'SET_ACTIVE_TOOL', tool: null });
        await openFile(new File([bytes], combinedFileName(files.map((file) => file.name)), { type: 'application/pdf' }));
      } catch {
        dispatch({ type: 'DOCUMENT_FAILED', error: 'combine.failed' });
      }
    },
    [client, openFile],
  );

  const compressFile = useCallback(
    async (options: CompressChoice): Promise<CompressResult> => {
      const bytes = await currentFileBytes();
      if (!bytes) throw new Error('E_NOT_FOUND: no open file');
      type Answer = Omit<Extract<CompressResult, { bytes: ArrayBuffer }>, 'bytes'> | { refused: 'protected' | 'signed' };
      const { result, blobs } = await client.callStatic<Answer>(
        'compress.file',
        { password: passwordRef.current ?? null, ...options },
        [bytes],
      );
      if ('refused' in result) return result;
      return { ...result, bytes: blobs[0] ?? new ArrayBuffer(0) };
    },
    [client, currentFileBytes],
  );

  const saveCopy = useCallback(async (bytes: ArrayBuffer, name: string): Promise<boolean> => {
    const data = new Uint8Array(bytes);
    if (isTauriHost()) return savePdfFile(data, name);
    downloadPdf(data, name);
    return true;
  }, []);

  /**
   * The open file, replaced by `bytes` in both engines — for a change made to
   * the whole file outside either view, such as a text layer. It counts as an
   * edit, so the file is marked changed until it is saved.
   */
  const replaceCurrentFile = useCallback(
    async (bytes: ArrayBuffer, options: { textUnchanged?: boolean } = {}) => {
      // With layers shown by choice, the new file is shown the same way.
      let shown = bytes;
      const visible = layersShownRef.current;
      if (layerOwnRef.current && visible) {
        const { blobs } = await client
          .callStatic('layers.show', { password: passwordRef.current ?? null, visible }, [bytes.slice(0)])
          .catch(() => ({ blobs: [] as ArrayBuffer[] }));
        if (blobs[0]) {
          keepLayerOwn(bytes);
          shown = blobs[0];
        } else forgetLayerView();
      }
      const opened = await client.open(shown.slice(0), passwordRef.current);
      void documentRef.current?.free();
      documentRef.current = opened;
      setDocument(opened);
      returnToPage.current = stateRef.current.currentPage;
      // At once, not when the effect runs: a read straight after this must
      // wait for the view to open these (`bytesFromEmbed`).
      embedBytesRef.current = shown;
      setDocumentBytes(shown);
      dispatch({
        type: 'DOCUMENT_RESHAPED',
        pageCount: opened.pageCount,
        pageSizes: opened.pageSizes,
        selection: [],
        keepEditHistory: options.textUnchanged === true,
      });
    },
    [client, forgetLayerView, keepLayerOwn],
  );

  /**
   * Layers are view state (the Layers pane): the view is given a copy whose
   * default configuration shows exactly `visible`, made by the core from the
   * file as it stands, and the file keeps its own visibility — it is put
   * back on everything that leaves the app — until the person keeps these.
   */
  const showLayers = useCallback(
    async (visible: readonly string[]) => {
      if (warraqOwnsDocument(stateRef.current) || stateRef.current.switching) return;
      const own = await readFile();
      if (!own) return;
      const { blobs } = await client.callStatic('layers.show', { password: passwordRef.current ?? null, visible }, [own.slice(0)]);
      if (!blobs[0]) return;
      keepLayerOwn(own);
      layersShownRef.current = [...visible];
      setLayersShown([...visible]);
      returnToPage.current = stateRef.current.currentPage;
      embedBytesRef.current = blobs[0];
      setDocumentBytes(blobs[0]);
    },
    [client, readFile, keepLayerOwn],
  );

  /** The layers shown now become the file's own: it is changed, to be saved. */
  const keepLayerVisibility = useCallback(() => {
    if (!layerOwnRef.current) return;
    forgetLayerView();
    const open = stateRef.current.document;
    if (open) dispatch({ type: 'DOCUMENT_RESHAPED', pageCount: open.pageCount, pageSizes: open.pageSizes, selection: [] });
  }, [forgetLayerView]);

  const resetLayers = useCallback(async () => {
    if (!layerOwnRef.current) return;
    const own = await readFile();
    forgetLayerView();
    if (!own) return;
    returnToPage.current = stateRef.current.currentPage;
    embedBytesRef.current = own;
    setDocumentBytes(own);
  }, [readFile, forgetLayerView]);

  const recognizeText = useCallback(
    async (
      languages: readonly OcrLanguage[],
      scope: OcrScope,
      onProgress: (progress: OcrProgress) => void,
      signal?: AbortSignal,
      options?: ReadOptions,
    ): Promise<OcrOutcome> => {
      // The layer is an update of the file's own bytes, not of PDFium's
      // rewrite of them: a signature over them stays whole.
      const bytes = await fileBytesForChange();
      if (!bytes) throw new Error('E_NOT_FOUND: no open file');
      const { bytes: read, ...outcome } = await recognizeFile(client, bytes, passwordRef.current, languages, scope, onProgress, signal, options);
      if (outcome.pages > 0) await replaceCurrentFile(read);
      return outcome;
    },
    [client, fileBytesForChange, replaceCurrentFile],
  );

  // Desktop diagnostics only (`ocr/selfCheck.ts`): once the first document
  // is open in the view, the host may ask for Scan & OCR to be run on it.
  const selfChecked = useRef(false);
  useEffect(() => {
    if (selfChecked.current || !state.document || state.switching || !embed) return;
    selfChecked.current = true;
    void runSelfCheck({ recognizeText, client, currentFileBytes, documentPassword: passwordRef.current });
  }, [state.document, state.switching, embed, recognizeText, client, currentFileBytes]);

  const transformFile = useCallback(
    async <T,>(op: string, args: object, options: { font?: boolean } = {}): Promise<{ result: T; changed: boolean }> => {
      const fromEmbed = warraqOwnsDocument(stateRef.current) ? null : await bytesFromEmbed();
      const bytes = fromEmbed ? await keepOwnBytes(fromEmbed) : await currentFileBytes();
      if (!bytes) throw new Error('E_NOT_FOUND: no open file');
      const blobs = [bytes];
      if (options.font) blobs.push((await loadEditFont('amiri')).slice().buffer);
      const { result, blobs: out } = await client.callStatic<T>(op, { password: passwordRef.current ?? null, ...args }, blobs);
      const next = out[0];
      if (next) await replaceCurrentFile(next);
      return { result, changed: next !== undefined };
    },
    [client, bytesFromEmbed, keepOwnBytes, currentFileBytes, replaceCurrentFile],
  );

  const saveReport = useCallback(
    (html: string, name: string): Promise<boolean> =>
      saveBytes(new TextEncoder().encode(html), name, {
        mime: 'text/html;charset=utf-8',
        filter: { name: 'HTML', extensions: ['html'] },
      }),
    [],
  );

  const organizing = state.rightPane.activeTool === 'organize' && state.document !== null;

  // Desktop print: the host says whether it can, and how — PDFKit prints the
  // file itself on macOS; elsewhere the pages are laid out here for the
  // webview to print (print/printPages.ts). A browser prints through
  // EmbedPDF, or by pages when `warraq.print` is "pages" (how that path is
  // tested in a browser).
  const [nativePrint, setNativePrint] = useState(false);
  const [printWay, setPrintWay] = useState<PrintWay>(() =>
    !isTauriHost() && readJson<string>('warraq.print', '') === 'pages' ? 'pages' : 'embed',
  );
  useEffect(() => {
    if (!isTauriHost()) return;
    void printAvailable().then(setNativePrint, () => setNativePrint(false));
    void printMode().then(setPrintWay, () => setPrintWay('pdfkit'));
  }, []);

  const [printing, setPrinting] = useState<PrintProgress | null>(null);
  const printAbort = useRef<AbortController | null>(null);
  const printUndo = useRef<(() => void) | null>(null);

  const cancelPrint = useCallback(() => printAbort.current?.abort(), []);
  // Another file, or none: what was being drawn for print is not it any more.
  useEffect(() => () => printAbort.current?.abort(), [document]);

  const printByPages = useCallback(async () => {
    if (printAbort.current) return;
    const registry = embedRef.current;
    if (registry && !printAllowed(registry)) {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'print.forbidden' });
      return;
    }
    const abort = new AbortController();
    printAbort.current = abort;
    printUndo.current?.();
    printUndo.current = null;
    let reading: RemoteDocument | null = null;
    try {
      const bytes = await currentFileBytes();
      if (!bytes) return;
      reading = await client.open(bytes, passwordRef.current);
      setPrinting({ done: 0, total: reading.pageCount });
      const pages = await drawPages(reading, (done, total) => setPrinting({ done, total }), abort.signal);
      const undo = await mountSheet(pages);
      printUndo.current = undo;
      // The sheet goes when printing is over: the dialog closed, printed or not.
      window.addEventListener(
        'afterprint',
        () => {
          if (printUndo.current !== undo) return;
          undo();
          printUndo.current = null;
        },
        { once: true },
      );
      setPrinting(null);
      if (isTauriHost()) await printWebview();
      else window.print();
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') dispatch({ type: 'DOCUMENT_FAILED', error: 'print.failed' });
    } finally {
      void reading?.free();
      printAbort.current = null;
      setPrinting(null);
    }
  }, [client, currentFileBytes]);

  const printFile = useCallback(async () => {
    if (printWay === 'pages') return printByPages();
    const bytes = await currentFileBytes();
    if (!bytes) return;
    try {
      await printPdf(bytes, passwordRef.current);
    } catch (error) {
      const forbidden = String(error).includes('E_PRINT_FORBIDDEN');
      dispatch({ type: 'DOCUMENT_FAILED', error: forbidden ? 'print.forbidden' : 'print.failed' });
    }
  }, [currentFileBytes, printWay, printByPages]);

  const viewCommand = useCallback(
    (command: ViewCommand) => {
      // Mid-switch neither engine holds the current file.
      if (stateRef.current.switching) return;
      // The desktop prints the file itself, or its pages laid out for print,
      // in the system's print dialog — from either view.
      if (command === 'print' && (isTauriHost() || printWay === 'pages')) {
        void printFile();
        return;
      }
      if (stateRef.current.rightPane.activeTool === 'organize') {
        // The page grid has no zoom or find; undo and redo are its own.
        if (command === 'undo' || command === 'redo') void organizeStep(command);
        return;
      }
      const registry = embedRef.current;
      if (registry && embedShowingRef.current) {
        runCommand(registry, EMBED_COMMANDS[command]);
        return;
      }
      switch (command) {
        case 'zoom-in':
          return dispatch({ type: 'ZOOM_IN' });
        case 'zoom-out':
          return dispatch({ type: 'ZOOM_OUT' });
        case 'fit-page':
        case 'fit-width':
          return dispatch({ type: 'SET_ZOOM_MODE', mode: command });
        case 'actual-size':
          return dispatch({ type: 'SET_ZOOM', zoom: 1 });
        case 'find':
          return dispatch({ type: 'FIND_OPEN' });
        case 'sidebar':
          return dispatch({ type: 'TOGGLE_LEFT_PANE' });
        case 'undo':
          return void undoEdit();
        case 'redo':
          return void redoEdit();
        case 'print':
          // EmbedPDF prints; the menu offers Print only while it is on screen.
          return;
      }
    },
    [undoEdit, redoEdit, organizeStep, printFile, printWay],
  );

  // From state, not refs: whatever shows these (the toolbar, the macOS menu
  // bar) renders again when they change. Read from refs during render, the
  // sidebar button showed the state before the click that changed it.
  const { zoomMode } = state;
  const findOpen = state.find.open;
  const viewCommandOn = useCallback(
    (command: ViewCommand): boolean => {
      if (embedShowing) return command in embedToggles ? embedToggles[command as keyof ViewToggles] : false;
      if (command === 'fit-page' || command === 'fit-width') return zoomMode === command;
      if (command === 'sidebar') return leftOpen;
      if (command === 'find') return findOpen;
      return false;
    },
    [embedShowing, embedToggles, zoomMode, leftOpen, findOpen],
  );

  const goToPage = useCallback((page: number) => {
    const registry = embedRef.current;
    if (registry && embedShowingRef.current) scrollToPage(registry, page);
    else dispatch({ type: 'SCROLL_TO_PAGE', page });
  }, []);

  const canUndo = organizing
    ? !state.organize.busy && organizeSteps.undo > 0
    : embedShowing
      ? embedHistory.canUndo
      : !state.edit.busy && canUndoStack(state.edit.stack);
  const canRedo = organizing
    ? !state.organize.busy && organizeSteps.redo > 0
    : embedShowing
      ? embedHistory.canRedo
      : !state.edit.busy && canRedoStack(state.edit.stack);
  // A browser prints through EmbedPDF while it is on screen; the desktop
  // prints the file (or its pages), from either view, once no switch is
  // under way and no print is being prepared.
  const printsItself = isTauriHost() ? nativePrint : printWay === 'pages';
  const canPrint = printsItself
    ? state.view === 'viewer' && state.document !== null && state.switching === null && printing === null
    : embedShowing;

  const bytesForSave = useCallback(async (): Promise<Uint8Array<ArrayBuffer> | null> => {
    const doc = documentRef.current;
    if (!doc) return null;
    // Whichever view is current holds the latest file: EmbedPDF's carries its
    // annotations and redactions, Warraq's its Arabic edits.
    const fromEmbed = warraqOwnsDocument(stateRef.current) ? null : await bytesFromEmbed();
    const own = fromEmbed ? await keepOwnBytes(fromEmbed) : null;
    // Layers shown by choice are the view's, not the file's.
    return own
      ? new Uint8Array(await withOwnLayers(own))
      : layerOwnRef.current
        ? new Uint8Array(await withOwnLayers(new Uint8Array(await doc.save()).slice().buffer))
        : doc.save();
  }, [bytesFromEmbed, keepOwnBytes, withOwnLayers]);

  // A file opened from a cloud drive is saved back to it (`cloud/`).
  const saveTarget = useRef<SaveTarget | null>(null);
  const claimSave = useCallback((target: SaveTarget | null) => {
    saveTarget.current = target;
  }, []);

  const save = useCallback(
    async (toDevice: boolean) => {
      const name = stateRef.current.document?.name;
      if (!documentRef.current || !name) return;
      try {
        const bytes = await bytesForSave();
        if (!bytes) return;
        const target = toDevice ? null : saveTarget.current;
        if (target) {
          const outcome = await target.save(bytes, name);
          if (!outcome.saved) return;
          forgetRecentThumbnail(name);
          dispatch({ type: 'DOCUMENT_SAVED' });
          dispatch({ type: 'TOAST', key: outcome.toast });
          return;
        }
        if (isTauriHost()) {
          // Cancelling the panel is not a failure, and not a save either.
          if (!(await savePdfFile(bytes, pdfFileName(name)))) return;
        } else {
          downloadPdf(bytes, name);
        }
        // The saved file may not look like the picture the home screen kept of
        // it: a page gone, a password set, a redaction applied. Taken again
        // when the file is next opened (home/recentPicture.ts).
        forgetRecentThumbnail(name);
        // A copy on the device of a file that lives in a drive is not that file saved.
        if (!toDevice || !saveTarget.current) dispatch({ type: 'DOCUMENT_SAVED' });
        dispatch({ type: 'TOAST', key: 'file.saved' });
      } catch (error) {
        const tooLarge = String(error instanceof Error ? error.message : error).includes('E_SIGNED_TOO_LARGE');
        dispatch({ type: 'DOCUMENT_FAILED', error: tooLarge ? 'signatures.error.tooLarge' : 'file.saveFailed' });
      }
    },
    [bytesForSave],
  );
  const saveDocument = useCallback(() => save(false), [save]);
  const saveToDevice = useCallback(() => save(true), [save]);

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? [...event.target.files] : [];
    const purpose = inputPurpose.current;
    // Back to Open's picker, whatever this one was for.
    inputPurpose.current = 'open';
    event.target.accept = 'application/pdf,.pdf';
    event.target.multiple = false;
    event.target.value = '';
    if (files.length === 0) return;
    if (purpose === 'create') startCreate(files);
    else void openFiles(files);
  };

  const services = useMemo<AppServices>(
    () => ({
      client,
      document,
      documentBytes,
      fileBytes: layerOwn ?? documentBytes,
      documentPassword,
      recent,
      openFile,
      openedFile,
      unlockFile,
      cancelUnlock,
      openFiles,
      dropFiles,
      takeCombineDrop,
      startCreate,
      takeCreateFiles,
      claimDrops,
      dropLabel,
      dropClaimed: dropLabel !== 'drop.overlay',
      closeDocument,
      requestOpenFile,
      requestCreateFiles,
      attachEmbed,
      embedRegistry: embed,
      embedOpened,
      runEmbedCommand,
      embedShowing,
      viewCommand,
      viewCommandOn,
      canUndo,
      canRedo,
      canPrint,
      printing,
      cancelPrint,
      goToPage,
      organizePages,
      extractPages,
      insertPagesFromFile,
      splitDocument,
      currentFileBytes,
      fileBytesForChange,
      replaceFile: replaceCurrentFile,
      pendingRedactions,
      markForRedaction,
      readFile,
      layersShown,
      showLayers,
      keepLayerVisibility,
      resetLayers,
      combineFiles,
      compressFile,
      saveCopy,
      recognizeText,
      saveReport,
      transformFile,
      clearRecent,
      commitParagraph,
      rememberFileChange,
      addText,
      undoEdit,
      redoEdit,
      saveDocument,
      saveToDevice,
      bytesForSave,
      claimSave,
    }),
    [
      client,
      document,
      documentBytes,
      layerOwn,
      documentPassword,
      recent,
      openFile,
      openedFile,
      unlockFile,
      cancelUnlock,
      openFiles,
      dropFiles,
      takeCombineDrop,
      startCreate,
      takeCreateFiles,
      claimDrops,
      dropLabel,
      closeDocument,
      requestOpenFile,
      requestCreateFiles,
      attachEmbed,
      embed,
      embedOpened,
      runEmbedCommand,
      embedShowing,
      viewCommand,
      viewCommandOn,
      canUndo,
      canRedo,
      canPrint,
      printing,
      cancelPrint,
      goToPage,
      organizePages,
      extractPages,
      insertPagesFromFile,
      splitDocument,
      currentFileBytes,
      fileBytesForChange,
      replaceCurrentFile,
      pendingRedactions,
      markForRedaction,
      readFile,
      layersShown,
      showLayers,
      keepLayerVisibility,
      resetLayers,
      combineFiles,
      compressFile,
      saveCopy,
      recognizeText,
      saveReport,
      transformFile,
      clearRecent,
      commitParagraph,
      rememberFileChange,
      addText,
      undoEdit,
      redoEdit,
      saveDocument,
      saveToDevice,
      bytesForSave,
      claimSave,
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
