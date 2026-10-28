import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from './client';
import {
  FILE_DRAG_EVENT,
  FILE_DROP_EVENT,
  LIBRARY_SCAN_EVENT,
  LIBRARY_WATCH_EVENT,
  OPEN_FILE_EVENT,
  deleteLibraryIndex,
  forgetRecentPath,
  handleTauriRequest,
  hasLibraryHost,
  isTauriHost,
  keepNativePath,
  libraryIndexFolder,
  listLibraryIndexes,
  loadLibraryIndex,
  nativePathOf,
  onLibraryScan,
  onLibraryWatch,
  onNativeFileDrag,
  onNativeFileDrop,
  onOpenFileRequest,
  openRecentFile,
  pickFiles,
  pickLibraryFolders,
  pickPdfFile,
  printAvailable,
  printMode,
  printPdf,
  printWebview,
  readLibraryFile,
  rememberRecentPath,
  saveFileAs,
  saveLibraryIndex,
  savePdfFile,
  startLibraryScan,
  startLibraryWatch,
  statLibraryFile,
  stopLibraryScan,
  stopLibraryWatch,
  takeStartupFile,
  withoutPdfium,
  resetRing,
} from './host-tauri';
import type { LibraryScanEvent, LibraryWatchEvent } from './host-tauri';
import type { ResultMap } from './protocol';

type Invoke = (
  cmd: string,
  args?: unknown,
  options?: { headers?: Record<string, string> },
) => Promise<unknown>;

interface Call {
  cmd: string;
  args?: unknown;
  options?: { headers?: Record<string, string> };
}

/** Stand-in for the commands in `apps/desktop/src-tauri/src/core_bridge.rs`. */
/** Callbacks the fake host handed out, in registration order. */
const callbacks: ((payload: unknown) => void)[] = [];

function fakeHost(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const invoke: Invoke = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd in overrides) {
      const value = overrides[cmd];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    switch (cmd) {
      case 'core_version':
        return Promise.resolve('0.1.0');
      case 'core_engine':
        return Promise.resolve('pdfium+hayro');
      case 'doc_open':
        return Promise.resolve(1);
      case 'doc_page_count':
        return Promise.resolve(1);
      case 'doc_page_size':
        return Promise.resolve([595, 842]);
      case 'doc_metadata':
        return Promise.resolve(
          '{"title":"فاتورة","pages":1,"encrypted":false,"engine":"pdfium+hayro"}',
        );
      case 'doc_close':
        return Promise.resolve(true);
      default:
        return Promise.reject(new Error(`E_UNKNOWN: ${cmd}`));
    }
  };
  const transformCallback = (callback: (payload: never) => void) => {
    callbacks.push(callback as (payload: unknown) => void);
    return callbacks.length;
  };
  (
    globalThis as {
      __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback: typeof transformCallback };
    }
  ).__TAURI_INTERNALS__ = { invoke, transformCallback };
  return calls;
}

/** `width` u32 LE + `height` u32 LE + RGBA, the body `doc_render_page` sends. */
function bitmapBody(width: number, height: number): ArrayBuffer {
  const buffer = new ArrayBuffer(8 + width * height * 4);
  const view = new DataView(buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  new Uint8Array(buffer, 8).fill(0x2a);
  return buffer;
}

afterEach(() => {
  callbacks.length = 0;
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('Tauri host adapter', () => {
  it('is inactive in a plain browser', () => {
    expect(isTauriHost()).toBe(false);
  });

  it('reports the native core with the engine the Rust side chose', async () => {
    fakeHost();
    expect(await handleTauriRequest('init', {})).toEqual({
      kind: 'native',
      version: '0.1.0',
      engine: 'pdfium+hayro',
    });
  });

  it('passes the engine through even when PDFium could not be loaded', async () => {
    fakeHost({ core_engine: 'hayro' });
    const status = await handleTauriRequest('init', {});
    expect(status.engine).toBe('hayro');
  });

  it('opens with the PDF bytes as the raw body and the password hex-encoded', async () => {
    const calls = fakeHost();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;
    const opened = await handleTauriRequest('open', { bytes, password: 'سر' });
    expect(opened).toEqual({
      doc: 1,
      pageCount: 1,
      pageSizes: [[595, 842]],
      metadata: { title: 'فاتورة', pages: 1, encrypted: false, engine: 'pdfium+hayro' },
    });
    const open = calls.find((c) => c.cmd === 'doc_open');
    expect(open?.args).toBe(bytes);
    expect(open?.options?.headers).toEqual({ 'x-warraq-password-hex': 'd8b3d8b1' });
  });

  it('sends no password header when there is no password', async () => {
    const calls = fakeHost();
    await handleTauriRequest('open', { bytes: new ArrayBuffer(4) });
    expect(calls.find((c) => c.cmd === 'doc_open')?.options).toBeUndefined();
  });

  it('decodes the binary render response into the worker shape', async () => {
    fakeHost({ doc_render_page: bitmapBody(3, 2) });
    const page = (await handleTauriRequest('render_page', {
      doc: 1,
      index: 0,
      scale: 1,
    })) as ResultMap['render_page'];
    expect(page.width).toBe(3);
    expect(page.height).toBe(2);
    expect(page.rgba).toBeInstanceOf(Uint8ClampedArray);
    expect(page.rgba.length).toBe(3 * 2 * 4);
    expect(page.rgba[0]).toBe(0x2a);
  });

  it('rejects a truncated bitmap instead of reading past the buffer', async () => {
    fakeHost({ doc_render_page: new ArrayBuffer(4) });
    await expect(handleTauriRequest('render_page', { doc: 1, index: 0, scale: 1 })).rejects.toThrow(
      /E_RENDER/,
    );
  });

  it('maps free to doc_close', async () => {
    const calls = fakeHost();
    expect(await handleTauriRequest('free', { doc: 7 })).toBeNull();
    expect(calls.at(-1)).toMatchObject({ cmd: 'doc_close', args: { handle: 7 } });
  });
});

describe('CoreClient host selection', () => {
  it('uses the native host inside Tauri and never builds a worker', async () => {
    fakeHost();
    const client = new CoreClient();
    expect(await client.init()).toMatchObject({ kind: 'native', engine: 'pdfium+hayro' });
  });

  it('turns a native failure into a CoreClientError with the stable code', async () => {
    fakeHost({ doc_page_count: new Error('E_NOT_FOUND: document 9 is not open') });
    const client = new CoreClient();
    await expect(client.request('page_count', { doc: 9 })).rejects.toMatchObject({
      name: 'CoreClientError',
      code: 'E_NOT_FOUND',
    });
  });

  it('still prefers an injected worker, so the browser tests are unaffected', () => {
    fakeHost();
    const worker = { onmessage: null, onerror: null, postMessage: vi.fn(), terminate: vi.fn() };
    const client = new CoreClient({ worker: worker as unknown as Worker });
    void client.request('page_count', { doc: 1 });
    expect(worker.postMessage).toHaveBeenCalledOnce();
  });
});

/**
 * The webview ignores the browser file plumbing the web build uses, so the
 * desktop shell has to go through the dialog and fs plugins. These lock the
 * payloads to what `tauri-plugin-dialog` and `tauri-plugin-fs` actually
 * deserialize; getting them wrong fails silently, which is exactly how this
 * shipped broken the first time.
 */
describe('native file dialogs', () => {
  const PDF = [{ name: 'PDF', extensions: ['pdf'] }];

  it('opens the native panel filtered to PDFs and reads the picked file', async () => {
    const calls = fakeHost({
      'plugin:dialog|open': '/Users/me/تقرير سنوي.pdf',
      read_file_bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
    });
    const picked = await pickPdfFile();
    expect(picked?.name).toBe('تقرير سنوي.pdf');
    expect(new Uint8Array(picked?.bytes ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
    expect(calls.find((c) => c.cmd === 'plugin:dialog|open')?.args).toEqual({
      options: { multiple: false, directory: false, filters: PDF },
    });
    expect(calls.find((c) => c.cmd === 'read_file_bytes')?.args).toEqual({
      path: '/Users/me/تقرير سنوي.pdf',
    });
  });

  it('picks any kind of file, one or several, with the filters it is given', async () => {
    const calls = fakeHost({
      'plugin:dialog|open': ['/Users/me/توقيع.png', '/Users/me/scan.jpg'],
      read_file_bytes: new Uint8Array([0x89, 0x50]).buffer,
    });
    const filters = [{ name: 'png, jpg', extensions: ['png', 'jpg'] }];
    const picked = await pickFiles(filters, true);
    expect(picked.map((f) => f.name)).toEqual(['توقيع.png', 'scan.jpg']);
    expect(new Uint8Array(picked[0]!.bytes)).toEqual(new Uint8Array([0x89, 0x50]));
    expect(calls[0]?.args).toEqual({ options: { multiple: true, directory: false, filters } });
    expect(calls.filter((c) => c.cmd === 'read_file_bytes').map((c) => c.args)).toEqual([
      { path: '/Users/me/توقيع.png' },
      { path: '/Users/me/scan.jpg' },
    ]);
  });

  it('picks nothing when the panel is cancelled, or a single path when one is chosen', async () => {
    fakeHost({ 'plugin:dialog|open': null });
    expect(await pickFiles([], false)).toEqual([]);
    fakeHost({ 'plugin:dialog|open': '/Users/me/notes.txt', read_file_bytes: new ArrayBuffer(3) });
    expect((await pickFiles([], false)).map((f) => f.name)).toEqual(['notes.txt']);
  });

  it('returns null when the open panel is cancelled', async () => {
    const calls = fakeHost({ 'plugin:dialog|open': null });
    expect(await pickPdfFile()).toBeNull();
    expect(calls.some((c) => c.cmd === 'read_file_bytes')).toBe(false);
  });

  it('accepts a byte array from a host that does not send a raw body', async () => {
    fakeHost({ 'plugin:dialog|open': '/tmp/a.pdf', read_file_bytes: [0x25, 0x50] });
    const picked = await pickPdfFile();
    expect(new Uint8Array(picked?.bytes ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array([0x25, 0x50]),
    );
  });

  it('writes through the save panel, with the path percent-encoded in a header', async () => {
    const calls = fakeHost({
      'plugin:dialog|save': '/Users/me/تقرير.pdf',
      'plugin:fs|write_file': null,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await savePdfFile(bytes, 'تقرير.pdf')).toBe(true);
    expect(calls.find((c) => c.cmd === 'plugin:dialog|save')?.args).toEqual({
      options: { defaultPath: 'تقرير.pdf', filters: PDF },
    });
    const write = calls.find((c) => c.cmd === 'plugin:fs|write_file');
    expect(write?.args).toBe(bytes);
    expect(write?.options?.headers).toEqual({ path: encodeURIComponent('/Users/me/تقرير.pdf') });
  });

  it('reports a cancelled save without writing anything', async () => {
    const calls = fakeHost({ 'plugin:dialog|save': null });
    expect(await savePdfFile(new Uint8Array([1]), 'x.pdf')).toBe(false);
    expect(calls.some((c) => c.cmd === 'plugin:fs|write_file')).toBe(false);
  });

  it('saves any kind of file the same way, with that kind in the panel', async () => {
    const calls = fakeHost({
      'plugin:dialog|save': '/Users/me/تقرير (الصفحات).zip',
      'plugin:fs|write_file': null,
    });
    const bytes = new Uint8Array([0x50, 0x4b]);
    expect(await saveFileAs(bytes, 'تقرير (الصفحات).zip', { name: 'ZIP', extensions: ['zip'] })).toBe(true);
    expect(calls.find((c) => c.cmd === 'plugin:dialog|save')?.args).toEqual({
      options: { defaultPath: 'تقرير (الصفحات).zip', filters: [{ name: 'ZIP', extensions: ['zip'] }] },
    });
    const write = calls.find((c) => c.cmd === 'plugin:fs|write_file');
    expect(write?.args).toBe(bytes);
    expect(write?.options?.headers).toEqual({ path: encodeURIComponent('/Users/me/تقرير (الصفحات).zip') });
  });
});

describe('printing', () => {
  it('sends the file as the raw body, and its password hex-encoded', async () => {
    const calls = fakeHost({ print_pdf: null });
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;
    await printPdf(bytes, 'سر');
    const print = calls.find((c) => c.cmd === 'print_pdf');
    expect(print?.args).toBe(bytes);
    expect(print?.options?.headers).toEqual({ 'x-warraq-password-hex': 'd8b3d8b1' });
    await printPdf(bytes);
    expect(calls.filter((c) => c.cmd === 'print_pdf')[1]?.options).toBeUndefined();
  });

  it('asks the host which way it prints, and has it print the laid-out pages', async () => {
    fakeHost({ print_mode: 'pages' });
    expect(await printMode()).toBe('pages');
    fakeHost({ print_mode: 'pdfkit' });
    expect(await printMode()).toBe('pdfkit');
    const calls = fakeHost({ print_webview: null });
    await printWebview();
    expect(calls.map((c) => c.cmd)).toContain('print_webview');
  });

  it("passes on the host's reason when it cannot print", async () => {
    fakeHost({ print_pdf: new Error('E_PRINT_FORBIDDEN: this file does not allow printing') });
    await expect(printPdf(new ArrayBuffer(4))).rejects.toThrow('E_PRINT_FORBIDDEN');
  });

  it('is offered only where the host says it can, and never in a browser', async () => {
    expect(await printAvailable()).toBe(false);
    fakeHost({ print_available: true });
    expect(await printAvailable()).toBe(true);
    fakeHost({ print_available: false });
    expect(await printAvailable()).toBe(false);
  });
});

describe('native drag and drop', () => {
  it('reads every dropped path the host reports', async () => {
    const calls = fakeHost({
      'plugin:event|listen': 4,
      read_file_bytes: new Uint8Array([0x25, 0x50]).buffer,
    });
    const dropped: string[] = [];
    const where: unknown[] = [];
    const stop = onNativeFileDrop((files, at) => {
      dropped.push(...files.map((f) => f.name));
      where.push(at);
    });

    expect(calls.find((c) => c.cmd === 'plugin:event|listen')?.args).toMatchObject({
      event: FILE_DROP_EVENT,
      target: { kind: 'Any' },
      handler: 1,
    });

    callbacks[0]?.({ payload: { paths: ['/Users/me/عقد.pdf'], x: 120, y: 80 } });
    await vi.waitFor(() => expect(dropped).toEqual(['عقد.pdf']));
    expect(where).toEqual([{ x: 120, y: 80 }]);
    expect(calls.find((c) => c.cmd === 'read_file_bytes')?.args).toEqual({
      path: '/Users/me/عقد.pdf',
    });

    stop();
    await vi.waitFor(() =>
      expect(calls.find((c) => c.cmd === 'plugin:event|unlisten')?.args).toEqual({
        event: FILE_DROP_EVENT,
        eventId: 4,
      }),
    );
  });

  it('reports where files are dragged, and when they leave', async () => {
    const calls = fakeHost({ 'plugin:event|listen': 5 });
    const seen: unknown[] = [];
    const stop = onNativeFileDrag((at) => seen.push(at));
    const handler = callbacks.at(-1);
    expect(calls.find((c) => c.cmd === 'plugin:event|listen')?.args).toMatchObject({
      event: FILE_DRAG_EVENT,
    });
    handler?.({ payload: { kind: 'over', x: 10.5, y: 20 } });
    handler?.({ payload: { kind: 'leave', x: 0, y: 0 } });
    expect(seen).toEqual([{ x: 10.5, y: 20 }, null]);
    stop();
  });

  it('does nothing in a browser, where the HTML5 drop listener works', () => {
    expect(onNativeFileDrop(() => {})).toBeInstanceOf(Function);
  });
});

describe('startup file', () => {
  it('opens a PDF named on the command line', async () => {
    fakeHost({ startup_file: '/tmp/تقرير.pdf', read_file_bytes: new Uint8Array([0x25]).buffer });
    const picked = await takeStartupFile();
    expect(picked?.name).toBe('تقرير.pdf');
  });

  it('is null when nothing was passed, and in a browser', async () => {
    fakeHost({ startup_file: null });
    expect(await takeStartupFile()).toBeNull();
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    expect(await takeStartupFile()).toBeNull();
  });

  it('carries where the file is, for the recent list', async () => {
    fakeHost({ startup_file: 'C:\\Docs\\عقد.pdf', read_file_bytes: new Uint8Array([0x25]).buffer });
    const picked = await takeStartupFile();
    expect(picked).toMatchObject({ name: 'عقد.pdf', path: 'C:\\Docs\\عقد.pdf' });
  });

  it('is announced again when a second launch hands a file over', () => {
    const calls = fakeHost();
    let asked = 0;
    onOpenFileRequest(() => (asked += 1));
    expect(calls.find((c) => c.cmd === 'plugin:event|listen')?.args).toMatchObject({ event: OPEN_FILE_EVENT });
    callbacks[0]?.({ payload: null });
    expect(asked).toBe(1);
  });
});

describe('recent files on the desktop', () => {
  it('keeps where a file was read from on the File itself', () => {
    const file = keepNativePath(new File([], 'a.pdf'), '/docs/a.pdf');
    expect(nativePathOf(file)).toBe('/docs/a.pdf');
    expect(nativePathOf(keepNativePath(new File([], 'b.pdf'), undefined))).toBeUndefined();
  });

  it('opens a recent file again from where the host says it is', async () => {
    const calls = fakeHost({ recent_path: '/docs/تقرير.pdf', read_file_bytes: new Uint8Array([0x25]).buffer });
    const picked = await openRecentFile('تقرير.pdf');
    expect(picked).toMatchObject({ name: 'تقرير.pdf', path: '/docs/تقرير.pdf' });
    expect(calls.find((c) => c.cmd === 'recent_path')?.args).toEqual({ name: 'تقرير.pdf' });
  });

  it('is null when the host no longer knows the file, and in a browser', async () => {
    fakeHost({ recent_path: null });
    expect(await openRecentFile('gone.pdf')).toBeNull();
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    expect(await openRecentFile('gone.pdf')).toBeNull();
  });

  it('remembers and forgets paths without failing the caller', async () => {
    const calls = fakeHost({ recent_remember: new Error('E_SCOPE'), recent_forget: null });
    rememberRecentPath('a.pdf', '/docs/a.pdf');
    forgetRecentPath('a.pdf');
    forgetRecentPath();
    await vi.waitFor(() => expect(calls.filter((c) => c.cmd.startsWith('recent_')).length).toBe(3));
    expect(calls.map((c) => c.args)).toEqual([
      { name: 'a.pdf', path: '/docs/a.pdf' },
      { name: 'a.pdf' },
      { name: null },
    ]);
  });
});

describe('the desktop core without PDFium', () => {
  it('is told apart from the core that has it, and from the browsers’, which never had it', () => {
    expect(withoutPdfium({ kind: 'native', version: '0.1.0', engine: 'hayro' })).toBe(true);
    expect(withoutPdfium({ kind: 'native', version: '0.1.0', engine: 'pdfium+hayro' })).toBe(false);
    expect(withoutPdfium({ kind: 'wasm', version: '0.1.0' })).toBe(false);
    expect(withoutPdfium({ kind: 'mock', version: '0.0.0' })).toBe(false);
    expect(withoutPdfium(null)).toBe(false);
  });
});

describe('the Library on the desktop host', () => {
  it('is offered only where a whole folder can be reached', () => {
    expect(hasLibraryHost()).toBe(false);
    fakeHost();
    expect(hasLibraryHost()).toBe(true);
  });

  it('picks several folders, and puts everything under them in the file scope', async () => {
    const calls = fakeHost({ 'plugin:dialog|open': ['/Users/n/فواتير', '/Users/n/عقود'] });
    expect(await pickLibraryFolders()).toEqual(['/Users/n/فواتير', '/Users/n/عقود']);
    expect(calls.at(-1)?.args).toEqual({
      options: { multiple: true, directory: true, recursive: true },
    });
  });

  it('takes one folder, and nothing when the person cancels', async () => {
    fakeHost({ 'plugin:dialog|open': '/Users/n/فواتير' });
    expect(await pickLibraryFolders()).toEqual(['/Users/n/فواتير']);
    fakeHost({ 'plugin:dialog|open': null });
    expect(await pickLibraryFolders()).toEqual([]);
  });

  it('starts a walk that answers at once with its number, and is stopped by it', async () => {
    const calls = fakeHost({ library_scan_start: 7, library_scan_stop: true });
    const request = {
      roots: [{ path: '/Users/n/فواتير', recursive: true, exclude: ['/Users/n/فواتير/مسودات'] }],
      known: [{ key: '/Users/n/فواتير/a.pdf', size: 12, modified: 1_700_000_000_000 }],
    };
    expect(await startLibraryScan(request)).toBe(7);
    expect(calls.at(-1)).toMatchObject({ cmd: 'library_scan_start', args: { request } });
    expect(await stopLibraryScan(7)).toBe(true);
    expect(calls.at(-1)).toMatchObject({ cmd: 'library_scan_stop', args: { scan: 7 } });
  });

  it('hands the walk’s batches to the panel as they arrive, and stops listening', async () => {
    const calls = fakeHost({ 'plugin:event|listen': 11, 'plugin:event|unlisten': null });
    const seen: LibraryScanEvent[] = [];
    const stop = onLibraryScan((event) => seen.push(event));
    expect(calls.find((c) => c.cmd === 'plugin:event|listen')?.args).toMatchObject({
      event: LIBRARY_SCAN_EVENT,
    });
    const handler = callbacks.at(-1);
    handler?.({
      payload: {
        scan: 7,
        kind: 'progress',
        current: '/Users/n/فواتير',
        files: [
          {
            key: '/Users/n/فواتير/a.pdf',
            name: 'a.pdf',
            relative: 'a.pdf',
            root: '/Users/n/فواتير',
            size: 12,
            modified: 1,
            extension: 'pdf',
            state: 'new',
          },
        ],
        skipped: [{ path: '/Users/n/فواتير/locked', reason: 'unreadable' }],
        found: 1,
        folders: 1,
        stopped: false,
        truncated: false,
      },
    });
    handler?.({ payload: undefined });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.files[0]?.state).toBe('new');
    expect(seen[0]?.skipped[0]?.reason).toBe('unreadable');
    // The host answers `listen` with the id the unsubscribe needs; it arrives
    // on a microtask, as it does in the window.
    await Promise.resolve();
    stop();
    expect(calls.find((c) => c.cmd === 'plugin:event|unlisten')?.args).toMatchObject({
      event: LIBRARY_SCAN_EVENT,
      eventId: 11,
    });
  });

  it('reads one file when its turn comes, and passes the host’s refusal on', async () => {
    const calls = fakeHost({ library_read_file: new Uint8Array([0x25, 0x50]).buffer });
    const bytes = await readLibraryFile('/Users/n/فواتير/a.pdf');
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([0x25, 0x50]));
    expect(calls.at(-1)?.args).toEqual({ path: '/Users/n/فواتير/a.pdf' });
    fakeHost({ library_read_file: new Error('E_SCOPE: … was not chosen through the folder picker') });
    await expect(readLibraryFile('/etc/passwd')).rejects.toThrow('E_SCOPE');
  });

  it('asks whether a file is still what the index holds', async () => {
    fakeHost({ library_stat: { exists: true, size: 12, modified: 5 } });
    expect(await statLibraryFile('/Users/n/فواتير/a.pdf')).toEqual({
      exists: true,
      size: 12,
      modified: 5,
    });
  });

  it('writes the index into the app’s own data directory, its name in the header', async () => {
    const calls = fakeHost({ library_index_save: 4096, library_index_path: '/Users/n/Library/Application Support/app.warraq.desktop/library' });
    expect(await libraryIndexFolder()).toContain('app.warraq.desktop');
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await saveLibraryIndex('main', bytes)).toBe(4096);
    const save = calls.find((c) => c.cmd === 'library_index_save');
    expect(save?.args).toBe(bytes);
    expect(save?.options?.headers).toEqual({ 'x-warraq-name': 'main' });
  });

  it('reads the index back, and answers null on a first run rather than failing', async () => {
    fakeHost({ library_index_load: new Uint8Array([0x57]).buffer });
    expect(new Uint8Array((await loadLibraryIndex('main')) as ArrayBuffer)).toEqual(
      new Uint8Array([0x57]),
    );
    fakeHost({ library_index_load: new Error('E_MISSING: no index named main') });
    expect(await loadLibraryIndex('main')).toBeNull();
    fakeHost({ library_index_load: new Error('E_IO: the disk is full') });
    await expect(loadLibraryIndex('main')).rejects.toThrow('E_IO');
  });

  it('lists the indexes and really deletes one', async () => {
    const calls = fakeHost({
      library_index_list: [
        { name: 'main', bytes: 4096, modified: 5, path: '/…/library/main.wlx' },
      ],
      library_index_delete: true,
    });
    expect(await listLibraryIndexes()).toHaveLength(1);
    expect(await deleteLibraryIndex('main')).toBe(true);
    expect(calls.at(-1)).toMatchObject({ cmd: 'library_index_delete', args: { name: 'main' } });
    fakeHost({ library_index_delete: false });
    expect(await deleteLibraryIndex('main')).toBe(false);
  });

  it('says how the watcher works, and when it is not watching at all', async () => {
    fakeHost({ library_watch_start: { watching: true, files: 120, seconds: 5 } });
    const answer = await startLibraryWatch({ roots: [{ path: '/Users/n/فواتير', recursive: true }] });
    expect(answer).toEqual({ watching: true, files: 120, seconds: 5 });
    fakeHost({ library_watch_start: { watching: false, files: 40_000, seconds: 5, reason: 'too-many' } });
    const refused = await startLibraryWatch({ roots: [{ path: '/Users/n/كل شيء', recursive: true }] });
    expect(refused.watching).toBe(false);
    expect(refused.reason).toBe('too-many');
  });

  it('hands over what changed under a watched folder, and says when it gives up', async () => {
    const calls = fakeHost({ library_watch_stop: null });
    const seen: LibraryWatchEvent[] = [];
    const stop = onLibraryWatch((event) => seen.push(event));
    expect(calls.find((c) => c.cmd === 'plugin:event|listen')?.args).toMatchObject({
      event: LIBRARY_WATCH_EVENT,
    });
    const handler = callbacks.at(-1);
    handler?.({ payload: { added: [], changed: [], removed: ['/Users/n/فواتير/a.pdf'] } });
    handler?.({ payload: { added: [], changed: [], removed: [], stopped: 'too-many' } });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.removed).toEqual(['/Users/n/فواتير/a.pdf']);
    expect(seen[1]?.stopped).toBe('too-many');
    stop();
    await stopLibraryWatch();
    expect(calls.some((c) => c.cmd === 'library_watch_stop')).toBe(true);
  });

  it('does nothing at all in a browser, where there is no host to ask', () => {
    expect(onLibraryScan(() => {})).toBeInstanceOf(Function);
    expect(onLibraryWatch(() => {})).toBeInstanceOf(Function);
  });
});

describe('resetting the ring', () => {
  it('puts the drag key, size, shortcut and drop zone back, and keeps the app ready as it was', async () => {
    const now = { ring: false, background: true, scale: 1.2, shortcut: 'CommandOrControl+Shift+K', dragKey: 'shift', dropZone: false };
    const calls = fakeHost({ ring_settings: now, ring_configure: now });
    await resetRing();
    const sent = calls.find((call) => call.cmd === 'ring_configure');
    expect(sent?.args).toEqual({ ring: true, background: true, scale: 1, shortcut: 'CommandOrControl+Alt+Z', dragKey: 'any', dropZone: true });
  });
});
