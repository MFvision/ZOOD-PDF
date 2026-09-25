import { expect, test } from '@playwright/test';
import { fixture, fixtureBytes, openViaCard, waitForDocument } from './helpers';

test.describe('recents and ⌘K search', () => {
  test('recents shows the file with a real first-page thumbnail after reopening the app', async ({ page }) => {
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    await page.reload();
    const card = page.locator('[data-testid=recent-card][data-name="sample-en.pdf"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.recent-date')).toContainText('Opened');
    const img = card.locator('img.thumb-img');
    await expect(img).toBeVisible();
    // A real picture of the page: decoded, portrait, and not a blank square.
    const stats = await img.evaluate(async (el: HTMLImageElement) => {
      await el.decode();
      const c = document.createElement('canvas');
      c.width = el.naturalWidth;
      c.height = el.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(el, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! < 128 && d[i + 3]! > 0) dark++;
      return { w: el.naturalWidth, h: el.naturalHeight, dark };
    });
    expect(stats.h).toBeGreaterThan(stats.w);
    expect(stats.dark).toBeGreaterThan(50);

    // One click reopens it (bytes kept locally under the size cap).
    await card.locator('.recent-open').click();
    await waitForDocument(page);
    await expect(page.locator('[data-testid=document-view]:visible .doc-name')).toHaveText('sample-en.pdf');
  });

  test('⋯ menu stars and tags a file; Starred and Tags sections list it', async ({ page }) => {
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    await page.getByRole('button', { name: 'Home' }).first().click();
    const card = page.locator('[data-testid=recent-card]').first();
    await card.locator('[data-testid=recent-menu]').click();
    await page.getByRole('menuitem', { name: 'Add to Starred' }).click();
    await card.locator('[data-testid=recent-menu]').click();
    await page.getByRole('menuitem', { name: 'Edit tags…' }).click();
    await page.getByRole('textbox', { name: 'New tag' }).fill('عقود');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.locator('.side-item', { hasText: 'Starred' }).click();
    await expect(page.locator('[data-testid=recent-card][data-name="sample-en.pdf"]')).toBeVisible();
    await page.locator('.side-item', { hasText: 'Tags' }).click();
    await page.locator('.chip', { hasText: 'عقود' }).click();
    await expect(page.locator('[data-testid=recent-card][data-name="sample-en.pdf"]')).toBeVisible();
  });

  test('⌘K finds a recent file, Arabic-aware (hamza-insensitive), and opens it', async ({ page }) => {
    await page.goto('/');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-card=open]').click()]);
    await chooser.setFiles({ name: 'عقد الإيجار.pdf', mimeType: 'application/pdf', buffer: fixtureBytes('sample-ar.pdf') });
    await waitForDocument(page);
    await page.getByRole('button', { name: 'Home' }).first().click();
    await openViaCard(page, fixture('sample-en.pdf'));
    await page.getByRole('button', { name: 'Home' }).first().click();

    await page.keyboard.press('ControlOrMeta+k');
    const input = page.getByRole('combobox', { name: 'Search' });
    await expect(input).toBeFocused();
    await input.fill('الايجار');
    const results = page.locator('[data-testid=palette-results] [role=option]');
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText('عقد الإيجار.pdf');
    await input.press('Enter');
    await waitForDocument(page);
    await expect(page.locator('[data-testid=document-view]:visible .doc-name')).toHaveText('عقد الإيجار.pdf');
  });

  test('the top bar search field opens the same search', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid=search]').click();
    await page.getByRole('combobox', { name: 'Search' }).fill('zzz-nothing');
    await expect(page.locator('.pal-empty')).toContainText('No results');
  });
});
