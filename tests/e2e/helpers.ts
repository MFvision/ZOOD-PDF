import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const FIXTURES = path.join(ROOT, 'tests/fixtures');
export const fixture = (name: string) => path.join(FIXTURES, name);
export const fixtureBytes = (name: string) => fs.readFileSync(fixture(name));

/** True when this build contains the real warraq-core engine (then saves must be incremental). */
export const ENGINE_BUILT = fs.existsSync(path.join(ROOT, 'packages/ui/src/wasm/pkg/warraq_core.js'));

/** Records every request that leaves the local server (the app must make none). */
export function trackExternalRequests(page: Page): string[] {
  const external: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (/^(blob|data|about|chrome-extension):/.test(url)) return;
    const u = new URL(url);
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') external.push(url);
  });
  return external;
}

/** Replaces the File System Access save picker with one that records the written bytes. */
export async function stubSavePicker(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __saved: { name: string; bytes: number[] }[]; showSaveFilePicker: unknown };
    w.__saved = [];
    w.showSaveFilePicker = async (opts: { suggestedName: string }) => ({
      name: opts.suggestedName,
      createWritable: async () => {
        const chunks: number[] = [];
        return {
          // A loop, not push(...bytes): spreading a large file overflows the call stack.
          write: async (b: Uint8Array) => {
            for (const x of new Uint8Array(b)) chunks.push(x);
          },
          close: async () => void w.__saved.push({ name: opts.suggestedName, bytes: chunks }),
        };
      },
    });
  });
}

export async function savedFiles(page: Page): Promise<{ name: string; bytes: Buffer }[]> {
  const raw = await page.evaluate(() => (window as unknown as { __saved: { name: string; bytes: number[] }[] }).__saved);
  return raw.map((r) => ({ name: r.name, bytes: Buffer.from(r.bytes) }));
}

/** Opens a PDF through the Open action card and the native file chooser. */
export async function openViaCard(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-card=open]').click()]);
  await chooser.setFiles(file);
  await waitForDocument(page);
}

export async function waitForDocument(page: Page): Promise<void> {
  const view = page.locator('[data-testid=document-view]:visible');
  await expect(view).toBeVisible();
  await expect(view.locator('.viewer-loading')).toHaveCount(0, { timeout: 30_000 });
  await expect(view.locator('[data-testid=doc-status]')).toHaveText(/(Page|صفحة) \S+ (of|من) \S+/);
}

/** Bounding box of a rendered page inside EmbedPDF's (open) shadow root. */
export async function pageBox(page: Page, index = 0): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const root = document.querySelector('[data-testid=document-view]:not([hidden]) embedpdf-container')?.shadowRoot;
        return root ? root.querySelectorAll('img').length : 0;
      }),
    )
    .toBeGreaterThan(0);
  return page.evaluate((i) => {
    const root = document.querySelector('[data-testid=document-view]:not([hidden]) embedpdf-container')!.shadowRoot!;
    const pages = [...root.querySelectorAll('img')]
      .map((img) => img.getBoundingClientRect())
      .filter((r) => r.height > r.width * 1.2)
      .sort((a, b) => a.y - b.y);
    const seen: DOMRect[] = [];
    for (const r of pages) if (!seen.some((s) => Math.abs(s.y - r.y) < 5)) seen.push(r);
    const r = seen[i]!;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, index);
}

export async function pickTool(page: Page, tool: string): Promise<void> {
  await page.locator('[data-testid=document-view]:visible [data-testid=tool-picker]').click();
  await page.locator(`[data-testid=tool-gallery] [data-tool=${tool}]`).click();
}

/** Highlights a line of the fixture with EmbedPDF's highlight tool (drag over the text). The default is
 * the second paragraph; 0.166 is the first one. */
export async function highlightSecondParagraph(page: Page, yFraction = 0.206): Promise<void> {
  await pickTool(page, 'comment');
  await page.locator('[data-epdf-i=add-highlight]').click();
  const box = await pageBox(page, 0);
  const y = box.y + box.height * yFraction;
  await page.mouse.move(box.x + box.width * 0.13, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, y, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toContainText(/Edited|معدَّل/);
}

export function writeTemp(name: string, bytes: Buffer): string {
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, 'test-results', 'tmp-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

export function latin1(b: Buffer): string {
  return b.toString('latin1');
}
