import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { zoodUi } from '@zood/ui/vite';
import { webShell, zoodDesktop } from './vite-plugin-desktop';

const here = path.dirname(fileURLToPath(import.meta.url));

// The shared interface, built for Tauri: same HTML entry as apps/web (served through
// webShell), our own src/main.ts (Tauri host bridge), no <meta> CSP (Tauri sends the CSP
// from tauri.conf.json), no service worker.
export default defineConfig({
  base: './',
  publicDir: path.resolve(here, '../web/public'),
  plugins: [webShell(path.resolve(here, '../web/index.html')), zoodUi(), zoodDesktop()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
