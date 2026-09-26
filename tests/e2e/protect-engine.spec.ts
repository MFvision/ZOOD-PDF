/**
 * Protect through the engine: set an AES-256 open password + owner password + permissions, save,
 * reopen through our own password prompt (wrong password rejected, right one opens); edit a protected
 * file and save: still encrypted with the same key and the original bytes are a byte prefix.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixture, fixtureBytes, highlightSecondParagraph, openViaCard, pickTool, savedFiles, stubSavePicker, waitForDocument, writeTemp } from './helpers';
import { openErrorCode, openInEngine } from './engine';

async function setup(browser: Browser, locale: 'en' | 'ar'): Promise<Page> {
  const context = await browser.newContext({ locale });
  await stubSavePicker(context);
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

async function save(page: Page): Promise<Buffer> {
  const before = (await savedFiles(page)).length;
  await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
  await expect.poll(async () => (await savedFiles(page)).length, { timeout: 30_000 }).toBeGreaterThan(before);
  const saved = await savedFiles(page);
  return saved[saved.length - 1]!.bytes;
}

for (const locale of ['en', 'ar'] as const) {
  test.describe(`Protect through the engine (${locale})`, () => {
    test('AES-256 password and permissions: saved file needs the password; our prompt rejects a wrong one', async ({ browser }) => {
      const userPw = locale === 'ar' ? 'كلمة-سر-١٢٣' : 'open-sesame';
      const ownerPw = 'owner-key-99';
      const page = await setup(browser, locale);
      await openViaCard(page, fixture('sample-en.pdf'));
      await pickTool(page, 'protect');
      const panel = page.locator('[data-testid=protect-panel]');
      await expect(panel).toBeVisible();
      // EmbedPDF's protection modal is not used any more.
      await expect(page.getByText(locale === 'ar' ? 'طلب كلمة مرور للفتح' : 'Require a password to open')).toHaveCount(1);
      await panel.locator('[data-testid=protect-open-password]').fill(userPw);
      await panel.locator('[data-testid=protect-open-confirm]').fill(userPw + 'x');
      await panel.locator('[data-testid=protect-owner-password]').fill(ownerPw);
      await panel.locator('[data-perm=copy]').uncheck();
      await panel.locator('[data-perm=modify]').uncheck();
      await panel.locator('[data-testid=protect-apply]').click();
      await expect(panel.locator('[data-testid=protect-error]')).toBeVisible(); // confirmation mismatch
      await panel.locator('[data-testid=protect-open-confirm]').fill(userPw);
      await panel.locator('[data-testid=protect-apply]').click();
      await waitForDocument(page); // the viewer reloads the protected bytes with the password
      await expect(panel.locator('[data-testid=protect-status]')).toContainText('AES-256');

      const bytes = await save(page);
      expect(await openErrorCode(bytes)).toBe('password_required');
      expect(await openErrorCode(bytes, 'nope')).toBe('wrong_password');
      const asUser = await openInEngine(bytes, userPw);
      const info = asUser.info();
      expect(info.encrypted).toBe(true);
      expect(info.passwordMatched).toBe('user');
      expect(info.permissions.copy).toBe(false);
      expect(info.permissions.modify).toBe(false);
      expect(info.permissions.print).toBe(true);
      expect(info.revisions).toBe(1); // password change = whole rewrite
      expect(asUser.call<{ encryption: { method: string } }>('doc.info').json.encryption.method).toBe('AES-256');
      expect(asUser.plain()).toContain('Quarterly report');
      asUser.close();
      expect((await openInEngine(bytes, ownerPw)).info().passwordMatched).toBe('owner');

      // Recents dropped the picture of the file.
      await page.locator('[data-testid=document-view]:visible').getByRole('button', { name: /Home|الرئيسية/ }).first().click();
      const card = page.locator('[data-testid=recent-card][data-name="sample-en.pdf"]');
      await expect(card.locator('.thumb-placeholder')).toBeVisible();

      // Reopen the saved file: our prompt, a wrong password is rejected, the right one opens it.
      const file = writeTemp('protected.pdf', bytes);
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-card=open]').click()]);
      await chooser.setFiles(file);
      const sheet = page.locator('[data-testid=password-sheet]');
      await expect(sheet).toBeVisible();
      await sheet.locator('[data-testid=password-input]').fill('wrong-password');
      await page.locator('[data-testid=password-submit]').click();
      await expect(page.locator('[data-testid=password-error]')).toBeVisible();
      await sheet.locator('[data-testid=password-input]').fill(userPw);
      await page.locator('[data-testid=password-submit]').click();
      await waitForDocument(page);
      await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).toHaveText(locale === 'ar' ? /صفحة ١ من ٢/ : /Page 1 of 2/);
      await page.context().close();
    });

    test('edit a protected file (comment): saved as an incremental update, still encrypted, original bytes a prefix', async ({ browser }) => {
      // A protected copy of the English fixture, made by the engine.
      const plain = await openInEngine(fixtureBytes('sample-en.pdf'));
      const protectedBytes = Buffer.from(
        plain.call('protect.set', { userPassword: 'pw-4711', ownerPassword: 'owner-4711' }).blobs[0]!,
      );
      plain.close();
      const file = writeTemp('locked.pdf', protectedBytes);
      const page = await setup(browser, locale);
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-card=open]').click()]);
      await chooser.setFiles(file);
      await page.locator('[data-testid=password-input]').fill('pw-4711');
      await page.locator('[data-testid=password-submit]').click();
      await waitForDocument(page);
      await highlightSecondParagraph(page);
      const bytes = await save(page);
      expect(bytes.subarray(0, protectedBytes.length).equals(protectedBytes)).toBe(true);
      expect(bytes.length).toBeGreaterThan(protectedBytes.length);
      expect(await openErrorCode(bytes)).toBe('password_required');
      const doc = await openInEngine(bytes, 'pw-4711');
      const info = doc.info();
      expect(info.encrypted).toBe(true);
      expect(info.revisions).toBe(2);
      // The appended update is encrypted with the original key: the annotation's author string is
      // ciphertext (names such as /Highlight are never encrypted in PDF).
      const appended = bytes.subarray(protectedBytes.length);
      expect(appended.toString('latin1')).toContain('/Highlight');
      expect(appended.includes(Buffer.from('Guest'))).toBe(false);
      expect(appended.includes(Buffer.from([0x06, 0x36, 0x06, 0x4a, 0x06, 0x41]))).toBe(false); // «ضيف» UTF-16BE
      doc.close();
      await page.context().close();
    });
  });
}

test('the protected file has no recents picture after it was opened with a password', async ({ browser }) => {
  const plain = await openInEngine(fixtureBytes('sample-en.pdf'));
  const locked = Buffer.from(plain.call('protect.set', { userPassword: 'x1', ownerPassword: 'x2' }).blobs[0]!);
  plain.close();
  const page = await setup(browser, 'en');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-card=open]').click()]);
  await chooser.setFiles(writeTemp('secret.pdf', locked));
  await page.locator('[data-testid=password-input]').fill('x1');
  await page.locator('[data-testid=password-submit]').click();
  await waitForDocument(page);
  await page.getByRole('button', { name: 'Home' }).first().click();
  const card = page.locator('[data-testid=recent-card][data-name="secret.pdf"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.thumb-placeholder')).toBeVisible();
  // Protect panel is reachable from the tool gallery of the reopened document, with its status.
  await card.locator('.recent-open').click();
  await waitForDocument(page);
  await pickTool(page, 'protect');
  await expect(page.locator('[data-testid=protect-status]')).toContainText('AES-256');
  await page.context().close();
});
