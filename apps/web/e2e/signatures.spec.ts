import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { INVOICE, annotationTypes, chooseTool, openPdf, pageBox, test, useAction } from './helpers';

/**
 * Digital signatures through the interface: a TEST certificate file signs
 * the open file, the signature shows on the page and in PDFium's own list,
 * saving keeps the signed bytes exactly, reopening checks it, and one
 * changed byte breaks it. Nothing leaves the machine (`stayLocal`).
 */

const fixture = (name: string) => fileURLToPath(new URL(`../../../tests/fixtures/signatures/${name}`, import.meta.url));
const P12 = fixture('signer-rsa-aes.p12');
const SIGNER = 'محمد التجريبي (TEST)';

const panel = (page: Page) => page.locator('.pane-end');
const banner = (page: Page) => page.getByRole('status', { name: 'Digital signatures' });

async function save(page: Page, name: string): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click(),
  ]);
  const path = `test-results/signatures-${name}.pdf`;
  await download.saveAs(path);
  return readFileSync(path);
}

async function drag(page: Page, target: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('nothing to draw on');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

/** Signs the open file with the TEST certificate, visibly, as a person does. */
async function sign(page: Page): Promise<void> {
  await chooseTool(page, 'Digital signature');
  await panel(page).getByRole('tab', { name: 'Sign' }).click();
  await panel(page).getByLabel('Certificate file (.p12, .pfx)').setInputFiles(P12);
  await panel(page).getByLabel('Its password').fill('warraq-test');
  await panel(page).getByRole('button', { name: 'Open the certificate' }).click();
  await expect(panel(page).locator('.signature-identity')).toContainText(SIGNER);
  // Draw where it goes, then give a reason.
  const sheet = panel(page).getByTestId('signature-page');
  await drag(page, sheet, [30, 30], [200, 90]);
  const drawn = await panel(page).getByTestId('signature-box').boundingBox();
  expect(drawn?.width ?? 0).toBeGreaterThan(150);
  await panel(page).getByLabel('Reason').fill('اعتماد الفاتورة');
  await panel(page).getByRole('button', { name: `Sign as ${SIGNER}` }).click();
  await expect(panel(page).getByText('Signed. The signature is in the open file')).toBeVisible();
}

/** The signatures PDFium itself finds in the file EmbedPDF has open. */
async function pdfiumSignatures(page: Page): Promise<{ count: number; subFilter: string; reason: string }> {
  return page.evaluate(async () => {
    type Task<T> = { toPromise(): Promise<T> };
    type Registry = {
      getPlugin(id: string): { provides?: () => { getActiveDocument(): unknown } } | null;
      getEngine(): { getSignatures(doc: unknown): Task<{ subFilter: ArrayBuffer; reason: string }[]> };
    };
    const registry = await (document.querySelector('embedpdf-container') as unknown as { registry: Promise<Registry> }).registry;
    const doc = registry.getPlugin('document-manager')?.provides?.().getActiveDocument();
    const signatures = await registry.getEngine().getSignatures(doc).toPromise();
    const first = signatures[0];
    const subFilter = first ? new TextDecoder().decode(first.subFilter).replace(/\0+$/, '') : '';
    return { count: signatures.length, subFilter, reason: first?.reason ?? '' };
  });
}

const startsWith = (saved: Buffer, own: Buffer) => saved.subarray(0, own.length).equals(own);

/** Where the last signature's signed bytes end: its /ByteRange's last two numbers, added. */
function signedEnd(file: Buffer): number {
  const ranges = [...file.toString('latin1').matchAll(/\/ByteRange \[0 (\d+) (\d+) (\d+)/g)];
  const last = ranges.at(-1);
  return last ? Number(last[2]) + Number(last[3]) : -1;
}

test.describe('Digital signatures', () => {
  test('sign with a certificate file, save, reopen: it checks out, and one changed byte breaks it', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await sign(page);

    // The shell says so at once, and PDFium (EmbedPDF's engine) sees it too.
    await expect(banner(page)).toContainText(`Signed by ${SIGNER}`);
    await expect(banner(page)).toContainText('Intact, but the signer is not trusted');
    await expect.poll(() => pdfiumSignatures(page)).toEqual({ count: 1, subFilter: 'ETSI.CAdES.detached', reason: 'اعتماد الفاتورة' });

    // Saved: the file's own bytes, then the signature; saved again: the same bytes.
    const original = readFileSync(INVOICE);
    const first = await save(page, 'signed');
    expect(startsWith(first, original), 'an incremental update').toBe(true);
    expect(first.includes(Buffer.from('/ETSI.CAdES.detached'))).toBe(true);
    expect(signedEnd(first), 'nothing after the signature: the save is the signed file').toBe(first.length);
    const again = await save(page, 'signed-again');
    expect(again.equals(first), 'saving again keeps the signed bytes exactly').toBe(true);

    // Reopened, the panel checks it; trusting the TEST root makes it valid.
    await page.goto('/');
    await openPdf(page, 'test-results/signatures-signed.pdf');
    await expect(banner(page)).toContainText(`Signed by ${SIGNER}`);
    await banner(page).getByRole('button', { name: 'Signatures' }).click();
    const card = panel(page).locator('.signature-card').first();
    await expect(card).toHaveAttribute('data-status', 'untrusted');
    await expect(card).toContainText('Reason: اعتماد الفاتورة');
    await card.getByRole('button', { name: 'Trust Warraq TEST Root CA RSA' }).click();
    await expect(card).toHaveAttribute('data-status', 'valid');
    await expect(banner(page)).toContainText('Valid');
    await card.getByText('Details').click();
    await expect(card).toContainText('The signed content is unchanged');
    await expect(card).toContainText('Trusted: Warraq TEST Root CA RSA (trusted by you on this device)');

    // One byte of the signed part changed (in the binary comment of the
    // header, which every reader ignores): the signature no longer holds.
    const tampered = Buffer.from(first);
    const at = tampered.indexOf('\n%') + 2;
    tampered[at] = tampered[at] === 0xe2 ? 0xe3 : 0xe2;
    writeFileSync('test-results/signatures-tampered.pdf', tampered);
    await page.goto('/');
    await openPdf(page, 'test-results/signatures-tampered.pdf');
    await expect(banner(page)).toContainText('Invalid');
    await banner(page).getByRole('button', { name: 'Signatures' }).click();
    await expect(panel(page).locator('.signature-card').first()).toHaveAttribute('data-status', 'invalid');
  });

  test('a comment added after signing is appended, and listed as permitted', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await sign(page);
    const signed = await save(page, 'before-comment');

    await chooseTool(page, 'Comment');
    await useAction(page, 'Draw');
    const box = await pageBox(page);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => annotationTypes(page)).toContain(15);
    const commented = await save(page, 'commented');
    expect(startsWith(commented, signed), 'the signed bytes stay the prefix').toBe(true);

    await page.goto('/');
    await openPdf(page, 'test-results/signatures-commented.pdf');
    await chooseTool(page, 'Digital signature');
    const card = panel(page).locator('.signature-card').first();
    await expect(card).toHaveAttribute('data-status', 'untrusted');
    await expect(card).toContainText('Comments added, changed or removed — permitted');

    // Page changes would break it: the shell says so before any is made.
    await chooseTool(page, 'Organize pages');
    await expect(page.getByRole('alert')).toContainText('Changing its pages will show the signatures as changed after signing');
  });

  test('the browser build says why it cannot timestamp, and sends nothing', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await chooseTool(page, 'Digital signature');
    await panel(page).getByRole('tab', { name: 'Sign' }).click();
    await expect(panel(page)).toContainText('Trusted timestamps are added by the desktop app');
    await expect(panel(page).getByLabel('Add a trusted timestamp')).toHaveCount(0);
    // A wrong password is named as such.
    await panel(page).getByLabel('Certificate file (.p12, .pfx)').setInputFiles(P12);
    await panel(page).getByLabel('Its password').fill('not it');
    await panel(page).getByRole('button', { name: 'Open the certificate' }).click();
    await expect(panel(page).getByRole('alert')).toContainText('password is wrong');
  });
});
