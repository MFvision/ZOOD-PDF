import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, openPdf, test } from './helpers';

/**
 * At phone width. A review found three things there: the markup toolbar had
 * no way to be shown (its only button is one a phone's toolbar has no room
 * for, and no menu had it), View › Tools pane changed a check and showed
 * nothing while no tool was chosen, and the inspector sheet showed a grabber
 * that could not be dragged.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const viewMenu = async (page: Page) => {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).tap();
  return page.getByRole('menu', { name: 'View' });
};

async function chooseToolFromPicker(page: Page, name: string) {
  await page.getByRole('toolbar').getByRole('button', { name: /^Choose a tool/ }).tap();
  await page.getByRole('dialog', { name: 'All tools' }).getByRole('radio', { name }).tap();
  await expect(page.locator('.pane-end').getByRole('heading', { name })).toBeVisible();
}

test('the markup toolbar, which a phone’s toolbar has no room for, is shown from the View menu', async ({
  page,
  stayLocal: _,
}) => {
  await page.goto('/');
  await openPdf(page, INVOICE);
  await expect(page.getByRole('toolbar').getByRole('button', { name: 'Markup toolbar' })).toBeHidden();
  const modes = page.locator('embedpdf-container').getByRole('tablist');
  await expect(modes).toBeHidden();

  const item = (await viewMenu(page)).getByRole('menuitemcheckbox', { name: 'Markup toolbar' });
  await expect(item).toHaveAttribute('aria-checked', 'false');
  await item.tap();
  await expect(modes).toBeVisible();
  await expect((await viewMenu(page)).getByRole('menuitemcheckbox', { name: 'Markup toolbar' })).toHaveAttribute('aria-checked', 'true');
});

test('Tools pane is offered only when there is a sheet to show: a chosen tool’s', async ({ page, stayLocal: _ }) => {
  await page.goto('/');
  await openPdf(page, INVOICE);
  const toolsPane = async () => (await viewMenu(page)).getByRole('menuitemcheckbox', { name: /^Tools pane/ });
  await expect(await toolsPane()).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  await chooseToolFromPicker(page, 'Compress');
  const item = await toolsPane();
  await expect(item).not.toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await item.tap();
  await expect(page.locator('.pane-end')).toHaveCount(0);
});

/** The sheet's offset from where it rests, as drawn. */
const offset = (page: Page) =>
  page.locator('.pane-end').evaluate((sheet) => new DOMMatrix(getComputedStyle(sheet).transform).m42);

/** Drags the grabber down by `distance` px, slowly, and holds still before letting go. */
async function dragGrabber(page: Page, distance: number, check?: () => Promise<void>) {
  const box = (await page.locator('.sheet-grabber').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(x, y + (distance * step) / 10);
    await page.waitForTimeout(20);
  }
  await check?.();
  await page.waitForTimeout(150);
  await page.mouse.up();
}

test('the sheet follows its grabber: a short drag springs back, a long one closes it', async ({ page, stayLocal: _ }) => {
  await page.goto('/');
  await openPdf(page, INVOICE);
  await chooseToolFromPicker(page, 'Compress');
  const sheet = page.locator('.pane-end');
  await expect.poll(() => offset(page)).toBe(0);

  // Held 40 px down, the sheet is 40 px down: it moves with the finger.
  await dragGrabber(page, 40, async () => {
    expect(Math.round(await offset(page))).toBe(40);
  });
  await expect.poll(() => offset(page)).toBe(0);
  await expect(sheet).toBeVisible();

  // Pulled up, it gives a little, and less than it was pulled.
  await dragGrabber(page, -60, async () => {
    const pulled = await offset(page);
    expect(pulled).toBeLessThan(0);
    expect(pulled).toBeGreaterThan(-60);
  });
  await expect.poll(() => offset(page)).toBe(0);

  const height = (await sheet.boundingBox())!.height;
  await dragGrabber(page, height * 0.7);
  await expect(sheet).toHaveCount(0);
  await expect((await viewMenu(page)).getByRole('menuitemcheckbox', { name: /^Tools pane/ })).toHaveAttribute('aria-checked', 'false');
});
