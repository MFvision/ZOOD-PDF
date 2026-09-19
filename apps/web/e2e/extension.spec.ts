import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import { WORD_EXPORT, documentStatus, embedTiles } from './helpers';

const DIST = fileURLToPath(new URL('../../extension/dist', import.meta.url));
const CHROME =
  process.env.CHROME ??
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');

/**
 * The browser extension, installed the way Chrome still allows an unpacked one
 * to be: through DevTools (`Extensions.loadUnpacked`), since branded Chrome now
 * ignores `--load-extension`. Its viewer page runs under the extension's own
 * policy, which the web build's tests never exercise.
 *
 * Needs the extension built first: `pnpm --filter @warraq/extension build`.
 */
test('the extension viewer opens an Arabic PDF, and its AI tool needs no host permissions', async () => {
  test.skip(!existsSync(join(DIST, 'manifest.json')), 'the extension is not built');
  const profile = mkdtempSync(join(tmpdir(), 'warraq-extension-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    // Chrome writes the port it chose here once DevTools is listening.
    const portFile = join(profile, 'DevToolsActivePort');
    await expect.poll(() => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n')).toBe(true);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const session = await browser.newBrowserCDPSession();
    const { id } = await session.send('Extensions.loadUnpacked', { path: DIST });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome has no default context');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.goto(`chrome-extension://${id}/viewer.html`);
    await page.locator('input[type="file"]').setInputFiles(WORD_EXPORT);
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    await expect(documentStatus(page)).toContainText('Page 1 of 2');

    // The AI tool from the extension's own page, which has no host permissions:
    // its policy restricts scripts, not connections, and Anthropic's API allows
    // any origin. Answered here, so nothing reaches Anthropic.
    const sent: string[] = [];
    await page.route('https://api.anthropic.com/**', (route) => {
      sent.push(route.request().postData() ?? '');
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'Read from the extension [p. 1].' }], stop_reason: 'end_turn' }),
      });
    });
    await page.locator('.pane-end .tool-card', { hasText: 'AI' }).click();
    const ai = page.locator('.pane-end');
    await ai.getByRole('radio', { name: /^Claude/ }).check();
    await ai.getByLabel('Anthropic API key').fill('sk-ant-api03-e2e-not-a-real-key');
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await ai.getByRole('button', { name: 'Send to Anthropic' }).click();
    await expect(ai.getByRole('region', { name: 'Answer' })).toContainText('Read from the extension');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('صباح الخير');
    expect(errors).toEqual([]);
    await browser.close();
  } finally {
    // Chrome keeps writing its profile for a moment after the signal; the
    // directory goes once it has exited, with retries for late writes.
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
