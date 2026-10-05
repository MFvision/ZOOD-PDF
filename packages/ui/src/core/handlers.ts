import type { CoreRequest, HandledResult, ResultMap } from './protocol';
import type {
  CallReply,
  CoreDocument,
  CoreError,
  CoreModule,
  CoreStatus,
  DocumentMetadata,
  ReplaceParagraphResult,
} from './types';

/** Pure request handling shared by the worker and by tests. */
export interface CoreRuntime {
  module: CoreModule;
  status: CoreStatus;
  documents: Map<number, CoreDocument>;
  nextDocumentId: number;
}

export function createRuntime(module: CoreModule, status: CoreStatus): CoreRuntime {
  return { module, status, documents: new Map(), nextDocumentId: 1 };
}

function coreError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Normalizes anything thrown by the core into `{ code, message }`. */
export function toCoreError(err: unknown): CoreError {
  if (err && typeof err === 'object') {
    const { code, message } = err as { code?: unknown; message?: unknown };
    const text = typeof message === 'string' ? message : String(err);
    if (typeof code === 'string') return { code, message: text };
    const prefixed = /^(E_[A-Z_]+)/.exec(text);
    return { code: prefixed?.[1] ?? 'E_UNKNOWN', message: text };
  }
  return { code: 'E_UNKNOWN', message: String(err) };
}

function getDocument(runtime: CoreRuntime, id: number): CoreDocument {
  const doc = runtime.documents.get(id);
  if (!doc) throw coreError('E_NOT_FOUND', `document ${id} is not open`);
  return doc;
}

function parseMetadata(json: string, pageCount: number): DocumentMetadata {
  try {
    const parsed = JSON.parse(json) as Partial<DocumentMetadata>;
    return { ...parsed, pages: parsed.pages ?? pageCount, encrypted: Boolean(parsed.encrypted) };
  } catch {
    return { pages: pageCount, encrypted: false };
  }
}

function openDocument(runtime: CoreRuntime, bytes: ArrayBuffer, password?: string) {
  const doc = runtime.module.Document.open(new Uint8Array(bytes), password);
  const id = runtime.nextDocumentId;
  runtime.nextDocumentId += 1;
  runtime.documents.set(id, doc);
  const pageCount = doc.page_count();
  const pageSizes: ResultMap['open']['pageSizes'] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const size = doc.page_size(i);
    pageSizes.push([size[0] ?? 0, size[1] ?? 0]);
  }
  const info: ResultMap['open'] = {
    doc: id,
    pageCount,
    pageSizes,
    metadata: parseMetadata(doc.metadata(), pageCount),
  };
  return info;
}

function renderPage(doc: CoreDocument, index: number, scale: number): HandledResult {
  const page = doc.render_page(index, scale);
  try {
    // Copy out of WASM memory into a buffer we own, so it can be transferred.
    const rgba = new Uint8ClampedArray(new ArrayBuffer(page.width * page.height * 4));
    rgba.set(page.rgba.subarray(0, rgba.length));
    const result: ResultMap['render_page'] = { width: page.width, height: page.height, rgba };
    return { result, transfer: [rgba.buffer] };
  } finally {
    page.free();
  }
}

function textLines(doc: CoreDocument, index: number): ResultMap['text_lines'] {
  return doc.text_lines(index).map((line) => {
    const data = {
      text: line.text,
      x: line.x,
      y: line.y,
      width: line.width,
      height: line.height,
      direction: line.direction,
    };
    line.free();
    return data;
  });
}

function fontClass(value: string | undefined): 'serif' | 'sans' | 'unknown' {
  return value === 'serif' || value === 'sans' ? value : 'unknown';
}

function paragraphs(doc: CoreDocument, index: number): ResultMap['paragraphs'] {
  return doc.paragraphs(index).map((para) => {
    const data = {
      index: para.index,
      text: para.text,
      x: para.x,
      y: para.y,
      width: para.width,
      height: para.height,
      direction: para.direction,
      alignment: para.alignment,
      fontSize: para.font_size,
      lineCount: para.line_count,
      fontFamily: para.font_family ?? '',
      fontWeight: para.font_weight ?? 400,
      fontItalic: para.font_italic ?? false,
      fontClass: fontClass(para.font_class),
      ownFont: para.own_font ?? false,
    };
    para.free();
    return data;
  });
}

/** `{lines_drawn, font_substituted}` from the core, in UI casing. */
export function parseReplaceResult(json: string): ReplaceParagraphResult {
  try {
    const parsed = JSON.parse(json) as {
      lines_drawn?: unknown;
      font_substituted?: unknown;
      shrunk?: unknown;
      overflowed?: unknown;
    };
    return {
      linesDrawn: typeof parsed.lines_drawn === 'number' ? parsed.lines_drawn : 0,
      fontSubstituted: parsed.font_substituted === true,
      shrunk: parsed.shrunk === true,
      overflowed: parsed.overflowed === true,
    };
  } catch {
    // An unreadable answer must not look like "the original font was kept".
    return { linesDrawn: 0, fontSubstituted: true, shrunk: false, overflowed: false };
  }
}

function saveDocument(doc: CoreDocument): HandledResult {
  const bytes = doc.save();
  // Copy out of WASM memory so the buffer can be transferred to the UI thread.
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return { result: owned, transfer: [owned.buffer] };
}

/** Copies a tool's reply out of WASM memory into buffers that can be transferred. */
function callReply(reply: CallReply): HandledResult {
  try {
    const blobs = reply.blobs.map((blob) => {
      const bytes = blob as Uint8Array;
      const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
      owned.set(bytes);
      return owned.buffer;
    });
    const result: ResultMap['call'] = { json: reply.json, blobs };
    return { result, transfer: blobs };
  } finally {
    reply.free();
  }
}

export function handleRequest(runtime: CoreRuntime, request: CoreRequest): HandledResult {
  const plain = (result: unknown): HandledResult => ({ result, transfer: [] });
  switch (request.kind) {
    case 'init':
      return plain(runtime.status);
    case 'open':
      return plain(openDocument(runtime, request.bytes, request.password));
    case 'page_count':
      return plain(getDocument(runtime, request.doc).page_count());
    case 'page_size': {
      const size = getDocument(runtime, request.doc).page_size(request.index);
      return plain([size[0] ?? 0, size[1] ?? 0]);
    }
    case 'render_page':
      return renderPage(getDocument(runtime, request.doc), request.index, request.scale);
    case 'extract_text':
      return plain(getDocument(runtime, request.doc).extract_text(request.index));
    case 'text_lines':
      return plain(textLines(getDocument(runtime, request.doc), request.index));
    case 'search':
      return plain(Array.from(getDocument(runtime, request.doc).search(request.query)));
    case 'metadata': {
      const doc = getDocument(runtime, request.doc);
      return plain(parseMetadata(doc.metadata(), doc.page_count()));
    }
    case 'paragraphs':
      return plain(paragraphs(getDocument(runtime, request.doc), request.index));
    case 'add_text': {
      const doc = getDocument(runtime, request.doc);
      doc.add_text(
        request.index,
        request.x,
        request.y,
        request.size,
        request.text,
        new Uint8Array(request.font),
      );
      return plain(null);
    }
    case 'replace_paragraph': {
      const doc = getDocument(runtime, request.doc);
      const json = doc.replace_paragraph(
        request.index,
        request.para,
        request.text,
        new Uint8Array(request.font),
      );
      return plain(parseReplaceResult(json));
    }
    case 'save':
      return saveDocument(getDocument(runtime, request.doc));
    case 'call': {
      const blobs = request.blobs.map((blob) => new Uint8Array(blob));
      return callReply(
        request.doc === null
          ? runtime.module.call_static(request.op, request.args, blobs)
          : getDocument(runtime, request.doc).call(request.op, request.args, blobs),
      );
    }
    case 'free': {
      const doc = runtime.documents.get(request.doc);
      doc?.free();
      runtime.documents.delete(request.doc);
      return plain(null);
    }
    default: {
      const unknown = request as { kind: string };
      throw coreError('E_UNKNOWN', `unknown request ${unknown.kind}`);
    }
  }
}
