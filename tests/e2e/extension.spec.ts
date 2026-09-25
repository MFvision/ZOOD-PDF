import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium, expect, test } from '@playwright/test';
import { ROOT, fixture, trackExternalRequests, waitForDocument } from './helpers';

const EXT = path.join(ROOT, 'apps/extension/dist');

test.describe('Chrome MV3 extension', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(path.join(EXT, 'manifest.json'))) execSync('pnpm -C apps/extension build', { cwd: ROOT, stdio: 'inherit' });
  });

  test('manifest: localized name, minimal permissions, strict CSP', () => {
    const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    expect(m.manifest_version).toBe(3);
    expect(m.name).toBe('__MSG_appName__');
    expect(m.permissions ?? []).toEqual([]);
    expect(m.host_permissions).toBeUndefined();
    expect(m.content_security_policy.extension_pages).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    const en = JSON.parse(fs.readFileSync(path.join(EXT, '_locales/en/messages.json'), 'utf8'));
    const ar = JSON.parse(fs.readFileSync(path.join(EXT, '_locales/ar/messages.json'), 'utf8'));
    expect(en.appName.message).toBe('ZOOD PDF');
    expect(ar.appName.message).toBe('زود PDF');
  });

  test('the extension page runs the app and opens a PDF', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zood-ext-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    try {
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const id = new URL(sw.url()).host;
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      const external = trackExternalRequests(page);
      await page.goto(`chrome-extension://${id}/index.html`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('PDF, reimagined');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-card=open]').click()]);
      await chooser.setFiles(fixture('sample-en.pdf'));
      await waitForDocument(page);
      await expect(page.locator('[data-testid=doc-status]')).toHaveText('Page 1 of 2');
      expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
      expect(external).toEqual([]);
    } finally {
      await context.close();
      // Chrome keeps writing its profile briefly after close: remove it last, best effort.
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
