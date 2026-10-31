import { expect } from '@playwright/test';
import { chooseTool, corpus, documentStatus, openPdf, test } from './helpers';

/**
 * Autosave's recovery copy, brought back after the app went away with work
 * unsaved. The work it brings back is still unsaved: the tab says so, and
 * closing it asks first. It once opened as if it had been saved, its copy was
 * dropped at once, and closing the tab threw the work away without a word.
 */
test('work restored from autosave stays unsaved until it is saved', async ({
  page,
  stayLocal: _,
}) => {
  // Autosave runs every minute: the clock is moved on rather than waited for.
  await page.clock.install();
  await page.goto('/');
  await openPdf(page, corpus('generated/chrome-notonaskh-justified-3pages.pdf'));
  await chooseTool(page, 'Organize');
  const pane = page.locator('.pane-end');
  await pane.getByRole('button', { name: 'Select all', exact: true }).click();
  await pane.getByRole('button', { name: 'Rotate clockwise', exact: true }).click();
  await pane.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(documentStatus(page)).toContainText('Edited');

  // A minute on, the copy is kept; then the window goes away unsaved.
  await page.clock.fastForward(65_000);
  const kept = () =>
    page.evaluate(async () =>
      // Only once the app has made it: an empty one made here would lack its store.
      !(await indexedDB.databases()).some((db) => db.name === 'zood-recovery')
        ? 0
        : new Promise<number>((resolve) => {
            const open = indexedDB.open('zood-recovery');
            open.onerror = () => resolve(0);
            open.onsuccess = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains('entries')) return resolve(0);
              const count = db.transaction('entries').objectStore('entries').count();
              count.onsuccess = () => resolve(count.result);
              count.onerror = () => resolve(0);
            };
          }),
    );
  await expect.poll(kept).toBe(1);
  await page.reload();
  const banner = page.locator('.banner-recovery');
  await banner.getByRole('button', { name: 'Restore' }).click();

  const tabs = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toContainText('•');

  // Closing asks, rather than losing the work brought back.
  await page
    .getByRole('button', { name: /^Close / })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: 'Save the changes?' })).toBeVisible();
});
