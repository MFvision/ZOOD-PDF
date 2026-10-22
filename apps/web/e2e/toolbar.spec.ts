import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { corpus, enterEditText, openPdf, test } from './helpers';

/**
 * The toolbar's toggles say what is on. A review found the sidebar button's
 * pressed look stuck after every click in the page view (it read EmbedPDF's
 * state once, when the toolbar drew), showing the state before the click in
 * Edit text, and Find there shown pressed but impossible to press off.
 */

const THREE_PAGES = corpus('generated/chrome-notonaskh-justified-3pages.pdf');

const button = (page: Page, name: string) => page.getByRole('toolbar').getByRole('button', { name, exact: true });

/** Whether one of EmbedPDF's toggles is on, asked of EmbedPDF itself. */
const embedOn = (page: Page, command: string) =>
  page.evaluate(async (id) => {
    type Registry = { getPlugin(id: string): { provides(): { resolve(id: string): { active: boolean } } } };
    const registry = await (document.querySelector('embedpdf-container') as unknown as { registry: Promise<Registry> }).registry;
    return registry.getPlugin('commands').provides().resolve(id).active;
  }, command);

test('in the page view, the sidebar and Find buttons are pressed exactly while EmbedPDF’s sidebar and search are open', async ({
  page,
  stayLocal: _,
}) => {
  await page.goto('/');
  await openPdf(page, THREE_PAGES);
  for (const [name, command] of [
    ['Pages panel', 'panel:toggle-sidebar'],
    ['Find', 'panel:toggle-search'],
  ] as const) {
    for (let click = 0; click < 2; click += 1) {
      await button(page, name).click();
      const on = await embedOn(page, command);
      await expect(button(page, name), `${name}, click ${click + 1}`).toHaveAttribute('aria-pressed', String(on));
    }
  }
});

test('in Edit text, the sidebar button shows the pane as it is, and Find opens and closes the find bar', async ({
  page,
  stayLocal: _,
}) => {
  await page.goto('/');
  await openPdf(page, THREE_PAGES);
  await enterEditText(page);
  // A zoom of its own, so nothing else redraws the toolbar after a click.
  await button(page, 'Zoom in').click();
  const pane = page.locator('.pane-start');
  for (let click = 0; click < 2; click += 1) {
    await button(page, 'Pages panel').click();
    const open = await pane.isVisible();
    await expect(button(page, 'Pages panel'), `click ${click + 1}`).toHaveAttribute('aria-pressed', String(open));
  }

  await button(page, 'Find').click();
  await expect(page.locator('.findbar')).toBeVisible();
  await expect(button(page, 'Find')).toHaveAttribute('aria-pressed', 'true');
  await button(page, 'Find').click();
  await expect(page.locator('.findbar')).toBeHidden();
  await expect(button(page, 'Find')).toHaveAttribute('aria-pressed', 'false');
});
