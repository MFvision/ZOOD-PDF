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
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'warraq-core' });
}

/**
 * Typed async client for the core worker. Method names mirror `API.md`;
 * every call returns a Promise and large buffers are transferred, not copied.
 */
export class CoreClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private statusPromise: Promise<CoreStatus> | null = null;

  private readonly forceMock: boolean;

  constructor(options: { worker?: Worker; forceMock?: boolean } = {}) {
    this.worker = options.worker ?? createDefaultWorker();
    this.forceMock = options.forceMock ?? false;
    this.worker.onmessage = (event: MessageEvent<CoreResponse>) => this.settle(event.data);
    this.worker.onerror = (event) => {
      const message = event.message || 'core worker failed';
      for (const { reject } of this.pending.values()) reject(new CoreClientError('E_WORKER', message));
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
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, kind, ...payload } as CoreRequest;
    return new Promise<ResultMap[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as ResultMap[K]), reject });
      this.worker.postMessage(message, transfer);
    });
  }

  terminate(): void {
    this.worker.terminate();
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
