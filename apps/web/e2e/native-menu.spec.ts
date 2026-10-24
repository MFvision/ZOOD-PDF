import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, WORD_EXPORT, annotationTypes, chooseTool, corpus, enterEditText, openPdf, pageBox, test, useAction } from './helpers';

/**
 * The macOS app's menu bar, which the page builds from its menu model and
 * hands to the host (`useNativeMenu`, `apps/desktop/src-tauri/src/menu.rs`).
 * The system's menu bar cannot be driven from a browser, so the host is
 * played by a stand-in put in once the app has booted (the core stays the
 * WebAssembly one): it keeps every menu the page sends, and delivers items
 * "chosen" in it exactly as the host's `warraq://menu` event does.
 *
 * A review found the checks on Fit width, Fit page and the navigation pane
 * going stale there, and Undo unable to reach the typing in a text field.
 */

const THREE_PAGES = corpus('generated/chrome-notonaskh-justified-3pages.pdf');

interface Item {
  id: string;
  enabled: boolean;
  checked?: boolean;
}

async function becomeMacApp(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
  });
  await page.goto('/');
  await expect(page.locator('.shell')).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const callbacks = new Map<number, (payload: unknown) => void>();
    const listening = new Map<string, number>();
    let next = 1;
    const menus: unknown[] = [];
    w.__menus = menus;
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (payload: unknown) => void) => {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: (cmd: string, args: { spec?: unknown; event?: string; handler?: number }) => {
        if (cmd === 'set_menu') {
          menus.push(args.spec);
          return Promise.resolve(null);
        }
        if (cmd === 'plugin:event|listen') {
          listening.set(args.event ?? '', args.handler ?? 0);
          return Promise.resolve(next++);
        }
        if (cmd === 'plugin:event|unlisten') return Promise.resolve(null);
        return Promise.reject(new Error(`not played by this stand-in: ${cmd}`));
      },
    };
    w.__choose = (id: string) => callbacks.get(listening.get('warraq://menu') ?? 0)?.({ event: 'warraq://menu', payload: id });
  });
}

/** The item as the host was last told it: enabled, checked. */
async function item(page: Page, id: string): Promise<Item | undefined> {
  return page.evaluate((wanted) => {
    const menus = (window as unknown as { __menus: { menus: { items: Item[] }[] }[] }).__menus;
    return menus.at(-1)?.menus.flatMap((menu) => menu.items).find((entry) => entry.id === wanted);
  }, id);
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as { __menus: unknown[] }).__menus.length);

/** An item chosen in the system's menu bar. */
async function choose(page: Page, id: string) {
  await page.evaluate((chosen) => (window as unknown as { __choose: (id: string) => void }).__choose(chosen), id);
}

/** Past the window in which a menu event echoing a key the page handled is dropped (shortcutEcho.ts). */
const afterEcho = (page: Page) => page.waitForTimeout(600);

test('About in the app menu opens the About sheet: the app version and what the desktop app does, never a browser preview', async ({ page, stayLocal: _ }) => {
  await becomeMacApp(page);
  await openPdf(page, INVOICE);
  await expect.poll(async () => (await item(page, 'about'))?.enabled).toBe(true);
  await choose(page, 'about');
  const about = page.getByRole('dialog', { name: /About/ });
  await expect(about).toBeVisible();
  await expect(about).toContainText(/Version \d+\.\d+\.\d+/);
  await expect(about).toContainText('complete PDF studio for your computer');
  await expect(about).not.toContainText(/browser|Phase 1|Core \d/);
});

test('the checks on Fit width, Fit page and the navigation pane follow the view, whatever changed it', async ({
  page,
  stayLocal: _,
}) => {
  await becomeMacApp(page);
  await openPdf(page, THREE_PAGES);
  await page.keyboard.press('ControlOrMeta+0');
  await expect.poll(async () => (await item(page, 'fit-page'))?.checked).toBe(true);
  expect((await item(page, 'fit-width'))?.checked).toBe(false);
  await page.keyboard.press('ControlOrMeta+1');
  await expect.poll(async () => (await item(page, 'fit-width'))?.checked).toBe(true);
  expect((await item(page, 'fit-page'))?.checked).toBe(false);

  // The toolbar's sidebar button runs EmbedPDF's own toggle; its pressed look and the menu's check follow it.
  const sidebar = page.getByRole('toolbar').getByRole('button', { name: 'Pages panel' });
  const before = (await sidebar.getAttribute('aria-pressed')) === 'true';
  await sidebar.click();
  await expect(sidebar).toHaveAttribute('aria-pressed', String(!before));
  await expect.poll(async () => (await item(page, 'left-pane'))?.checked).toBe(!before);
  await page.keyboard.press('F4');
  await expect(sidebar).toHaveAttribute('aria-pressed', String(before));
  await expect.poll(async () => (await item(page, 'left-pane'))?.checked).toBe(before);
});

test('an item chosen in the menu bar is answered with the model again, so a check the system flipped is put right', async ({
  page,
  stayLocal: _,
}) => {
  await becomeMacApp(page);
  await openPdf(page, THREE_PAGES);
  await page.keyboard.press('ControlOrMeta+1');
  await expect.poll(async () => (await item(page, 'fit-width'))?.checked).toBe(true);
  await afterEcho(page);
  // Choosing a checked item makes the system uncheck it; the view stays at fit width.
  const count = await sent(page);
  await choose(page, 'fit-width');
  await expect.poll(() => sent(page)).toBeGreaterThan(count);
  expect((await item(page, 'fit-width'))?.checked).toBe(true);
});

test('Undo in the menu bar undoes the typing in a text field, even with nothing in the document to undo', async ({
  page,
  stayLocal: _,
}) => {
  await becomeMacApp(page);
  await openPdf(page, THREE_PAGES);
  await expect.poll(async () => (await item(page, 'undo'))?.enabled).toBe(false);
  await page.keyboard.press('ControlOrMeta+Shift+N');
  const field = page.getByLabel('Page number (1–3)');
  await expect(field).toBeFocused();
  await page.keyboard.type('3');
  await expect(field).toHaveValue('3');
  await expect.poll(async () => (await item(page, 'undo'))?.enabled).toBe(true);
  await choose(page, 'undo');
  await expect(field).toHaveValue('1');
  await choose(page, 'redo');
  await expect(field).toHaveValue('3');
});

test('Undo in the menu bar undoes the typing in EmbedPDF’s own search field, not the last drawing', async ({
  page,
  stayLocal: _,
}) => {
  await becomeMacApp(page);
  await openPdf(page, INVOICE);
  await chooseTool(page, 'Comment');
  await useAction(page, 'Draw');
  const box = await pageBox(page);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => annotationTypes(page)).toContain(15);
  await page.keyboard.press('Escape');

  await page.keyboard.press('ControlOrMeta+f');
  const search = page.locator('embedpdf-container [data-sidebar-id="search-panel"]').getByPlaceholder('Search');
  await expect(search).toBeVisible();
  await search.click();
  // One key: one step of the field's history (how the browser groups keys is its own).
  await page.keyboard.type('x');
  await expect(search).toHaveValue('x');
  await expect.poll(async () => (await item(page, 'undo'))?.enabled).toBe(true);
  await choose(page, 'undo');
  await expect(search).toHaveValue('');
  expect(await annotationTypes(page)).toContain(15);
});

test('in the paragraph editor, ⌘Z undoes the typing and is handled by the page, so the menu never sees it', async ({
  page,
  stayLocal: _,
}) => {
  await becomeMacApp(page);
  await openPdf(page, WORD_EXPORT);
  const first = await enterEditText(page);
  await first.locator('.edit-box').first().click();
  const area = first.locator('.paragraph-editor-area');
  const before = await area.inputValue();
  // As WebKit asks: a key equivalent goes to the menu bar unless the page prevented its default.
  await page.evaluate(() => {
    const w = window as unknown as { __handled: boolean[] };
    w.__handled = [];
    window.addEventListener(
      'keydown',
      (event) => {
        if ((event.metaKey || event.ctrlKey) && event.code === 'KeyZ') setTimeout(() => w.__handled.push(event.defaultPrevented), 0);
      },
      true,
    );
  });
  await area.press('End');
  // One key: one step of the field's history (how the browser groups keys is its own).
  await page.keyboard.type('x');
  await expect(area).toHaveValue(`${before}x`);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(area).toHaveValue(before);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __handled: boolean[] }).__handled)).toEqual([true]);
});
