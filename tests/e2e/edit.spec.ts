/**
 * The Edit tool through the real interface (English and Arabic): open from the Home "Edit" card,
 * edit an Arabic sentence (with tashkeel) in place, add a text box, move and delete a picture, add a
 * link (and see a bidi-spoofed address refused), open a link only through the confirm sheet,
 * undo/redo, save, then inspect the saved bytes with the engine (wasm in Node) and reopen them in
 * the app. The original file must be an exact byte prefix of the saved one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ENGINE_BUILT, ROOT, fixture, fixtureBytes, openViaCard, pageBox, pickTool, savedFiles, stubSavePicker, trackExternalRequests, waitForDocument } from './helpers';

type Wasm = {
  initSync(o: { module: Buffer }): void;
  WarraqDocument: { open(bytes: Uint8Array, password?: string): { call(m: string, p: string, b: Uint8Array[]): { json: string; blobs: Uint8Array[] } } };
};

let wasm: Wasm | null = null;
async function engine(): Promise<Wasm> {
  if (wasm) return wasm;
  const pkg = path.join(ROOT, 'packages/ui/src/wasm/pkg');
  const w = (await import(pathToFileURL(path.join(pkg, 'warraq_core.js')).href)) as Wasm;
  w.initSync({ module: fs.readFileSync(path.join(pkg, 'warraq_core_bg.wasm')) });
  wasm = w;
  return w;
}

async function inspect(bytes: Buffer) {
  const w = await engine();
  const doc = w.WarraqDocument.open(new Uint8Array(bytes));
  const call = (m: string, p: unknown = {}) => JSON.parse(doc.call(m, JSON.stringify(p), []).json);
  return {
    text: call('text.plain').text as string,
    images: (call('edit.images', { page: 0 }).images as unknown[]).length,
    links: call('edit.links', { page: 0 }).links as { uri?: string }[],
    revisions: call('doc.revisions').revisions.length as number,
  };
}

const NEW_SENTENCE = 'هذه جملةٌ جديدةٌ مُعدَّلة بالكامل.';
const ORIGINAL_SENTENCE = 'هذه الجملة الأولى سيتم تعديلها في اختبار التحرير.';

const LOCALES = [
  { locale: 'en', browser: 'en-US', added: 'Added by ZOOD', edited: /Edited/, saved: /Saved/ },
  { locale: 'ar', browser: 'ar-SA', added: 'نص مضاف من زود', edited: /معدَّل/, saved: /حُفظ/ },
] as const;

const surface = (page: Page) => page.locator('[data-testid=edit-surface]');

/** Waits until the engine applied the edit and the viewer reloaded. */
async function settled(page: Page) {
  await expect(surface(page)).toHaveAttribute('data-busy', 'false', { timeout: 30_000 });
  await expect(page.locator('[data-testid=document-view]:visible .viewer-loading')).toHaveCount(0, { timeout: 30_000 });
}

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}

for (const L of LOCALES) {
  test.describe(`edit tool (${L.locale})`, () => {
    test.use({ locale: L.browser });
    test.skip(!ENGINE_BUILT, 'needs the warraq-core engine');

    test('edit Arabic text, add text, move and delete a picture, links, undo/redo, save and reopen', async ({ context, page }) => {
      test.setTimeout(180_000);
      await stubSavePicker(context);
      const external = trackExternalRequests(page);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', L.locale);

      // Home "Edit" card: choose a file, the Edit tool opens on it.
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-card=edit]').click()]);
      await chooser.setFiles(fixture('edit-ar.pdf'));
      await waitForDocument(page);
      await expect(surface(page)).toBeVisible();
      await settled(page);

      // 1. Edit the Arabic sentence in place (text area over the block, dir=auto).
      const block = page.locator(`[data-testid=edit-block][data-text="${ORIGINAL_SENTENCE}"]`);
      await expect(block).toHaveAttribute('data-editable', 'true');
      await block.click();
      const area = page.locator('[data-testid=edit-textarea]');
      await expect(area).toHaveAttribute('dir', 'auto');
      await expect(area).toHaveValue(ORIGINAL_SENTENCE);
      await area.fill(NEW_SENTENCE);
      await page.locator('[data-testid=edit-apply]').click();
      await settled(page);
      await expect(page.locator(`[data-testid=edit-block][data-text="${NEW_SENTENCE}"]`)).toHaveCount(1);
      await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toContainText(L.edited);

      // 2. Add a text box near the bottom of the page.
      const pageEl = page.locator('[data-testid=edit-page]');
      const pb = (await pageEl.boundingBox())!;
      await page.locator('[data-testid=edit-mode-addText]').click();
      // An empty area beside the picture (the page is taller than the window: stay in view).
      await page.mouse.click(pb.x + pb.width * 0.12, pb.y + pb.height * 0.3);
      await page.locator('[data-testid=new-text-input]').fill(L.added);
      await page.locator('[data-testid=new-text-apply]').click();
      await settled(page);
      await expect(page.locator(`[data-testid=edit-block][data-text="${L.added}"]`)).toHaveCount(1);

      // 3. Picture: select, nudge with the keyboard, drag, then delete.
      const img = page.locator('[data-testid=edit-image]').first();
      await expect(page.locator('[data-testid=edit-image]')).toHaveCount(1);
      const before = await center(img);
      await img.click();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Shift+ArrowDown');
      await expect.poll(async () => (await center(page.locator('[data-testid=edit-image]').first())).y - before.y, { timeout: 30_000 }).toBeGreaterThan(5);
      await settled(page);
      const nudged = await center(page.locator('[data-testid=edit-image]').first());
      await page.mouse.move(nudged.x, nudged.y);
      await page.mouse.down();
      await page.mouse.move(nudged.x - 40, nudged.y + 30, { steps: 8 });
      await page.mouse.up();
      await settled(page);
      const moved = await center(page.locator('[data-testid=edit-image]').first());
      expect(moved.x).toBeLessThan(nudged.x - 20);
      await page.locator('[data-testid=edit-image]').first().click();
      await page.locator('[data-testid=image-delete]').click();
      await settled(page);
      await expect(page.locator('[data-testid=edit-image]')).toHaveCount(0);

      // 4. Links: a bidi-spoofed address is refused; a normal one is added over the English line.
      const en = page.locator('[data-testid=edit-block][data-text^="Visit the ZOOD PDF"]');
      const eb = (await en.boundingBox())!;
      const draw = async () => {
        await page.locator('[data-testid=edit-mode-addLink]').click();
        await page.mouse.move(eb.x + 2, eb.y + 1);
        await page.mouse.down();
        await page.mouse.move(eb.x + eb.width * 0.5, eb.y + eb.height - 1, { steps: 6 });
        await page.mouse.up();
        await expect(page.locator('[data-testid=link-edit]')).toBeVisible();
      };
      await draw();
      await page.locator('[data-testid=link-uri]').fill('https://zood.sa/‮fdp.exe');
      await expect(page.locator('[data-testid=link-problems] [data-problem=bidi_controls]')).toBeVisible();
      await expect(page.locator('[data-testid=link-save]')).toBeDisabled();
      await page.locator('[data-testid=link-uri]').fill('https://xn--pple-43d.com/login');
      await expect(page.locator('[data-testid=link-host]')).toHaveText('аpple.com');
      await expect(page.locator('[data-testid=link-problems] [data-problem=mixed_script]')).toBeVisible();
      await expect(page.locator('[data-testid=link-save]')).toBeDisabled();
      await page.locator('[data-testid=link-uri]').fill('https://zood.sa/docs');
      await expect(page.locator('[data-testid=link-host]')).toHaveText('zood.sa');
      await page.locator('[data-testid=link-save]').click();
      await settled(page);
      await expect(page.locator('[data-testid=edit-link]')).toHaveCount(1);
      await expect(page.locator('[data-testid=edit-link]')).toHaveAttribute('data-uri', 'https://zood.sa/docs');

      // Opening goes through the confirm sheet with the full address and the host shown.
      await page.locator('[data-testid=edit-link]').click();
      await page.locator('[data-testid=link-bar-open]').click();
      await expect(page.locator('[data-testid=link-confirm]')).toHaveAttribute('data-verdict', 'ok');
      await expect(page.locator('[data-testid=link-host]')).toHaveText('zood.sa');
      await expect(page.locator('[data-testid=link-url]')).toHaveText('https://zood.sa/docs');
      await page.locator('[data-testid=link-cancel]').click();

      // 5. Undo/redo: toolbar and keyboard walk the engine versions.
      await page.locator('[data-testid=edit-undo]').click();
      await settled(page);
      await expect(page.locator('[data-testid=edit-link]')).toHaveCount(0);
      await page.locator('[data-testid=edit-redo]').click();
      await settled(page);
      await expect(page.locator('[data-testid=edit-link]')).toHaveCount(1);
      await page.locator('[data-testid=edit-page]').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('ControlOrMeta+z');
      await settled(page);
      await expect(page.locator('[data-testid=edit-link]')).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await settled(page);
      await expect(page.locator('[data-testid=edit-link]')).toHaveCount(1);

      // 6. Leave the Edit tool: a click on the link in the viewer asks before opening.
      await page.locator('[data-testid=edit-done]').click();
      await expect(surface(page)).toHaveCount(0);
      const vb = await pageBox(page, 0);
      const fx = (eb.x + 10 - pb.x) / pb.width;
      const fy = (eb.y + eb.height / 2 - pb.y) / pb.height;
      const popups: string[] = [];
      page.on('popup', (p) => popups.push(p.url()));
      await page.mouse.click(vb.x + vb.width * fx, vb.y + vb.height * fy);
      // EmbedPDF selects the link and offers "Go to Link"; following it asks us first.
      await page.getByText(/^(Go to Link|الانتقال إلى الرابط)$/).locator('visible=true').first().click();
      await expect(page.locator('[data-testid=link-confirm]')).toBeVisible();
      await expect(page.locator('[data-testid=link-host]')).toHaveText('zood.sa');
      await page.locator('[data-testid=link-cancel]').click();
      expect(popups).toEqual([]);

      // 7. Save: an incremental update of the original bytes.
      await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
      await expect(page.locator('.hud')).toContainText(L.saved);
      const [saved] = await savedFiles(page);
      const original = fixtureBytes('edit-ar.pdf');
      expect(saved!.bytes.subarray(0, original.length).equals(original)).toBe(true);
      expect(saved!.bytes.length).toBeGreaterThan(original.length);
      const info = await inspect(saved!.bytes);
      expect(info.text).toContain(NEW_SENTENCE);
      expect(info.text).not.toContain(ORIGINAL_SENTENCE);
      expect(info.text).toContain(L.added);
      expect(info.text).toContain('الفقرة الثانية تبقى كما هي دون أي تغيير.');
      expect(info.images).toBe(0);
      expect(info.links.map((l) => l.uri)).toEqual(['https://zood.sa/docs']);
      expect(info.revisions).toBeGreaterThan(2);
      expect(saved!.bytes.toString('latin1')).not.toContain('/Direction');

      // 8. Reopen the saved file in the app: the edited sentence is there.
      await page.locator('[data-testid=document-view]:visible .doc-toolbar .icon-btn').first().click();
      await openViaCard(page, { name: 'edited.pdf', mimeType: 'application/pdf', buffer: saved!.bytes });
      await pickTool(page, 'edit');
      await expect(surface(page)).toBeVisible();
      await settled(page);
      await expect(page.locator(`[data-testid=edit-block][data-text="${NEW_SENTENCE}"]`)).toHaveCount(1);
      expect(external).toEqual([]);
    });

    test('an edit on page 2 keeps the viewer on page 2', async ({ page }) => {
      await page.goto('/');
      await openViaCard(page, fixture('sample-ar.pdf'));
      const status = page.locator('[data-testid=document-view]:visible [data-testid=doc-status]');
      await page.locator('[data-testid=document-view]:visible .tb-nav .icon-btn').nth(1).click();
      await expect(status).toContainText(/(Page 2 of 2|صفحة ٢ من ٢)/);
      await pickTool(page, 'edit');
      await settled(page);
      await expect(page.locator('[data-testid=edit-page-label]')).toContainText(/(2|٢)/);
      const block = page.locator('[data-testid=edit-block][data-text^="تُستخدم هذه الصفحة"]');
      await block.click();
      await page.locator('[data-testid=edit-textarea]').fill('صفحة ثانية مُعدَّلة.');
      await page.locator('[data-testid=edit-apply]').click();
      await settled(page);
      await expect(page.locator('[data-testid=edit-block][data-text="صفحة ثانية مُعدَّلة."]')).toHaveCount(1);
      await page.locator('[data-testid=edit-done]').click();
      await expect(status).toContainText(/(Page 2 of 2|صفحة ٢ من ٢)/);
    });
  });
}
