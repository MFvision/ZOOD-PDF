import { handleTauriRequest, isTauriHost } from './host-tauri';
import type { CoreRequest, CoreResponse, RequestKind, RequestMap, ResultMap } from './protocol';
import type { CoreStatus, DocumentMetadata, OpenedDocumentInfo, PageSize } from './types';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class CoreClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreClientError';
    this.code = code;
  }
}

function createDefaultWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'warraq-core',
  });
}

/** Normalizes anything the native host throws into a `CoreClientError`. */
function toClientError(err: unknown): CoreClientError {
  if (err instanceof CoreClientError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CoreClientError(/^(E_[A-Z_]+)/.exec(message)?.[1] ?? 'E_UNKNOWN', message);
}

/**
 * Typed async client for the core. Method names mirror `API.md`; every call
 * returns a Promise and large buffers are transferred, not copied.
 *
 * Two hosts, one protocol: in a browser the requests go to the WASM Web Worker;
 * inside Tauri they go to the natively linked core through `host-tauri.ts`, so
 * the desktop renders with PDFium and everything else behaves identically.
 */
export class CoreClient {
  private readonly worker: Worker | null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private statusPromise: Promise<CoreStatus> | null = null;

  private readonly forceMock: boolean;

  constructor(options: { worker?: Worker; forceMock?: boolean } = {}) {
    this.forceMock = options.forceMock ?? false;
    // Desktop: no worker at all — an injected worker or `?core=mock` still wins.
    const native = !options.worker && !this.forceMock && isTauriHost();
    this.worker = native ? null : (options.worker ?? createDefaultWorker());
    if (!this.worker) return;
    this.worker.onmessage = (event: MessageEvent<CoreResponse>) => this.settle(event.data);
    this.worker.onerror = (event) => {
      const message = event.message || 'core worker failed';
      for (const { reject } of this.pending.values())
        reject(new CoreClientError('E_WORKER', message));
      this.pending.clear();
    };
  }

  /** Resolves once the worker has chosen the WASM module or the mock. */
  init(): Promise<CoreStatus> {
    this.statusPromise ??= this.request('init', { mock: this.forceMock });
    return this.statusPromise;
  }

  version(): Promise<string> {
    return this.init().then((status) => status.version);
  }

  /** `Document.open(bytes, password?)`; the bytes buffer is transferred to the worker. */
  async open(bytes: Uint8Array | ArrayBuffer, password?: string): Promise<RemoteDocument> {
    const buffer =
      bytes instanceof ArrayBuffer
        ? bytes
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const info = await this.request('open', { bytes: buffer as ArrayBuffer, password }, [
      buffer as ArrayBuffer,
    ]);
    return new RemoteDocument(this, info);
  }

  request<K extends RequestKind>(
    kind: K,
    payload: RequestMap[K],
    transfer: Transferable[] = [],
  ): Promise<ResultMap[K]> {
    const worker = this.worker;
    if (!worker) {
      return handleTauriRequest(kind, payload).catch((err: unknown) => {
        throw toClientError(err);
      });
    }
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, kind, ...payload } as CoreRequest;
    return new Promise<ResultMap[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as ResultMap[K]), reject });
      worker.postMessage(message, transfer);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new CoreClientError('E_WORKER', 'core worker terminated'));
    }
    this.pending.clear();
  }

  private settle(response: CoreResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new CoreClientError(response.error.code, response.error.message));
  }
}

/** Promise-returning twin of the core `Document` class. */
export class RemoteDocument {
  readonly id: number;
  readonly pageCount: number;
  readonly pageSizes: readonly PageSize[];
  readonly info: DocumentMetadata;
  private freed = false;

  constructor(
    private readonly client: CoreClient,
    opened: OpenedDocumentInfo,
  ) {
    this.id = opened.doc;
    this.pageCount = opened.pageCount;
    this.pageSizes = opened.pageSizes;
    this.info = opened.metadata;
  }

  page_count(): Promise<number> {
    return this.client.request('page_count', { doc: this.id });
  }

  page_size(index: number): Promise<PageSize> {
    return this.client.request('page_size', { doc: this.id, index });
  }

  render_page(index: number, scale: number): Promise<ResultMap['render_page']> {
    return this.client.request('render_page', { doc: this.id, index, scale });
  }

  extract_text(index: number): Promise<string> {
    return this.client.request('extract_text', { doc: this.id, index });
  }

  text_lines(index: number): Promise<ResultMap['text_lines']> {
    return this.client.request('text_lines', { doc: this.id, index });
  }

  search(query: string): Promise<number[]> {
    return this.client.request('search', { doc: this.id, query });
  }

  metadata(): Promise<DocumentMetadata> {
    return this.client.request('metadata', { doc: this.id });
  }

  /** Editable paragraphs of a page, in the device space of `text_lines`. */
  paragraphs(index: number): Promise<ResultMap['paragraphs']> {
    return this.client.request('paragraphs', { doc: this.id, index });
  }

  /**
   * Reflows paragraph `para` of page `index` to `text`, shaped with `font`.
   * The font bytes are copied, never transferred, so the caller can keep and
   * reuse the one bundled face across every edit.
   */
  replace_paragraph(
    index: number,
    para: number,
    text: string,
    font: Uint8Array,
  ): Promise<ResultMap['replace_paragraph']> {
    const buffer = font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength);
    return this.client.request(
      'replace_paragraph',
      { doc: this.id, index, para, text, font: buffer as ArrayBuffer },
      [buffer as ArrayBuffer],
    );
  }

  /**
   * Draw a new line of text at a point on the page, in points from its
   * top-left corner. `x` is where the line starts, so Arabic grows leftwards
   * from it.
   */
  add_text(
    index: number,
    x: number,
    y: number,
    size: number,
    text: string,
    font: Uint8Array,
  ): Promise<ResultMap['add_text']> {
    const buffer = font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength);
    return this.client.request(
      'add_text',
      { doc: this.id, index, x, y, size, text, font: buffer as ArrayBuffer },
      [buffer as ArrayBuffer],
    );
  }

  /** Edited bytes: an incremental update over the original wherever possible. */
  save(): Promise<ResultMap['save']> {
    return this.client.request('save', { doc: this.id });
  }

  free(): Promise<void> {
    if (this.freed) return Promise.resolve();
    this.freed = true;
    return this.client.request('free', { doc: this.id }).then(() => undefined);
  }
}

let shared: CoreClient | null = null;

/** `?core=mock` in the page URL forces the mock core (useful while the WASM build is unstable). */
function mockRequestedByUrl(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('core') === 'mock';
  } catch {
    return false;
  }
}

/** One worker per page; created lazily so StrictMode double-mounts do not leak workers. */
export function getSharedCoreClient(): CoreClient {
  shared ??= new CoreClient({ forceMock: mockRequestedByUrl() });
  return shared;
}
