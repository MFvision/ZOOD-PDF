/**
 * Registers the service worker the build writes (`pwa.ts`), which keeps the
 * app's own files on the device so an installed ZOOD PDF opens offline.
 *
 * Only the web build has one: the desktop app (`--mode tauri`) serves its
 * files from itself, and a dev server's files change under it.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || import.meta.env.MODE === 'tauri') return;
  if (!('serviceWorker' in navigator) || '__TAURI_INTERNALS__' in window) return;
  // After the page has what it needs: the worker's first download waits its turn.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Without it the app still works; it just needs the network to open.
    });
  });
}
