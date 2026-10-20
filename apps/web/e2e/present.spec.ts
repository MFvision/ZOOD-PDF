import { expect } from '@playwright/test';
import { corpus, openPdf, test } from './helpers';

/**
 * Present mode (packages/ui/src/remote/PresentMode.tsx): the open PDF full
 * screen, a page at a time, turned by the keyboard or a presenter's clicker.
 * The phone remote drives the same mode on the desktop; here it is the PC's
 * own keys.
 */

const THREE_PAGES = corpus('generated/chrome-notonaskh-justified-3pages.pdf');

test('Present shows the page full screen, turns with the keys, blacks out, and ends with Esc', async ({ page, stayLocal: _ }) => {
  await page.goto('/');
  await openPdf(page, THREE_PAGES);
  await page.getByRole('toolbar').getByRole('button', { name: 'Present', exact: true }).click();

  const present = page.getByRole('dialog', { name: 'Present mode' });
  await expect(present).toBeVisible();
  await expect(present.getByText('Page 1 of 3')).toBeVisible();
  // The page is drawn, not left blank.
  await expect(present.locator('canvas.present-canvas')).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(present.getByText('Page 2 of 3')).toBeVisible();
  // A clicker sends Page Down.
  await page.keyboard.press('PageDown');
  await expect(present.getByText('Page 3 of 3')).toBeVisible();
  await expect(present.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await page.keyboard.press('Home');
  await expect(present.getByText('Page 1 of 3')).toBeVisible();

  await page.keyboard.press('b');
  await expect(present.getByLabel('The screen is black')).toBeVisible();
  await page.keyboard.press('b');
  await expect(present.getByLabel('The screen is black')).toBeHidden();

  await present.getByRole('button', { name: 'Next page' }).click();
  await expect(present.getByText('Page 2 of 3')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(present).toBeHidden();
  // The editor is left on the page the presentation ended on.
  await expect(page.getByRole('textbox', { name: 'Current page' })).toHaveValue('2');
});
