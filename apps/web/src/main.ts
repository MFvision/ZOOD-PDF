import { mountApp } from '@zood/ui';

// The document title starts in the browser language; the app keeps it in sync with the chosen locale.
if (navigator.language?.toLowerCase().startsWith('ar')) document.title = 'زود PDF';

mountApp(document.getElementById('root')!, { platform: 'web' });

// Offline shell. The service worker caches the application files only — never documents.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      /* offline support is optional */
    });
  });
}
