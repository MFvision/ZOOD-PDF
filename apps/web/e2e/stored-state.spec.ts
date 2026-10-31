import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './helpers';

/**
 * What the app finds kept in the browser can be anything: a value an older
 * version wrote, one another tab half-wrote, one a person or an extension
 * edited, or nothing at all because the browser blocks site data. The app
 * must open with sane defaults over every one of them, never a white page or
 * the crash screen.
 */

/** Every key the web app reads at start or soon after. */
const KEYS = [
  'warraq.preferences', 'zood.settings', 'warraq.fontLibrary', 'warraq.recent', 'warraq.recentDates', 'zood.recentSizes',
  'warraq.recentThumbs', 'warraq.starred', 'warraq.tour', 'warraq.tour.at', 'warraq.ask', 'warraq.askHint', 'warraq.ai.settings',
  'warraq.ai.profile', 'warraq.readAloud', 'warraq.markupBar', 'warraq.print', 'zood.recentView', 'zood.zooms', 'warraq.ocr.options',
  'warraq.batch.actions', 'warraq.signatures.trusted', 'warraq.cloud.accounts', 'warraq.cloud.recent', 'warraq.support.tickets',
  'warraq.support.ideaDraft', 'warraq.quickTools', 'warraq.ask.style', 'warraq.ask.today.dismissed', 'zood.dropUse', 'zood.remote.pairing',
];

async function opensWell(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('.crash-guard')).toHaveCount(0);
  // And it keeps working: the language can be changed and the home screen answers.
  const language = page.locator('select').filter({ has: page.locator('option', { hasText: 'English' }) }).first();
  await language.selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await language.selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(errors).toEqual([]);
}

for (const [shape, value] of [
  ['null', 'null'],
  ['a list', '[null,1,"x"]'],
  ['a number', '42'],
  ['broken JSON', '{"lang":'],
  ['fields of the wrong type', '{"lang":5,"theme":[],"allowed":"yes","version":"9","shown":null,"menu":null,"rate":"fast"}'],
] as const) {
  test(`opens with defaults when every kept value is ${shape}`, async ({ page, stayLocal: _ }) => {
    await page.addInitScript(
      ([keys, kept]) => {
        if (sessionStorage.getItem('e2e.seeded')) return;
        sessionStorage.setItem('e2e.seeded', '1');
        for (const key of keys) localStorage.setItem(key, kept);
      },
      [KEYS, value] as const,
    );
    await opensWell(page);
  });
}

test('opens when the browser blocks site data (reading localStorage throws)', async ({ page, stayLocal: _ }) => {
  await page.addInitScript(() => {
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    }
  });
  await opensWell(page);
});

test('opens when every write to storage is refused (quota exceeded)', async ({ page, stayLocal: _ }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  await opensWell(page);
});

test('offers only recovery copies that can be opened, over damaged ones', async ({ page, stayLocal: _ }) => {
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible();
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open('zood-recovery', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('entries', { keyPath: 'key' }).createIndex('at', 'at');
      opening.onerror = () => reject(opening.error ?? new Error('open'));
      opening.onsuccess = () => {
        const done = opening.result.transaction('entries', 'readwrite');
        const store = done.objectStore('entries');
        // Damaged: no copy, a copy that is not bytes, a name that is not text, a key that is not text.
        store.put({ key: 'old:1', value: null, at: 1 });
        store.put({ key: 'old:2', value: { name: 'no bytes.pdf' }, at: 2 });
        store.put({ key: 'old:3', value: { name: { a: 1 }, bytes: 'abc' }, at: 3 });
        store.put({ key: 7, value: { name: 'number key.pdf', bytes: new ArrayBuffer(4) }, at: 4 });
        // Sound: still offered beside them.
        store.put({ key: 'old:5', value: { name: 'كشف الرواتب.pdf', bytes: new TextEncoder().encode('%PDF-1.4').buffer }, at: 5 });
        done.oncomplete = () => {
          opening.result.close();
          resolve();
        };
        done.onerror = () => reject(done.error ?? new Error('write'));
      };
    });
  });
  await page.reload();
  const banner = page.locator('.banner-recovery');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('كشف الرواتب.pdf');
  await expect(banner).not.toContainText(/undefined|object Object|no bytes|number key|\+/);
});
