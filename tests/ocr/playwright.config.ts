import { defineConfig, devices } from '@playwright/test';

/** Full OCR benchmark (`pnpm ocr:bench`): the production build of apps/web on E2E_PORT. */
const PORT = Number(process.env.E2E_PORT ?? 4311);
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'benchmark',
  testMatch: 'bench.spec.ts',
  outputDir: '../../test-results/ocr-bench',
  workers: 1,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { baseURL: BASE, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `pnpm -C apps/web build && pnpm -C apps/web exec vite preview --port ${PORT} --strictPort`,
    cwd: '../..',
    url: BASE,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
