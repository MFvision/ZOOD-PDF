import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { cloudConfig } from '../../packages/ui/vite/cloudConfig';
import { embedPatches, embedPatchesForDeps } from '../../packages/ui/vite/embedPatches';
import { notices } from '../../packages/ui/vite/notices';
import { ocrModels } from '../../packages/ui/vite/ocrModels';
import { serviceWorker } from './pwa';

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
      return html.replace(
        "script-src 'self' 'wasm-unsafe-eval'",
        `script-src 'self' 'wasm-unsafe-eval' 'nonce-${devNonce}'`,
      );
    },
  };
}

/**
 * The desktop host must not receive the CSP from `index.html`.
 *
 * Tauri serves the page with a `Content-Security-Policy` header of its own,
 * built from `tauri.conf.json` and extended at runtime with the nonces its
 * injected scripts carry and the origin its IPC uses. A second policy in the
 * document does not replace that one — the browser enforces both, and the
 * strictest wins, so the host's own scripts and IPC are blocked by a policy
 * that cannot know about them. The symptom is an app that looks fine and
 * cannot do anything: no file opens, nothing renders.
 *
 * `--mode tauri` therefore strips the meta tag and leaves the policy to
 * `tauri.conf.json`. A plain build keeps it, because a static web host has
 * nowhere else to put one.
 */
export function stripMetaCsp(): Plugin {
  return {
    name: 'warraq:strip-meta-csp',
    transformIndexHtml(html) {
      return html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  plugins: [
    react(),
    devCspNonce(),
    embedPatches(),
    ocrModels(),
    notices(),
    serviceWorker(),
    // The cloud drives this build offers, from its environment (docs/cloud.md).
    cloudConfig(mode),
    ...(mode === 'tauri' ? [stripMetaCsp()] : []),
  ],
  optimizeDeps: { rolldownOptions: { plugins: [embedPatchesForDeps()] } },
  html: command === 'serve' ? { cspNonce: devNonce } : undefined,
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    // The bundled packages' licences, beside those `notices()` adds.
    license: { fileName: 'licenses/THIRD-PARTY-LICENSES.md' },
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        // Where a browser sign-in comes back to (the OneDrive app's redirect URI).
        'oauth-callback': fileURLToPath(new URL('oauth-callback.html', import.meta.url)),
        // The phone remote's page, which only the desktop serves (to a phone on its network).
        ...(mode === 'tauri' ? { remote: fileURLToPath(new URL('remote.html', import.meta.url)) } : {}),
      },
    },
  },
  worker: { format: 'es' },
  resolve: { dedupe: ['react', 'react-dom'] },
}));
