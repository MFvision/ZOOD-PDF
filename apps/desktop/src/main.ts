// ZOOD PDF desktop entry: install the Tauri host bridge, then mount the shared interface.
import { mountApp } from '@zood/ui';
import { createTauriHost } from '../../../packages/ui/src/services/host-tauri';
import { tauriApis } from './tauri-apis';

/** Resolves once React has put something into the root element. */
function whenRendered(root: HTMLElement): Promise<void> {
  if (root.childElementCount > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      if (root.childElementCount > 0) {
        obs.disconnect();
        resolve();
      }
    });
    obs.observe(root, { childList: true });
  });
}

async function boot(): Promise<void> {
  const host = await createTauriHost(tauriApis);
  // getHost() prefers a native host installed before the app boots (packages/ui/src/services/host.ts).
  window.__ZOOD_HOST__ = host;
  if (navigator.language?.toLowerCase().startsWith('ar')) document.title = 'زود PDF';
  const root = document.getElementById('root');
  if (!root) throw new Error('missing #root');
  mountApp(root, { platform: 'desktop' });
  await whenRendered(root);
  await host.ready();
}

boot().catch((err: unknown) => {
  console.error('ZOOD PDF failed to start', err);
});
