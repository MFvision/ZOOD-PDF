import { randomBytes } from 'node:crypto';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * The dev server injects an inline React Fast Refresh preamble, which the strict
 * CSP in index.html would block. In `serve` mode only, a per-start nonce is added
 * to `script-src` and handed to Vite (`html.cspNonce`). Production builds ship the
 * exact CSP from index.html.
 */
const devNonce = randomBytes(16).toString('base64');

function devCspNonce(): Plugin {
  return {
    name: 'warraq:dev-csp-nonce',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("script-src 'self' 'wasm-unsafe-eval'", `script-src 'self' 'wasm-unsafe-eval' 'nonce-${devNonce}'`);
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), devCspNonce()],
  html: command === 'serve' ? { cspNonce: devNonce } : undefined,
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
  resolve: { dedupe: ['react', 'react-dom'] },
}));
