import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, openPdf, test } from './helpers';
import { installDeviceStub, stubRecord } from './deviceStub';

/**
 * The general chat: the AI tool with no document open is an assistant about
 * anything, on this device, and a short command typed into it is done in the
 * app at once, with no model asked. `stayLocal` proves nothing leaves.
 */

const panel = (page: Page) => page.locator('.pane-end');
const chat = (page: Page) => panel(page).getByRole('log', { name: 'Conversation' });

/** The stub's answer: the request, said back, so the test can see what was asked. */
const answer = (messages: { role: string; content: string }[]): string => {
  const request = /Request: (.*)$/s.exec(messages[1]!.content)?.[1] ?? '';
  return `A general answer to "${request}".`;
};

async function openGeneralChat(page: Page): Promise<void> {
  await installDeviceStub(page, answer);
  await page.addInitScript(() => {
    if (!localStorage.getItem('warraq.preferences')) localStorage.setItem('warraq.preferences', JSON.stringify({ lang: 'en' }));
  });
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible();
  const card = page.getByRole('complementary', { name: 'AI Assistant' });
  await card.getByRole('button', { name: /^Download the AI/ }).click();
  await expect(card.getByRole('button', { name: /^Download the AI/ })).toBeHidden();
  await card.getByLabel('Ask a question…').fill('hello');
  await card.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(panel(page).getByRole('radio', { name: 'Chat', exact: true })).toBeChecked();
}

test.describe('the general chat', () => {
  test('answers with no document open, from the home screen and in the panel, and carries the conversation', async ({ page, stayLocal: _ }) => {
    await openGeneralChat(page);
    await expect(chat(page).locator('.ai-turn-assistant').first()).toContainText('A general answer to "hello".');
    const input = panel(page).getByLabel('Message');
    await input.fill('Write a two-line poem about Riyadh');
    await input.press('Enter');
    await expect(chat(page).locator('.ai-turn-assistant').nth(1)).toContainText('A general answer to "Write a two-line poem about Riyadh".');
    const { requests } = await stubRecord(page);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages[0]!.content).toContain('You are ZOOD');
    expect(requests[1]!.messages[1]!.content).toContain('Person: hello');
    expect(requests[1]!.messages[1]!.content).not.toContain('<page');
  });

  test('does what a short command says, in English or Arabic, with no model asked', async ({ page, stayLocal: _ }) => {
    await openGeneralChat(page);
    await expect(chat(page).locator('.ai-turn-assistant')).toHaveCount(1);
    const input = panel(page).getByLabel('Message');
    await input.fill('dark mode');
    await input.press('Enter');
    await expect(chat(page)).toContainText('Switched to dark mode.');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await input.fill('الوضع النهاري');
    await input.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await input.fill('open settings');
    await input.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click();
    // A page needs a document.
    await input.fill('go to page 2');
    await input.press('Enter');
    await expect(chat(page)).toContainText('Open a PDF first, then ask again.');
    // None of these went to the model.
    expect((await stubRecord(page)).requests).toHaveLength(1);
    // A question about doing it is the model's to answer.
    await input.fill('how do I compress a file?');
    await input.press('Enter');
    await expect(chat(page).locator('.ai-turn-assistant')).toHaveCount(2);
  });

  test('a document opened turns the chat to it, and the general chat is a tap away with the document open', async ({ page, stayLocal: _ }) => {
    await openGeneralChat(page);
    await expect(chat(page).locator('.ai-turn-assistant')).toHaveCount(1);
    await openPdf(page, INVOICE);
    await expect(panel(page).getByRole('radio', { name: 'This document', exact: true })).toBeChecked();
    await panel(page).getByRole('radio', { name: 'Chat', exact: true }).click();
    // The general conversation is still there, and commands now reach the document.
    await expect(chat(page)).toContainText('A general answer to "hello".');
    const input = panel(page).getByLabel('Message');
    // The fixture's page count differs between corpus versions: page 1 is in every one, page 9999 in none.
    await input.fill('go to page 9999');
    await input.press('Enter');
    await expect(chat(page)).toContainText(/This document has \d+ pages?\./);
    await input.fill('go to page 1');
    await input.press('Enter');
    await expect(chat(page)).toContainText('Went to page 1.');
    await input.fill('what is this file called?');
    await input.press('Enter');
    await expect(chat(page).locator('.ai-turn-assistant')).toHaveCount(2);
    const { requests } = await stubRecord(page);
    expect(requests.at(-1)!.messages[1]!.content).toMatch(/The PDF open in ZOOD now is "[^"]+"/);
    await page.screenshot({ path: test.info().outputPath('general-chat.png') });
  });
});
