import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds viewer.html (which mounts @warraq/ui) into dist/. The UI's worker and
// the WASM core are emitted as extension files under dist/assets/, so the
// extension CSP (script-src 'self' 'wasm-unsafe-eval'; workers fall back to
// 'self') loads them without any remote source. manifest.json, background.js,
// _locales/ and icons/ are copied and the store zip is written by
// scripts/postbuild.mjs.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { viewer: 'viewer.html' },
    },
  },
  worker: {
    format: 'es',
  },
});
