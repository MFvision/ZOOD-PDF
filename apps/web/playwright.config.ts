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
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    channel: 'chrome',
    headless: true,
    locale: 'en-US',
    acceptDownloads: true,
    viewport: { width: 1400, height: 1000 },
  },
  webServer: {
    command: 'pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
