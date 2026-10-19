import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, chooseTool, corpus, fieldValues, openPdf, test } from './helpers';
import { installDeviceStub, stubRecord } from './deviceStub';

/**
 * "On this device": the default AI provider, with the engine faked in the
 * page (`deviceStub.ts`) so nothing is downloaded and nothing runs llama.cpp
 * here: the model's download and removal, and a document tool run on it.
 * The chat itself is in `ai-chat.spec.ts`. `stayLocal` proves that no
 * request leaves the app at any point — not for the review, not for the
 * answer, not for the profile.
 */

const FORM = corpus('generated/acroform-pdflib-arabic-fields.pdf');
const panel = (page: Page) => page.locator('.pane-end');
const preflight = (page: Page) => panel(page).getByRole('region', { name: 'What will be sent' });
const review = (page: Page) => panel(page).getByRole('region', { name: 'To review' });

/** The stub's answer: a sentence for words, a field's value for a form. */
const answer = (messages: { role: string; content: string }[]): string => {
  const user = messages[1]!.content;
  if (user.includes('<fields>')) {
    // The first field listed, filled from the details: the nationality.
    const name = /- name: "([^"]+)"/.exec(user)?.[1] ?? '';
    const email = /[\w.]+@[\w.]+/.exec(user)?.[0] ?? '';
    return JSON.stringify({ values: [{ field: name, value: 'سعودي' }, { field: 'البريد الإلكتروني', value: email }] });
  }
  const question = /Question: (.*)/.exec(user)?.[1] ?? '';
  return `An answer on this device to "${question}" [p. 1] and more [p. 2].`;
};

async function download(page: Page): Promise<void> {
  const ai = panel(page);
  const button = ai.getByRole('button', { name: /^Download the on-device model \(491 MB, once\)/ });
  await expect(button).toBeVisible();
  expect((await stubRecord(page)).downloads).toBe(0);
  await button.click();
  // The chat opens once the model is there.
  await expect(ai.getByRole('list', { name: 'Suggestions' }).getByRole('button', { name: 'Summarize this document' })).toBeEnabled();
  expect((await stubRecord(page)).downloads).toBe(1);
}

test.describe('the AI tool on this device', () => {
  test('is the default, and downloads the model only on the button, its licence and checksum said first', async ({ page, stayLocal: _ }) => {
    await installDeviceStub(page, answer);
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'AI');
    // The chat says the model is not there, and offers its licence and checksum before any download.
    const ai = panel(page);
    await expect(ai).toContainText('Apache-2.0');
    await expect(ai).toContainText('74a4da8c9fdb…93d7a9db');
    await expect(ai).toContainText('Download the on-device model first, or choose another provider.');
    await expect(ai.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await download(page);
    // The settings name the provider, the model and what it runs on.
    await ai.getByRole('button', { name: 'Model settings', exact: true }).click();
    await expect(ai.getByRole('radio', { name: /^Built into the app/ })).toBeChecked();
    await expect(ai).toContainText('The model is on this device (491 MB) and runs on a test engine.');
    expect((await stubRecord(page)).requests).toHaveLength(0);
  });

  test('fills a form from the saved details: encrypted on this device, reviewed, then typed into the fields', async ({ page, stayLocal: _ }) => {
    await installDeviceStub(page, answer);
    await page.goto('/');
    // The details, saved once in Settings.
    await page.getByRole('menubar').getByRole('menuitem', { name: 'محرر PDF' }).click();
    await page.getByRole('menuitem', { name: /^Settings…/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Settings' });
    await sheet.getByLabel('Name (Arabic)').fill('محمد علي');
    await sheet.getByLabel('E-mail').fill('m.ali@example.sa');
    await sheet.getByRole('button', { name: 'Save my details' }).click();
    await expect(sheet).toContainText('Saved on this device.');
    await expect(sheet).toContainText('encrypted with a key the browser made');
    await sheet.getByRole('button', { name: 'Close' }).click();
    // What the browser keeps is ciphertext: neither the name nor the address is readable in it, or in localStorage.
    const kept = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('warraq-profile', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const row = await new Promise<{ iv: Uint8Array; data: ArrayBuffer } | undefined>((resolve, reject) => {
        const request = db.transaction('secrets').objectStore('secrets').get('profile');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const bytes = row ? new Uint8Array(row.data) : new Uint8Array();
      return { size: bytes.length, text: new TextDecoder('latin1').decode(bytes), storage: JSON.stringify({ ...localStorage }) };
    });
    expect(kept.size).toBeGreaterThan(20);
    expect(kept.text).not.toContain('m.ali');
    expect(kept.text).not.toContain('example.sa');
    expect(kept.storage).not.toContain('m.ali');

    await openPdf(page, FORM);
    await chooseTool(page, 'AI');
    await download(page);
    const ai = panel(page);
    await ai.getByRole('button', { name: 'Document tools' }).click();
    await ai.getByRole('radio', { name: 'Fill in the form from my details' }).check();
    await expect(ai).toContainText('Your saved details (2 fields) are used first');
    await ai.getByLabel('Your details (name, ID number, address…)').fill('الجنسية: سعودي');
    await ai.getByRole('button', { name: 'Review what will be sent' }).click();
    await expect(preflight(page)).toContainText('Nowhere: the model runs inside the app on this device');
    await preflight(page).getByRole('button', { name: 'Run on this device' }).click();

    const [request] = (await stubRecord(page)).requests;
    const text = request!.messages[1]!.content;
    expect(text).toContain('- name: "الجنسية" | label: "الجنسية:" | now: ""');
    expect(text).toContain('Name (Arabic) / الاسم (بالعربية): محمد علي');
    expect(text).toContain('E-mail / البريد الإلكتروني: m.ali@example.sa');
    expect(text).toContain('الجنسية: سعودي');
    // A data answer is held to the schema by a grammar.
    expect(request!.grammar).toMatch(/^root ::= /);
    expect(request!.grammar).toContain('"\\"values\\""');

    const values = review(page).getByRole('list', { name: 'Proposed values' });
    await expect(values.locator('li')).toHaveCount(2);
    expect(await fieldValues(page)).not.toContain('سعودي');
    await review(page).getByRole('button', { name: 'Fill 2 fields' }).click();
    await expect(review(page)).toContainText('Filled 2 fields.');
    await expect.poll(() => fieldValues(page)).toContain('سعودي');
    expect(await fieldValues(page)).toContain('m.ali@example.sa');
  });

  test('the model is deleted from Settings, with its size, and the panel asks for it again', async ({ page, stayLocal: _ }) => {
    await installDeviceStub(page, answer);
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'AI');
    await download(page);
    await page.getByRole('menubar').getByRole('menuitem', { name: 'محرر PDF' }).click();
    await page.getByRole('menuitem', { name: /^Settings…/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Settings' });
    await expect(sheet.getByLabel('The AI tool starts with')).toHaveValue('device');
    await expect(sheet.getByLabel('On-device model')).toHaveValue('');
    await expect(sheet).toContainText('For this machine: Qwen2.5 0.5B Instruct (Q4_K_M)');
    await sheet.getByRole('button', { name: 'Delete the model from this device (491 MB)' }).click();
    await expect(sheet.getByRole('button', { name: /^Download the on-device model/ })).toBeVisible();
    expect((await stubRecord(page)).removed).toBe(1);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(panel(page)).toContainText('Download the on-device model first, or choose another provider.');
    await expect(panel(page).getByRole('list', { name: 'Suggestions' }).getByRole('button', { name: 'Summarize this document' })).toBeDisabled();
  });
});
