/**
 * Digital signature through the real interface, English and Arabic: import the test PKCS#12,
 * wrong password, unlock, draw the box on the page, hand-drawn picture, sign (B-B, the only level
 * on the web), save through the host bridge, reopen the saved bytes, read the banner and the
 * Signatures panel — and inspect the saved bytes independently with the engine in Node
 * (original is a prefix, `sign.verify`). Tampering after a certification, a shadow-attack
 * fixture, the trust list and "View signed version".
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { ENGINE_BUILT, FIXTURES, ROOT, fixture, highlightSecondParagraph, openViaCard, pickTool, savedFiles, stubSavePicker, trackExternalRequests } from './helpers';

const PKI = path.join(FIXTURES, 'sign/pki');

interface WasmDoc {
  call(method: string, params: string, blobs: Uint8Array[]): { json: string; blobs: Uint8Array[] };
  free(): void;
}
let wasm: { WarraqDocument: { open(b: Uint8Array, pw?: string): WasmDoc } } | null = null;

/** The engine itself (wasm in Node), independent of the browser: `sign.verify` on saved bytes. */
async function verifyInNode(bytes: Buffer, roots: Buffer[] = []): Promise<Record<string, unknown>[]> {
  if (!wasm) {
    const pkg = path.join(ROOT, 'packages/ui/src/wasm/pkg');
    const mod = await import(pathToFileURL(path.join(pkg, 'warraq_core.js')).href);
    mod.initSync({ module: fs.readFileSync(path.join(pkg, 'warraq_core_bg.wasm')) });
    wasm = mod;
  }
  const doc = wasm!.WarraqDocument.open(new Uint8Array(bytes), undefined);
  try {
    const r = doc.call('sign.verify', '{}', roots.map((b) => new Uint8Array(b)));
    return JSON.parse(r.json).signatures;
  } finally {
    doc.free();
  }
}

const LOCALES = [
  {
    locale: 'en',
    browser: 'en-US',
    file: 'sample-en.pdf',
    wrongPassword: /Wrong certificate password/,
    saved: /Saved/,
    unknown: /valid, identity unknown/,
    valid: /— valid$/,
    modified: /changed after signing/,
    reason: 'Approval',
    location: 'Riyadh',
    name: 'Test Signer RSA',
    p12: 'signer-rsa-modern.p12',
  },
  {
    locale: 'ar',
    browser: 'ar-SA',
    file: 'sample-ar.pdf',
    wrongPassword: /كلمة سر الشهادة غير صحيحة/,
    saved: /حُفظ/,
    unknown: /صالح، وهوية الموقِّع غير معروفة/,
    valid: /— صالح$/,
    modified: /تغيّر بعد التوقيع/,
    reason: 'اعتماد',
    location: 'الرياض',
    name: 'أحمد بن سعيد',
    p12: 'signer-p256-modern.p12',
  },
] as const;

async function choose(page: Page, testId: string, file: string) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(`[data-testid=${testId}]`).click()]);
  await chooser.setFiles(file);
}

async function drag(page: Page, selector: string, from: [number, number], to: [number, number]) {
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((from[0] + to[0]) / 2), box.y + box.height * ((from[1] + to[1]) / 2), { steps: 5 });
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 5 });
  await page.mouse.up();
}

async function unlock(page: Page, p12: string, password = 'test123') {
  await choose(page, 'sign-choose-p12', path.join(PKI, p12));
  await page.locator('[data-testid=sign-password]').fill(password);
  await page.locator('[data-testid=sign-unlock]').click();
}

async function reopen(page: Page, name: string, bytes: Buffer) {
  await page.goto('/');
  await openViaCard(page, { name, mimeType: 'application/pdf', buffer: bytes });
}

for (const L of LOCALES) {
  test.describe(`digital signature (${L.locale})`, () => {
    test.use({ locale: L.browser });
    test.skip(!ENGINE_BUILT, 'needs the warraq-core engine');

    test('sign visibly with a drawn picture, save, reopen: the Signatures panel shows the signer and a valid signature', async ({ context, page }) => {
      await stubSavePicker(context);
      const external = trackExternalRequests(page);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', L.locale);
      await openViaCard(page, fixture(L.file));
      await pickTool(page, 'digital-signature');
      await expect(page.locator('[data-testid=sign-panel]')).toBeVisible();

      // Wrong password first.
      await unlock(page, L.p12, 'not-the-password');
      await expect(page.locator('[data-testid=sign-error]')).toHaveText(L.wrongPassword);
      await page.locator('[data-testid=sign-password]').fill('test123');
      await page.locator('[data-testid=sign-unlock]').click();
      await expect(page.locator('[data-testid=sign-cert-name]')).toHaveText(L.name);
      await expect(page.locator('[data-testid=sign-cert]')).toContainText('ZOOD Test Document CA');
      await expect(page.locator('[data-testid=sign-name]')).toHaveValue(L.name);

      // Web: B-B only (timestamps and LTV are desktop-only and hidden here).
      await expect(page.locator('[data-level=B-B]')).toBeVisible();
      await expect(page.locator('[data-level=B-T], [data-level=B-LT], [data-level=B-LTA]')).toHaveCount(0);

      // Draw the box on page 1 and a hand-drawn signature.
      await expect(page.locator('[data-testid=sign-page-preview] img')).toBeVisible();
      await drag(page, '[data-testid=sign-page-preview]', [0.5, 0.78], [0.92, 0.9]);
      await expect(page.locator('[data-testid=sign-rect]')).toBeVisible();
      await page.locator('[data-testid=sign-reason]').fill(L.reason);
      await page.locator('[data-testid=sign-location]').fill(L.location);
      await page.locator('[data-picture=draw]').click();
      await drag(page, '[data-testid=sign-pad]', [0.1, 0.6], [0.9, 0.3]);

      await page.locator('[data-testid=sign-run]').click();
      await expect(page.locator('.hud', { hasText: L.saved })).toBeVisible();
      const [saved] = await savedFiles(page);
      expect(saved!.name).toBe(L.file);

      // The viewer reloads on the signed bytes and verifies them.
      const banner = page.locator('[data-testid=document-view]:visible [data-testid=sig-banner]');
      await expect(banner).toHaveAttribute('data-status', 'valid_identity_unknown');
      await expect(banner).toContainText(L.name);

      // Saved bytes: the original file is an exact prefix; one incremental update with the signature.
      const original = fs.readFileSync(fixture(L.file));
      expect(saved!.bytes.subarray(0, original.length).equals(original)).toBe(true);
      const tail = saved!.bytes.subarray(original.length).toString('latin1');
      expect(tail).toContain('/ETSI.CAdES.detached');
      expect(tail).toContain('/ByteRange');
      expect(tail).toContain('/Subtype /Image'); // the hand-drawn picture
      const sigs = await verifyInNode(saved!.bytes);
      expect(sigs).toHaveLength(1);
      expect(sigs[0]).toMatchObject({ status: 'valid_identity_unknown', integrity: true, coversWholeDocument: true, reason: L.reason, location: L.location });
      expect((sigs[0]!.signer as { name: string }).name).toBe(L.name);
      const trusted = await verifyInNode(saved!.bytes, [fs.readFileSync(path.join(PKI, 'root.pem'))]);
      expect(trusted[0]!.status).toBe('valid');

      // Reopen the saved bytes: banner + panel.
      await reopen(page, `signed-${L.file}`, saved!.bytes);
      const banner2 = page.locator('[data-testid=document-view]:visible [data-testid=sig-banner]');
      await expect(banner2).toHaveAttribute('data-status', 'valid_identity_unknown');
      await expect(banner2).toContainText(L.unknown);
      await banner2.locator('[data-testid=sig-banner-open]').click();
      const card = page.locator('[data-testid=sig-card]');
      await expect(card).toHaveCount(1);
      await expect(card.locator('[data-testid=sig-signer]')).toHaveText(L.name);
      await expect(card).toHaveAttribute('data-status', 'valid_identity_unknown');
      await expect(card.locator('[data-testid=sig-mods]')).toHaveCount(0);
      // Hijri calendar (the signature was made in 1448 AH).
      await page.locator('[data-calendar=islamic]').click();
      await expect(card.locator('[data-testid=sig-time]')).toContainText(L.locale === 'ar' ? '١٤٤٨' : '1448');
      if (L.locale === 'ar') await expect(card.locator('[data-testid=sig-time]')).not.toContainText(/[0-9]/);

      // Trust the test root: identity becomes trusted, the banner says valid.
      await choose(page, 'sig-trust-add', path.join(PKI, 'root.pem'));
      await expect(page.locator('[data-testid=sig-trust-item]')).toHaveCount(1);
      await expect(card).toHaveAttribute('data-status', 'valid');
      await expect(banner2).toContainText(L.valid);
      expect(external).toEqual([]);
    });

    test('certified with "no changes", then commented: the panel lists the disallowed change; the signed version is still valid', async ({ context, page }) => {
      await stubSavePicker(context);
      await page.goto('/');
      await openViaCard(page, fixture(L.file));
      await pickTool(page, 'digital-signature');
      await unlock(page, L.p12);
      await expect(page.locator('[data-testid=sign-cert-name]')).toHaveText(L.name);
      await page.locator('[data-placement=invisible]').click();
      await page.locator('[data-kind=certify]').click();
      await page.locator('[data-certify="1"]').check();
      await page.locator('[data-testid=sign-run]').click();
      await expect(page.locator('.hud', { hasText: L.saved })).toBeVisible();
      const banner = page.locator('[data-testid=document-view]:visible [data-testid=sig-banner]');
      await expect(banner).toHaveAttribute('data-status', 'valid_identity_unknown');

      // Modify after signing (a highlight) and save: an incremental update on top of the signature.
      await highlightSecondParagraph(page);
      await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
      await expect.poll(async () => (await savedFiles(page)).length).toBe(2);
      const [signed, tampered] = await savedFiles(page);
      expect(tampered!.bytes.subarray(0, signed!.bytes.length).equals(signed!.bytes)).toBe(true);
      const sigs = await verifyInNode(tampered!.bytes);
      expect(sigs[0]).toMatchObject({ status: 'modified', kind: 'certification', certification: 1, integrity: true });

      await reopen(page, `tampered-${L.file}`, tampered!.bytes);
      const banner2 = page.locator('[data-testid=document-view]:visible [data-testid=sig-banner]');
      await expect(banner2).toHaveAttribute('data-status', 'modified');
      await expect(banner2).toContainText(L.modified);
      await banner2.locator('[data-testid=sig-banner-open]').click();
      const mods = page.locator('[data-testid=sig-card] [data-testid=sig-mods] li');
      await expect(mods.filter({ has: page.locator('.badge-deleted') }).first()).toBeVisible();
      await expect(page.locator('[data-testid=sig-card] [data-testid=sig-mods] li[data-kind=annotation_added][data-allowed=false]')).toHaveCount(1);

      // "View signed version" opens exactly what was signed: no changes after signing there.
      await page.locator('[data-testid=sig-view-signed]').click();
      const banner3 = page.locator('[data-testid=document-view]:visible [data-testid=sig-banner]');
      await expect(banner3).toHaveAttribute('data-status', 'valid_identity_unknown');
      await expect(page.locator('[data-testid=document-view]:visible .doc-name')).toContainText(L.locale === 'ar' ? 'النسخة الموقَّعة' : 'signed version');
    });

    test('a shadow attack fixture is flagged in the banner and the panel', async ({ page }) => {
      await page.goto('/');
      await openViaCard(page, fixture('sign/attacks/shadow-replace.pdf'));
      const banner = page.locator('[data-testid=document-view]:visible [data-testid=sig-banner]');
      await expect(banner).toHaveAttribute('data-status', /invalid|modified/);
      await banner.locator('[data-testid=sig-banner-open]').click();
      await expect(page.locator('[data-testid=sig-attacks] li[data-kind=shadow_replace]')).toBeVisible();
      await expect(page.locator('[data-testid=sig-attacks]')).toContainText(L.locale === 'ar' ? 'هجوم الظل' : 'Shadow attack');
    });
  });
}
