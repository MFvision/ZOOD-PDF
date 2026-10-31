import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

/**
 * The desktop file bridge (packages/ui/src/core/desktopFiles.ts), in a real
 * browser, against a stand-in for the Tauri host: the macOS webview ignores
 * file inputs and download links, so on desktop they go through the native
 * panels instead. Each case copies what EmbedPDF itself does.
 */

const BRIDGE = fileURLToPath(
  new URL('../../../packages/ui/src/core/desktopFiles.ts', import.meta.url),
);

let bridge = '';

test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: BRIDGE, formats: ['iife'], name: 'WarraqBridge' },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs
    .flatMap((o) => ('output' in o ? o.output : []))
    .find((c) => c.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the bridge did not build');
  bridge = chunk.code;
});

type Call = { cmd: string; args: unknown; headers?: Record<string, string> };

/** A page with a fake Tauri host that answers the dialog and file commands. */
async function desktopPage(page: Page) {
  await page.setContent('<!doctype html><meta charset="utf-8"><body><div id="host"></div></body>');
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const calls: unknown[] = [];
    w.calls = calls;
    w.pick = null;
    w.savePath = '/Users/me/حفظ.png';
    w.files = { '/Users/me/توقيع.png': [0x89, 0x50, 0x4e, 0x47, 1, 2, 3] };
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => 0,
      invoke: (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => {
        const bytes = args instanceof Uint8Array ? [...args] : args;
        calls.push({ cmd, args: bytes, headers: options?.headers });
        switch (cmd) {
          case 'plugin:dialog|open':
            return Promise.resolve(w.pick);
          case 'read_file_bytes': {
            const path = (args as { path: string }).path;
            return Promise.resolve(
              new Uint8Array((w.files as Record<string, number[]>)[path] ?? []).buffer,
            );
          }
          case 'plugin:dialog|save':
            return Promise.resolve(w.savePath);
          case 'save_file':
            return Promise.resolve(null);
          default:
            return Promise.reject(new Error(`unexpected ${cmd}`));
        }
      },
    };
  });
  await page.addScriptTag({ content: bridge });
  await page.evaluate(() => {
    const w = window as unknown as {
      WarraqBridge: { installDesktopFileBridge: () => () => void };
      uninstall: () => void;
    };
    w.uninstall = w.WarraqBridge.installDesktopFileBridge();
  });
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: Call[] }).calls);

test('a tool’s hidden file input gets the file chosen in the native panel', async ({ page }) => {
  await desktopPage(page);
  await page.evaluate(() => {
    (window as unknown as { pick: string }).pick = '/Users/me/توقيع.png';
  });
  // As EmbedPDF's page tools do: a hidden input in its shadow root, an
  // `onchange` set as a property, then `click()`.
  const got = await page.evaluate(
    () =>
      new Promise<{ name: string; type: string; bytes: number[] }>((resolve) => {
        const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
        const input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        root.append(input);
        input.accept = 'image/png,image/jpeg';
        input.onchange = async (event) => {
          const file = (event.target as HTMLInputElement).files?.[0];
          if (file)
            resolve({
              name: file.name,
              type: file.type,
              bytes: [...new Uint8Array(await file.arrayBuffer())],
            });
          input.value = '';
        };
        input.click();
      }),
  );
  expect(got).toEqual({
    name: 'توقيع.png',
    type: 'image/png',
    bytes: [0x89, 0x50, 0x4e, 0x47, 1, 2, 3],
  });
  const open = (await calls(page)).find((c) => c.cmd === 'plugin:dialog|open');
  expect(open?.args).toEqual({
    options: {
      multiple: false,
      directory: false,
      filters: [{ name: 'png, jpg, jpeg', extensions: ['png', 'jpg', 'jpeg'] }],
    },
  });
});

test('a person’s click on a file input, or on its label, opens the native panel', async ({
  page,
}) => {
  await desktopPage(page);
  await page.evaluate(() => {
    const w = window as unknown as { pick: string[]; changes: string[] };
    w.pick = ['/Users/me/توقيع.png'];
    w.changes = [];
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<label id="label">Upload <input id="direct" type="file" accept="image/*"></label>';
    root.getElementById('direct')!.addEventListener('change', (event) => {
      w.changes.push((event.target as HTMLInputElement).files?.[0]?.name ?? '');
    });
  });
  // No browser file chooser may open: the bridge answers the click itself.
  let choosers = 0;
  page.on('filechooser', () => {
    choosers += 1;
  });
  await page.locator('#direct').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { changes: string[] }).changes))
    .toEqual(['توقيع.png']);
  await page.locator('#label').click({ position: { x: 4, y: 4 } });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { changes: string[] }).changes))
    .toEqual(['توقيع.png', 'توقيع.png']);
  expect(choosers).toBe(0);
});

test('cancelling the native panel changes nothing', async ({ page }) => {
  await desktopPage(page);
  const outcome = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.addEventListener('change', () => resolve('change'));
        input.addEventListener('cancel', () =>
          resolve(`cancel, ${input.files?.length ?? 0} files`),
        );
        input.click();
      }),
  );
  expect(outcome).toBe('cancel, 0 files');
});

test('a download whose blob: URL is revoked at once is still saved through the save panel', async ({
  page,
}) => {
  await desktopPage(page);
  // As EmbedPDF's capture and stamp export do: a detached link, clicked, and
  // its URL revoked straight after.
  await page.evaluate(() => {
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([new Uint8Array([7, 8, 9])], { type: 'image/png' }));
    link.href = url;
    link.download = 'pdf-capture-page-1.png';
    link.click();
    URL.revokeObjectURL(url);
  });
  await expect
    .poll(async () => (await calls(page)).map((c) => c.cmd))
    .toEqual(['plugin:dialog|save', 'save_file']);
  const [save, write] = await calls(page);
  expect(save?.args).toEqual({
    options: {
      defaultPath: 'pdf-capture-page-1.png',
      filters: [{ name: 'PNG', extensions: ['png'] }],
    },
  });
  expect(write?.args).toEqual([7, 8, 9]);
  expect(write?.headers).toEqual({ 'x-warraq-path': encodeURIComponent('/Users/me/حفظ.png') });
});

test('a data: URL download is saved too, and a cancelled save writes nothing', async ({ page }) => {
  await desktopPage(page);
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = 'data:text/plain;base64,2YjYsdin2YI=';
    link.download = 'notes.txt';
    link.click();
  });
  await expect.poll(async () => (await calls(page)).length).toBe(2);
  expect((await calls(page))[1]?.args).toEqual([...new TextEncoder().encode('وراق')]);

  await page.evaluate(() => {
    (window as unknown as { savePath: null; calls: unknown[] }).savePath = null;
    (window as unknown as { calls: unknown[] }).calls.length = 0;
    const link = document.createElement('a');
    link.href = 'data:text/plain,x';
    link.download = 'x.txt';
    link.click();
  });
  await expect
    .poll(async () => (await calls(page)).map((c) => c.cmd))
    .toEqual(['plugin:dialog|save']);
});

test('links without download, and other inputs, behave as they always do; uninstalling restores them', async ({
  page,
}) => {
  await desktopPage(page);
  const result = await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = '#section';
    document.body.append(link);
    link.click();
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.click();
    const w = window as unknown as { uninstall: () => void };
    const patched = HTMLInputElement.prototype.click !== HTMLElement.prototype.click;
    w.uninstall();
    return {
      hash: location.hash,
      checked: box.checked,
      patched,
      restored: HTMLInputElement.prototype.click === HTMLElement.prototype.click,
    };
  });
  expect(result).toEqual({ hash: '#section', checked: true, patched: true, restored: true });
  expect(await calls(page)).toEqual([]);
});
