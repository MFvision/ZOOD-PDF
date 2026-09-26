/**
 * The e2e suite under a slow CPU, to reproduce the races a loaded machine exposes (a test that fails in a
 * full `verify.sh` run and passes alone). Same specs and server as `playwright.config.ts`; every page of
 * every context (the default `page` fixture and `browser.newContext()` alike) gets Chrome DevTools'
 * CPU throttling (`Emulation.setCPUThrottlingRate`, default 6×, `E2E_CPU_THROTTLE` to change).
 *
 *   E2E_PORT=4325 pnpm exec playwright test -c tests/e2e/stress.config.ts tests/e2e/layout.spec.ts --repeat-each=5
 *
 * Combine with `taskset -c 0` on the browser (PW_CHROMIUM_PATH=wrapper) to also starve PDFium's worker.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

const rate = Number(process.env.E2E_CPU_THROTTLE ?? 6);
const require = createRequire(import.meta.url);
// The client-side BrowserContext class of the playwright-core instance @playwright/test runs on.
const pw = path.dirname(require.resolve('playwright/package.json', { paths: [path.dirname(require.resolve('@playwright/test/package.json'))] }));
const core = path.dirname(require.resolve('playwright-core/package.json', { paths: [pw] }));
interface Ctx {
  _onPage(page: unknown): void;
  newCDPSession(page: unknown): Promise<{ send(method: string, params: unknown): Promise<unknown> }>;
}
const { BrowserContext } = require(path.join(core, 'lib/client/browserContext.js')) as { BrowserContext: { prototype: Ctx } };
const onPage = BrowserContext.prototype._onPage;
BrowserContext.prototype._onPage = function (this: Ctx, page: unknown) {
  onPage.call(this, page);
  void this.newCDPSession(page)
    .then((s) => s.send('Emulation.setCPUThrottlingRate', { rate }))
    .catch(() => undefined);
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
// base's relative paths are relative to the repository root, not to this file.
export default defineConfig({
  ...base,
  testDir: path.join(root, 'tests/e2e'),
  outputDir: path.join(root, 'test-results/e2e-stress'),
  reporter: [['list']],
  webServer: { ...(base.webServer as object), cwd: root } as typeof base.webServer,
  timeout: 180_000,
  expect: { timeout: 30_000 },
});
