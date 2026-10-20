import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  INVOICE,
  WORD_EXPORT,
  annotationTypes,
  chooseTool,
  corpus,
  documentStatus,
  embedDocument,
  embedPage,
  embedZoom,
  enterEditText,
  openPdf,
  pageBox,
  test,
  useAction,
} from './helpers';

const THREE_PAGES = corpus('generated/chrome-notonaskh-justified-3pages.pdf');

const menu = (page: Page, name: string) =>
  page.getByRole('menubar').getByRole('menuitem', { name, exact: true });
const statusBar = (page: Page) => documentStatus(page);

// Warraq's menus, shortcuts and status bar once drove only its own viewer, and
// did nothing visible while EmbedPDF showed the page. These prove they reach it.
test.describe('the menus act on the page on screen', () => {
  test('Go to page and Zoom in move the view, and the status bar follows it', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, THREE_PAGES);
    await expect(statusBar(page)).toContainText('Page 1 of 3');

    await menu(page, 'Edit').click();
    await page.getByRole('menuitem', { name: 'Go to page…' }).click();
    await page.getByLabel('Page number (1–3)').fill('3');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect.poll(() => embedPage(page)).toBe(3);
    await expect(statusBar(page)).toContainText('Page 3 of 3');

    const before = await embedZoom(page);
    await menu(page, 'View').click();
    await page.getByRole('menuitem', { name: 'Zoom in' }).click();
    await expect.poll(() => embedZoom(page)).toBeGreaterThan(before);
  });

  test('Cmd/Ctrl+O opens the file in Warraq, not in EmbedPDF behind its back', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, THREE_PAGES);
    // With the focus in the view, where EmbedPDF's own Open used to take the key.
    const box = await pageBox(page);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.keyboard.press('ControlOrMeta+O'),
    ]);
    await chooser.setFiles(INVOICE);
    await expect(statusBar(page)).toContainText('Page 1 of 1');
  });

  test('Edit → Undo takes back a drawing', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Comment');
    await useAction(page, 'Draw');
    const box = await pageBox(page);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 15 });
    await page.mouse.up();
    await expect.poll(() => annotationTypes(page)).toContain(15);

    await menu(page, 'Edit').click();
    // Its name carries the shortcut: "Undo ⌘+Z".
    await page.getByRole('menuitem', { name: /^Undo/ }).click();
    await expect.poll(() => annotationTypes(page)).not.toContain(15);
  });

  test('while editing text, Cmd/Ctrl+Z undoes the edit on screen, not a hidden drawing', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await chooseTool(page, 'Comment');
    await useAction(page, 'Draw');
    const box = await pageBox(page);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 15 });
    await page.mouse.up();
    await expect.poll(() => annotationTypes(page)).toContain(15);

    // EmbedPDF stays mounted under the editor; its Cmd+Z used to win.
    const before = await embedDocument(page);
    const first = await enterEditText(page);
    await first.locator('.edit-box').first().click();
    const area = first.locator('.paragraph-editor-area');
    const replacement = 'تعديل سيتراجع عنه الاختبار';
    await area.fill(replacement);
    await area.press('ControlOrMeta+Enter');
    await expect(first.locator('.text-layer')).toContainText(replacement);
    await page.keyboard.press('ControlOrMeta+Z');
    await expect(first.locator('.text-layer')).not.toContainText(replacement);

    await page.getByRole('toolbar').getByRole('button', { name: 'Edit text' }).click();
    // Handed back and reopened — a new document — with the drawing in it.
    await expect.poll(async () => (await embedDocument(page)).id).not.toBe(before.id);
    await expect.poll(() => annotationTypes(page)).toContain(15);
  });

  test('the page view follows the theme chosen in the View menu, without a reload', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, THREE_PAGES);
    const preference = () =>
      page.evaluate(
        () =>
          (
            document.querySelector('embedpdf-container') as unknown as {
              themePreference: string;
            } | null
          )?.themePreference,
      );
    for (const theme of ['Dark', 'Light', 'System']) {
      await menu(page, 'View').click();
      await page.getByRole('menuitemradio', { name: `Appearance: ${theme}` }).click();
      await expect.poll(preference).toBe(theme.toLowerCase());
    }
  });

  test('Settings and the View menu change the theme, and it is kept', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    const look = () => page.evaluate(() => document.documentElement.dataset.look ?? 'glass');
    const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    const settings = page.getByRole('dialog', { name: 'Settings' });
    // Once the app is listening for its keys.
    await expect(async () => {
      await page.keyboard.press('Control+,');
      await expect(settings).toBeVisible({ timeout: 1000 });
    }).toPass();
    await settings.getByRole('navigation').getByRole('button', { name: 'Appearance', exact: true }).click();
    await settings.getByRole('radiogroup', { name: 'Look' }).getByRole('radio', { name: /^Zood/ }).click();
    await expect.poll(look).toBe('zood');
    await expect.poll(accent).toBe('#73563a');
    await page.keyboard.press('Escape');
    await menu(page, 'View').click();
    await page.getByRole('menuitemradio', { name: 'Look: Workbench' }).click();
    await expect.poll(accent).toBe('#1b63e0');
    await page.reload();
    await expect.poll(look).toBe('workbench');
  });
});
