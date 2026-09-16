import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from './client';
import { handleTauriRequest, isTauriHost } from './host-tauri';
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
  (globalThis as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__ = { invoke };
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
