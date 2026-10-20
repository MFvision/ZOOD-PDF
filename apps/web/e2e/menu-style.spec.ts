import { expect } from '@playwright/test';
import { corpus, documentStatus, openPdf, test } from './helpers';

/**
 * Settings › Appearance › Menu: the drop-down menus, every command as a
 * button (All), or the commands ticked in Settings beside the menus (Custom).
 * The buttons run the same commands the menus do.
 */

const INVOICE = corpus('generated/coretext-sfarabic-mixed-invoice.pdf');

test('Menu: All shows every command of the chosen menu as a button, and they work', async ({ page, stayLocal: _ }) => {
  await page.addInitScript(() => {
    localStorage.setItem('warraq.preferences', JSON.stringify({ lang: 'en', tourSeen: true }));
    localStorage.setItem('zood.settings', JSON.stringify({ menuBar: 'all' }));
  });
  await page.goto('/');
  await openPdf(page, INVOICE);
  await expect(documentStatus(page)).toContainText('Page 1 of 1');
  const tabs = page.getByRole('tablist', { name: 'Main menu' });
  await expect(tabs.getByRole('tab')).toHaveText(['ZOOD PDF', 'File', 'Edit', 'View', 'Tools', 'Help']);
  await tabs.getByRole('tab', { name: 'Edit' }).click();
  const ribbon = page.getByRole('toolbar', { name: 'Edit' });
  await expect(ribbon.getByRole('button')).toHaveText(['Undo', 'Redo', 'Edit text', 'Find…', 'Go to page…']);
  await ribbon.getByRole('button', { name: 'Edit text' }).click();
  await expect(ribbon.getByRole('button', { name: 'Edit text' })).toHaveAttribute('aria-pressed', 'true');
});

test('Menu: Custom puts the ticked commands beside the menus, chosen in Settings', async ({ page, stayLocal: _ }) => {
  await page.addInitScript(() => localStorage.setItem('warraq.preferences', JSON.stringify({ lang: 'en', tourSeen: true })));
  await page.goto('/');
  await openPdf(page, INVOICE);
  await expect(page.getByRole('toolbar', { name: 'Commands shown as buttons' })).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('button', { name: 'Appearance' }).first().click();
  await page.getByRole('radio', { name: 'Custom' }).click();
  await page.getByRole('checkbox', { name: 'Go to page…' }).check();
  await page.getByRole('checkbox', { name: 'Print…' }).uncheck();
  await page.keyboard.press('Escape');

  const commands = page.getByRole('toolbar', { name: 'Commands shown as buttons' });
  await expect(commands.getByRole('button')).toHaveText(['Settings…', 'Open…', 'Save', 'Undo', 'Redo', 'Find…', 'Go to page…']);
  await commands.getByRole('button', { name: 'Go to page…' }).click();
  await expect(page.getByRole('dialog', { name: /Go to page/ })).toBeVisible();
});
