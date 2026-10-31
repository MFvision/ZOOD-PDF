import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, answer, openPdf, test } from './helpers';

/**
 * Help & Support, the way a person uses it: F1 opens it; a question finds
 * its guide; Show me puts the pointer on the real control and waits, Do it
 * for me presses it; a report is reviewed before it is sent and its status
 * comes back; ideas are voted on with no account; a guide opens as a PDF.
 * The relay is answered by the test, so nothing leaves the machine.
 */

const RELAY = 'https://pdf.zoodrealty.com/api/support/';

async function start(page: Page, lang: 'en' | 'ar' = 'en'): Promise<void> {
  await page.addInitScript(
    ([language]) => {
      if (!localStorage.getItem('warraq.preferences')) localStorage.setItem('warraq.preferences', JSON.stringify({ lang: language }));
    },
    [lang],
  );
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible();
}

const support = (page: Page) => page.getByRole('dialog', { name: 'Help & Support' });

test.describe('Help & Support', () => {
  test('F1 opens it; a question finds its guide; Show me points at the real button and waits for the press', async ({ page }) => {
    await start(page);
    await page.keyboard.press('F1');
    await expect(support(page)).toBeVisible();
    await support(page).getByRole('textbox', { name: /What do you want to do/ }).fill('how do I make my file smaller');
    await support(page).getByRole('button', { name: 'Ask', exact: true }).last().click();
    await expect(support(page).getByRole('heading', { name: 'Make a file smaller' })).toBeVisible();
    // Each step shows the real app, with the control it names lit up.
    const pictures = support(page).locator('.support-step-pic');
    await expect(pictures).toHaveCount(3);
    await pictures.first().scrollIntoViewIfNeeded();
    await expect.poll(() => pictures.first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1080);

    await openPdf(page, INVOICE);
    await page.keyboard.press('F1');
    await support(page).getByRole('textbox', { name: /What do you want to do/ }).fill('compress');
    await support(page).getByRole('button', { name: 'Ask', exact: true }).last().click();
    await support(page).getByRole('button', { name: 'Show me' }).click();
    await expect(support(page)).toBeHidden();

    // The pointer's ring sits on the Compress card in the tools pane, and nothing has been pressed for the person.
    const ring = page.locator('.guide-ring');
    await expect(ring).toBeVisible();
    const card = page.locator('.pane-end .tool-card', { hasText: 'Compress' }).first();
    const [ringBox, cardBox] = [await ring.boundingBox(), await card.boundingBox()];
    expect(Math.abs(ringBox!.x + 6 - cardBox!.x)).toBeLessThan(3);
    expect(Math.abs(ringBox!.y + 6 - cardBox!.y)).toBeLessThan(3);
    // A one-step guide says what to press with no "Step 1 of 1" over it.
    await expect(page.locator('.guide-card')).toBeVisible();
    await expect(page.locator('.guide-card-count')).toHaveCount(0);
    await page.waitForTimeout(800);
    await expect(page.locator('.toolbar-tool-picker')).not.toHaveText('Compress');

    // The person presses it: the tool opens and the guide finishes.
    await card.click();
    await expect(page.locator('.toolbar-tool-picker')).toHaveText('Compress');
    await expect(page.getByRole('status').filter({ hasText: 'Done!' })).toBeVisible();
    await expect(page.locator('.guide-layer')).toBeHidden({ timeout: 10_000 });
  });

  test('Do it for me presses the buttons itself, and Stop ends it', async ({ page }) => {
    await start(page);
    await openPdf(page, INVOICE);
    await page.keyboard.press('F1');
    await support(page).getByRole('tab', { name: 'Guides' }).click();
    await support(page).getByRole('button', { name: /Rotate, delete and reorder pages/ }).click();
    await support(page).getByRole('button', { name: 'Do it for me' }).click();
    await expect(page.locator('.guide-layer')).toBeVisible();
    await expect(page.locator('.toolbar-tool-picker')).toHaveText('Organize pages', { timeout: 10_000 });
    await expect(page.locator('.guide-layer')).toBeHidden({ timeout: 10_000 });

    await page.keyboard.press('F1');
    await support(page).getByRole('tab', { name: 'Guides' }).click();
    await support(page).getByRole('button', { name: /Put a password on a file/ }).click();
    await support(page).getByRole('button', { name: 'Show me' }).click();
    await expect(page.locator('.guide-layer')).toBeVisible();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.locator('.guide-layer')).toBeHidden();
    await expect(page.locator('.toolbar-tool-picker')).toHaveText('Organize pages');
  });

  test('a report is reviewed before it goes, carries only what was shown, and its status comes back', async ({ page }) => {
    let status = 'open';
    const seen = await answer(page, RELAY, (request) => {
      const action = new URL(request.url()).searchParams.get('a');
      if (action === 'ticket') return { json: { ok: true, id: '0123456789abcdef', token: 'b'.repeat(32), number: 12 } };
      if (action === 'status') return { json: { ok: true, tickets: [{ id: '0123456789abcdef', status, fixedIn: status === 'resolved' ? '0.5.1' : null, reply: status === 'resolved' ? 'Thanks, fixed.' : null }] } };
      return { status: 404, json: { ok: false } };
    });
    await start(page);
    await page.keyboard.press('F1');
    await support(page).getByRole('tab', { name: 'Report a problem' }).click();
    await support(page).getByRole('radio', { name: 'A file comes out wrong' }).click();
    await support(page).getByLabel('What happened').fill('The Word export of my invoice lost the table.');
    await support(page).getByRole('button', { name: 'Review before sending' }).click();
    await expect(support(page).getByText('This is everything that will be sent')).toBeVisible();
    await expect(support(page).getByText('The Word export of my invoice lost the table.')).toBeVisible();
    expect(seen).toHaveLength(0);

    await support(page).getByRole('button', { name: 'Send', exact: true }).click();
    await expect(support(page).getByText('Your report number is 12')).toBeVisible();
    const sent = seen[0]!.postDataJSON() as Record<string, unknown>;
    expect(sent).toMatchObject({ kind: 'file', text: 'The Word export of my invoice lost the table.', contact: '', picture: null, lang: 'en' });
    expect(Object.keys(sent).sort()).toEqual(['app', 'contact', 'install', 'kind', 'lang', 'log', 'picture', 'platform', 'screen', 'text']);
    await expect(support(page).locator('.support-ticket')).toContainText('Open');

    // Later, it is fixed: opening the tab asks, and shows the version and the reply.
    status = 'resolved';
    await page.keyboard.press('Escape');
    await expect(support(page)).toBeHidden();
    await page.keyboard.press('F1');
    await support(page).getByRole('tab', { name: 'Report a problem' }).click();
    await expect(support(page).locator('.support-ticket')).toContainText('Fixed in 0.5.1');
    await expect(support(page).locator('.support-ticket')).toContainText('Thanks, fixed.');
  });

  test('with no relay yet, the same report goes by e-mail', async ({ page }) => {
    await answer(page, RELAY, () => ({ status: 404, contentType: 'text/html', body: '<h1>Not Found</h1>' }));
    await start(page);
    await page.keyboard.press('F1');
    await support(page).getByRole('tab', { name: 'Report a problem' }).click();
    await support(page).getByLabel('What happened').fill('Printing does nothing.');
    await support(page).getByRole('button', { name: 'Review before sending' }).click();
    await support(page).getByRole('button', { name: 'Send', exact: true }).click();
    await expect(support(page).getByText('could not be reached just now')).toBeVisible();
    await expect(support(page).getByRole('button', { name: 'Send by e-mail' })).toBeVisible();
  });

  test('ideas are voted on with no account, one vote each', async ({ page }) => {
    const votes = new Map([['aaaaaaaaaaaaaaaa', 41]]);
    const seen = await answer(page, RELAY, (request) => {
      const action = new URL(request.url()).searchParams.get('a');
      if (action === 'ideas') {
        return {
          json: {
            ok: true,
            ideas: [
              { id: 'aaaaaaaaaaaaaaaa', title: 'Send a PDF to WhatsApp', body: '', votes: 41, status: 'planned', voted: false, mine: false, created: 1 },
              { id: 'bbbbbbbbbbbbbbbb', title: 'Dark pages', body: 'For reading at night', votes: 3, status: 'open', voted: false, mine: false, created: 2 },
            ],
          },
        };
      }
      if (action === 'vote') {
        const body = request.postDataJSON() as { idea: string; on: boolean };
        votes.set(body.idea, (votes.get(body.idea) ?? 0) + (body.on ? 1 : -1));
        return { json: { ok: true, votes: votes.get(body.idea) } };
      }
      return { status: 404, json: { ok: false } };
    });
    await start(page);
    await page.keyboard.press('F1');
    await support(page).getByRole('tab', { name: 'Ideas' }).click();
    const first = support(page).locator('.support-idea').first();
    await expect(first).toContainText('Send a PDF to WhatsApp');
    await expect(first).toContainText('Planned');
    await first.getByRole('button', { name: /Vote for this idea/ }).click();
    await expect(first.getByRole('button', { name: /Take back your vote/ })).toContainText('42');
    const vote = seen.find((request) => request.url().includes('a=vote'))!;
    expect(Object.keys(vote.postDataJSON() as object).sort()).toEqual(['idea', 'install', 'on']);
  });

  test('a guide opens as a PDF in the app, and Settings has a Support page', async ({ page }) => {
    await start(page);
    await page.keyboard.press('F1');
    await support(page).getByRole('tab', { name: 'Guides' }).click();
    await support(page).getByRole('button', { name: /Make a file smaller/ }).click();
    await support(page).getByRole('button', { name: 'Open the PDF guide' }).click();
    await expect(support(page)).toBeHidden();
    await expect(page.locator('.toolbar-title-name')).toHaveText('Guide - Make a file smaller');

    await page.getByRole('menubar').getByRole('menuitem', { name: 'Help' }).click();
    await expect(page.getByRole('menuitem', { name: /Help & Support/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Report a problem/ })).toBeVisible();
  });

  test('it is Arabic and right to left in Arabic', async ({ page }) => {
    await start(page, 'ar');
    await page.keyboard.press('F1');
    const sheet = page.getByRole('dialog', { name: 'المساعدة والدعم' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('textbox').fill('كيف أدمج ملفين');
    await sheet.getByRole('button', { name: 'اسأل', exact: true }).last().click();
    await expect(sheet.getByRole('heading', { name: 'دمج عدة ملفات في ملف واحد' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  });
});
