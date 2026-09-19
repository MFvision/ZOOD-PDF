import { afterEach, describe, expect, it } from 'vitest';
import { debugSelfCheck, listBatchFolder, pickBatchFiles, pickFolder, readBatchFile, writeBatchResult } from '../core/host-tauri';

/**
 * The batch's side of the desktop host (`apps/desktop/src-tauri/src/batch.rs`,
 * whose own tests cover the writing rules): what the interface asks of it,
 * against a stand-in that records every call.
 */

interface Call {
  cmd: string;
  args?: unknown;
  headers?: Record<string, string>;
}

function fakeHost(answers: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
      calls.push({ cmd, args, headers: options?.headers });
      return cmd in answers ? Promise.resolve(answers[cmd]) : Promise.reject(new Error(`unexpected ${cmd}`));
    },
  };
  return calls;
}

afterEach(() => {
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('the batch on the desktop', () => {
  it('takes files from the native panel by path, without reading them yet', async () => {
    const calls = fakeHost({ 'plugin:dialog|open': ['/Users/me/فواتير/أ.pdf', '/Users/me/b.pdf'] });
    expect(await pickBatchFiles()).toEqual([
      { name: 'أ.pdf', path: '/Users/me/فواتير/أ.pdf' },
      { name: 'b.pdf', path: '/Users/me/b.pdf' },
    ]);
    expect(calls.map((c) => c.cmd)).toEqual(['plugin:dialog|open']);
    expect(calls[0]?.args).toMatchObject({ options: { multiple: true, directory: false } });
  });

  it('asks for a folder, with everything under it when it is to be read', async () => {
    const calls = fakeHost({ 'plugin:dialog|open': '/Users/me/فواتير' });
    expect(await pickFolder(true)).toBe('/Users/me/فواتير');
    expect(calls[0]?.args).toEqual({ options: { multiple: false, directory: true, recursive: true } });
    fakeHost({ 'plugin:dialog|open': null });
    expect(await pickFolder(false)).toBeNull();
  });

  it("lists a folder's PDFs through the host and reads one when its turn comes", async () => {
    const calls = fakeHost({
      batch_list_folder: [{ path: '/f/sub/a.pdf', name: 'a.pdf', relative: 'sub/a.pdf', size: 12 }],
      read_file_bytes: new Uint8Array([37, 80, 68, 70]),
    });
    expect(await listBatchFolder('/f', false)).toEqual([{ path: '/f/sub/a.pdf', name: 'a.pdf', relative: 'sub/a.pdf', size: 12 }]);
    expect(calls[0]?.args).toEqual({ path: '/f', recursive: false });
    expect(new Uint8Array(await readBatchFile('/f/sub/a.pdf'))).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(calls[1]).toMatchObject({ cmd: 'read_file_bytes', args: { path: '/f/sub/a.pdf' } });
  });

  it('writes a result into a chosen folder or beside its original, the names percent-encoded', async () => {
    const calls = fakeHost({ batch_write: '/Users/me/فواتير/أ-معالج (2).pdf' });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await writeBatchResult(bytes, 'أ-معالج.pdf', { beside: '/Users/me/فواتير/أ.pdf' })).toBe('/Users/me/فواتير/أ-معالج (2).pdf');
    expect(calls[0]?.args).toBe(bytes);
    expect(calls[0]?.headers).toEqual({
      'x-warraq-name': encodeURIComponent('أ-معالج.pdf'),
      'x-warraq-beside': encodeURIComponent('/Users/me/فواتير/أ.pdf'),
    });
    await writeBatchResult(bytes, 'b.pdf', { dir: '/Users/me/out' });
    expect(calls[1]?.headers).toEqual({ 'x-warraq-name': 'b.pdf', 'x-warraq-dir': encodeURIComponent('/Users/me/out') });
  });

  it('asks the host for a self-check only inside the desktop app', async () => {
    expect(await debugSelfCheck()).toBeNull();
    fakeHost({ debug_selfcheck: null });
    expect(await debugSelfCheck()).toBeNull();
    fakeHost({ debug_selfcheck: 'ocr' });
    expect(await debugSelfCheck()).toBe('ocr');
  });
});
