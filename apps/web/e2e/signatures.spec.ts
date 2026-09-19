import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { INVOICE, annotationTypes, chooseTool, corpus, embedDocument, openPdf, pageBox, test, useAction } from './helpers';
import { callOn, core } from './pdfBytes';

/**
 * Digital signatures through the interface: a TEST certificate file signs
 * the open file, the signature shows on the page and in PDFium's own list,
 * saving keeps the signed bytes exactly, reopening checks it, and one
 * changed byte breaks it. Nothing leaves the machine (`stayLocal`).
 */

const fixture = (name: string) => fileURLToPath(new URL(`../../../tests/fixtures/signatures/${name}`, import.meta.url));
const P12 = fixture('signer-rsa-aes.p12');
/** Four layers, the watermark off (tests/fixtures/layers/make.py). */
const LAYERS = fileURLToPath(new URL('../../../tests/fixtures/layers/layers.pdf', import.meta.url));
const SIGNER = 'محمد التجريبي (TEST)';
/** A name as the interface puts it into a sentence: isolated (FSI … PDI), so it keeps its own direction. */
const iso = (name: string) => `\u2068${name}\u2069`;

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

/** Opens the Sign tab with the TEST certificate file, as a person does. */
async function openCertificate(page: Page): Promise<void> {
  await chooseTool(page, 'Digital signature');
  await panel(page).getByRole('tab', { name: 'Sign' }).click();
  await panel(page).getByLabel('Certificate file (.p12, .pfx)').setInputFiles(P12);
  await panel(page).getByLabel('Its password').fill('warraq-test');
  await panel(page).getByRole('button', { name: 'Open the certificate' }).click();
  await expect(panel(page).locator('.signature-identity')).toContainText(SIGNER);
}

/** Signs the open file with the TEST certificate, visibly, as a person does. */
async function sign(page: Page): Promise<void> {
  await openCertificate(page);
  // Draw where it goes, then give a reason.
  const sheet = panel(page).getByTestId('signature-page');
  await drag(page, sheet, [30, 30], [200, 90]);
  const drawn = await panel(page).getByTestId('signature-box').boundingBox();
  expect(drawn?.width ?? 0).toBeGreaterThan(150);
  await panel(page).getByLabel('Reason').fill('اعتماد الفاتورة');
  await panel(page).getByRole('button', { name: `Sign as ${iso(SIGNER)}` }).click();
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
    await expect(banner(page)).toContainText(`Signed by ${iso(SIGNER)}`);
    await expect(banner(page)).toContainText("Intact — the signer's identity is not verified");
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
    await expect(banner(page)).toContainText(`Signed by ${iso(SIGNER)}`);
    await banner(page).getByRole('button', { name: 'Signatures' }).click();
    const card = panel(page).locator('.signature-card').first();
    await expect(card).toHaveAttribute('data-status', 'untrusted');
    await expect(card).toContainText(`Reason: ${iso('اعتماد الفاتورة')}`);
    await card.getByRole('button', { name: `Trust ${iso('Warraq TEST Root CA RSA')}` }).click();
    await expect(card).toHaveAttribute('data-status', 'valid');
    await expect(banner(page)).toContainText('Valid');
    await card.getByText('Details').click();
    await expect(card).toContainText('The signed content is unchanged');
    await expect(card).toContainText(`Trusted: ${iso('Warraq TEST Root CA RSA')} (trusted by you on this device)`);
    // The inspector closed (its tool still chosen): the banner offers the list again.
    await expect(banner(page).getByRole('button', { name: 'Signatures' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Tools pane' }).click();
    await expect(banner(page).getByRole('button', { name: 'Signatures' })).toBeVisible();

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
    const broken = panel(page).locator('.signature-card').first();
    await expect(broken).toHaveAttribute('data-status', 'invalid');
    // Said, not only marked: the failed check reads as a failure.
    await expect(broken).toContainText('The signed content has changed since it was signed.');
    await broken.getByText('Details').click();
    await expect(broken.locator('.signature-checks')).toContainText('The signed content has changed');
    await expect(broken.locator('.signature-checks')).not.toContainText('The signed content is unchanged');
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

    // Page changes would break it: the shell says so before any is made —
    // for page marks as for Organize pages.
    await chooseTool(page, 'Organize pages');
    await expect(page.getByRole('alert')).toContainText('Changing its pages will show the signatures as changed after signing');
    await chooseTool(page, 'Page marks');
    await expect(page.getByRole('alert')).toContainText('Changing its pages will show the signatures as changed after signing');
  });

  test('the signature lands in the file where it was drawn on the preview', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, INVOICE);
    await openCertificate(page);
    // Near the right edge of the page, at the inspector's own width.
    const sheet = panel(page).getByTestId('signature-page');
    const preview = await sheet.boundingBox();
    if (!preview) throw new Error('no preview');
    await drag(page, sheet, [preview.width * 0.55, 40], [preview.width * 0.97, 100]);
    await panel(page).getByRole('button', { name: `Sign as ${iso(SIGNER)}` }).click();
    await expect(panel(page).getByText('Signed. The signature is in the open file')).toBeVisible();
    const saved = (await save(page, 'placed')).toString('latin1');
    const found = /\/FT \/Sig \/T \([^)]*\) \/F \d+ \/Rect \[([-\d. ]+)\]/.exec(saved);
    expect(found, 'the signature widget').not.toBeNull();
    const [x0 = 0, , x1 = 0] = (found?.[1] ?? '').split(' ').map(Number);
    // The page is 595.28 points wide: within five points of where it was drawn.
    expect(x0).toBeCloseTo(595.28 * 0.55, -1);
    expect(x1).toBeCloseTo(595.28 * 0.97, -1);
  });

  test("an unsigned form's empty signature field is offered, and signed into visibly", async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, fixture('empty-signature-field.pdf'));
    await openCertificate(page);
    const field = panel(page).getByLabel('Signature field');
    await expect(field).toBeVisible();
    await field.selectOption('التوقيع');
    await panel(page).getByRole('button', { name: `Sign as ${iso(SIGNER)}` }).click();
    await expect(panel(page).getByText('Signed. The signature is in the open file')).toBeVisible();
    await save(page, 'field');

    await page.goto('/');
    await openPdf(page, 'test-results/signatures-field.pdf');
    await chooseTool(page, 'Digital signature');
    const card = panel(page).locator('.signature-card').first();
    await expect(card).toHaveAttribute('aria-label', 'التوقيع');
    await expect(card).toContainText('on page 1');
    await expect.poll(() => pdfiumSignatures(page).then((s) => s.count)).toBe(1);
    await expect(panel(page)).not.toContainText('Empty signature fields');
  });

  test("saving a certified Arabic form leaves the appearances its own program drew", async ({ page, stayLocal: _ }) => {
    // A form whose Arabic values pdf-lib drew, certified "no changes" by
    // signing software that never let Warraq redraw them.
    const { call_static } = await core();
    const form = readFileSync(corpus('generated/acroform-pdflib-arabic-fields.pdf'));
    const signed = call_static(
      'signatures.sign',
      JSON.stringify({ p12Password: 'warraq-test', time: Math.floor(Date.now() / 1000), certify: 1 }),
      [new Uint8Array(form), new Uint8Array(readFileSync(P12))],
    ).blobs[0];
    if (!signed) throw new Error('not signed');
    writeFileSync('test-results/signatures-certified-form.pdf', signed);

    await page.goto('/');
    await openPdf(page, 'test-results/signatures-certified-form.pdf');
    await expect(banner(page)).toContainText(`Certified by ${iso(SIGNER)}`);
    // Saved with nothing done: the file as it was signed, byte for byte —
    // no Arabic appearance redrawn after the certification.
    const saved = await save(page, 'certified-form-saved');
    expect(saved.equals(Buffer.from(signed)), 'nothing appended after the certification').toBe(true);
    await page.goto('/');
    await openPdf(page, 'test-results/signatures-certified-form-saved.pdf');
    await expect(banner(page)).toContainText(`Certified by ${iso(SIGNER)}`);
    await expect(banner(page)).not.toContainText('Changed after signing');
  });

  test('layers shown by choice are neither signed nor checked as the file', async ({ page, stayLocal: _ }) => {
    const showWatermark = async () => {
      await page.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'Layers', exact: true }).click();
      const before = (await embedDocument(page)).id;
      await page
        .getByRole('complementary', { name: 'Navigation' })
        .getByRole('tree', { name: 'Layers' })
        .getByRole('checkbox', { name: 'Watermark', exact: false })
        .check();
      await expect.poll(async () => (await embedDocument(page)).id).not.toBe(before);
    };
    await page.goto('/');
    await openPdf(page, LAYERS);
    // The watermark shown in the view only, then the file signed.
    await showWatermark();
    await sign(page);
    await expect(banner(page)).toContainText("Intact — the signer's identity is not verified");
    await save(page, 'layers');
    // The signature covers the file's own visibility, and nothing follows it.
    const { result } = await callOn<{ layers: { name: string; visible: boolean }[] }>('layers.list', 'test-results/signatures-layers.pdf');
    expect(result.layers.find((l) => l.name === 'Watermark')?.visible).toBe(false);
    const saved = readFileSync('test-results/signatures-layers.pdf');
    expect(signedEnd(saved), 'nothing after the signature').toBe(saved.length);

    // Reopened, with the watermark shown by choice again: still not changed after signing.
    await page.goto('/');
    await openPdf(page, 'test-results/signatures-layers.pdf');
    await expect(banner(page)).toContainText("Intact — the signer's identity is not verified");
    await showWatermark();
    await expect(banner(page)).toContainText("Intact — the signer's identity is not verified");
    await expect(banner(page)).not.toContainText('Changed after signing');
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
