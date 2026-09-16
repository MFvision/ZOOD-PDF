import type {
  CoreError,
  CoreStatus,
  DocumentMetadata,
  OpenedDocumentInfo,
  PageSize,
  RenderedPageData,
  TextLineData,
} from './types';

/** Request/response messages between `client.ts` and `worker.ts`. */

export interface RequestMap {
  init: { mock?: boolean };
  open: { bytes: ArrayBuffer; password?: string };
  page_count: { doc: number };
  page_size: { doc: number; index: number };
  render_page: { doc: number; index: number; scale: number };
  extract_text: { doc: number; index: number };
  text_lines: { doc: number; index: number };
  search: { doc: number; query: string };
  metadata: { doc: number };
  free: { doc: number };
}

export interface ResultMap {
  init: CoreStatus;
  open: OpenedDocumentInfo;
  page_count: number;
  page_size: PageSize;
  render_page: RenderedPageData;
  extract_text: string;
  text_lines: TextLineData[];
  search: number[];
  metadata: DocumentMetadata;
  free: null;
}

export type RequestKind = keyof RequestMap;

export type CoreRequest = {
  [K in RequestKind]: { id: number; kind: K } & RequestMap[K];
}[RequestKind];

export type CoreResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: CoreError };

export interface HandledResult {
  result: unknown;
  transfer: Transferable[];
}
