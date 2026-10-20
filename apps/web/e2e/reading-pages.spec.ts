import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { corpus, documentStatus, openPdf, test } from './helpers';

/**
 * The reading view's page panel (EmbedPDF's thumbnails) has the page menu
 * Organize has: a right-click on a page offers every item, and each acts on
 * that page.
 */

const FIVE_PAGES = corpus('realworld/B_wmf_welcome_to_wikipedia_arabic_indesign_cs5_p1-5.pdf');

/** The centre of page `n`'s thumbnail, inside EmbedPDF's shadow root. */
async function thumbnail(page: Page, n: number): Promise<{ x: number; y: number }> {
  const box = await page.evaluate((wanted) => {
    const root = document.querySelector('embedpdf-container')?.shadowRoot;
    const label = [...(root?.querySelectorAll('span') ?? [])].find(
      (span) => span.textContent?.trim() === String(wanted) && span.parentElement?.previousElementSibling?.querySelector('img'),
    );
    const rect = label?.parentElement?.previousElementSibling?.getBoundingClientRect();
    return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  }, n);
  expect(box, `page ${n}'s thumbnail`).not.toBeNull();
  return box!;
}

test('a right-click on a page in the page panel opens the page menu, and Delete removes that page', async ({ page, stayLocal: _ }) => {
  await page.addInitScript(() => localStorage.setItem('warraq.preferences', JSON.stringify({ lang: 'en', tourSeen: true })));
  await page.goto('/');
  await openPdf(page, FIVE_PAGES);
  await expect(documentStatus(page)).toContainText('Page 1 of 5');

  await expect.poll(() => thumbnail(page, 2).then(() => true).catch(() => false)).toBe(true);
  const at = await thumbnail(page, 2);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Add Page',
    'Delete Page',
    'Extract Pages',
    'Rotate Left',
    'Rotate Right',
    'Replace Page',
    'Crop',
    'Split PDF',
    'Insert from File',
  ]);

  await menu.getByRole('menuitem', { name: 'Delete Page' }).click();
  await expect(documentStatus(page)).toContainText('of 4');
  await expect(documentStatus(page)).toContainText('Edited');
});
