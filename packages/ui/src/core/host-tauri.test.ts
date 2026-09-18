import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from './client';
import {
  FILE_DROP_EVENT,
  HTML_FILTER,
  handleTauriRequest,
  isTauriHost,
  onNativeFileDrop,
  pickPdfFile,
  saveNativeFile,
  savePdfFile,
  takeStartupFile,
} from './host-tauri';
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

  it('saves other kinds of file the same way, offering their own type', async () => {
    const calls = fakeHost({
      'plugin:dialog|save': '/Users/me/تقرير (comparison).html',
      'plugin:fs|write_file': null,
    });
    const bytes = new TextEncoder().encode('<!doctype html>');
    expect(await saveNativeFile(bytes, 'تقرير (comparison).html', HTML_FILTER)).toBe(true);
    expect(calls.find((c) => c.cmd === 'plugin:dialog|save')?.args).toEqual({
      options: { defaultPath: 'تقرير (comparison).html', filters: [{ name: 'HTML', extensions: ['html'] }] },
    });
    const write = calls.find((c) => c.cmd === 'plugin:fs|write_file');
    expect(write?.args).toBe(bytes);
    expect(write?.options?.headers).toEqual({
      path: encodeURIComponent('/Users/me/تقرير (comparison).html'),
    });
  });
});

describe('native drag and drop', () => {
  it('reads every dropped path the host reports', async () => {
    const calls = fakeHost({
      'plugin:event|listen': 4,
      read_file_bytes: new Uint8Array([0x25, 0x50]).buffer,
    });
    const dropped: string[] = [];
    const stop = onNativeFileDrop((files) => dropped.push(...files.map((f) => f.name)));

    expect(calls.find((c) => c.cmd === 'plugin:event|listen')?.args).toMatchObject({
      event: FILE_DROP_EVENT,
      target: { kind: 'Any' },
      handler: 1,
    });

    callbacks[0]?.({ payload: { paths: ['/Users/me/عقد.pdf'] } });
    await vi.waitFor(() => expect(dropped).toEqual(['عقد.pdf']));
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
});
