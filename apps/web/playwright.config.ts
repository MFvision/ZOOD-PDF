import { defineConfig } from '@playwright/test';

/**
 * End-to-end: the real interface in a real browser, driven by clicks.
 *
 * Every failure the first desktop build shipped with passed the unit tests,
 * because nothing ever clicked through the interface. These do. They run
 * against the production web build (`vite preview`) — the same UI code the
 * desktop app embeds — in the Google Chrome already on the machine, so there
 * is no browser download.
 *
 * A tool is not done until a spec here proves it through the interface.
 */
// WARRAQ_E2E_PORT lets two checkouts (say, a worktree) run the suite at once.
const PORT = Number(process.env.WARRAQ_E2E_PORT ?? 4391);
const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: ORIGIN,
    channel: 'chrome',
    headless: true,
    locale: 'en-US',
    acceptDownloads: true,
    viewport: { width: 1400, height: 1000 },
    // The service worker downloads the whole app into its cache; only the
    // spec that tests it (pwa.spec.ts) lets it run, the rest load plainly.
    serviceWorkers: 'block',
  },
  // Its own port on an explicit address, and never a server it did not start:
  // with `reuseExistingServer` another project's dev server on the usual
  // preview port once answered instead, and the run tested someone else's app.
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
