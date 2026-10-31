import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { serviceWorkerSource } from '../pwa';

const BUILD = [
  'index.html',
  'sw.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'assets/index-abc.js',
  'assets/warraq_core_bg-abc.wasm',
  'assets/pdfium-abc.wasm',
  'assets/tesseract-core-lstm.wasm-abc.js',
  'assets/worker.min-abc.js',
  'assets/ort-wasm-simd-threaded-abc.wasm',
  'assets/detect.worker-abc.js',
  'ocr/ara.traineddata.gz',
  'ocr/lines.onnx',
  'licenses/THIRD-PARTY-LICENSES.md',
];

/** The two lists a worker was written with. */
function lists(source: string): { shell: string[]; lazy: string[] } {
  return {
    shell: JSON.parse(/const SHELL = (\[.*\]);/.exec(source)![1]!) as string[],
    lazy: JSON.parse(/const LAZY = new Set\((\[.*\])\);/.exec(source)![1]!) as string[],
  };
}

describe('the service worker the build writes', () => {
  it('keeps the app and both engines at install, OCR and the licences on first use, and never itself', () => {
    const { shell, lazy } = lists(serviceWorkerSource(BUILD));
    expect(shell).toEqual([
      '/assets/index-abc.js',
      '/assets/pdfium-abc.wasm',
      '/assets/warraq_core_bg-abc.wasm',
      '/icons/icon-192.png',
      '/index.html',
      '/manifest.webmanifest',
    ]);
    expect(lazy).toEqual([
      '/assets/detect.worker-abc.js',
      '/assets/ort-wasm-simd-threaded-abc.wasm',
      '/assets/tesseract-core-lstm.wasm-abc.js',
      '/assets/worker.min-abc.js',
      '/licenses/THIRD-PARTY-LICENSES.md',
      '/ocr/ara.traineddata.gz',
      '/ocr/lines.onnx',
    ]);
  });

  it('is a new worker when the build is new, and the same one when it is not', () => {
    const version = (source: string) => /const VERSION = "([0-9a-f]+)"/.exec(source)![1];
    const one = serviceWorkerSource(BUILD);
    expect(version(serviceWorkerSource([...BUILD].reverse()))).toBe(version(one));
    expect(version(serviceWorkerSource([...BUILD, 'assets/index-def.js']))).not.toBe(version(one));
  });

  it('touches only GET requests to its own origin', () => {
    const source = serviceWorkerSource(BUILD);
    expect(source).toContain("if (request.method !== 'GET') return;");
    expect(source).toContain('if (url.origin !== self.location.origin) return;');
  });

  it('is registered by the web page only, never in the desktop build', () => {
    const register = readFileSync(new URL('./registerServiceWorker.ts', import.meta.url), 'utf8');
    expect(register).toContain("import.meta.env.MODE === 'tauri'");
    expect(register).toContain("'__TAURI_INTERNALS__' in window");
  });
});
