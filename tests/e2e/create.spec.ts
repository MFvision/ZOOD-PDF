import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { ENGINE_BUILT, fixture, fixtureBytes, latin1, openViaCard, savedFiles, stubSavePicker, trackExternalRequests, waitForDocument } from './helpers';

test.describe('Create PDF', () => {
  test.skip(!ENGINE_BUILT, 'needs the warraq-core engine (create.fromFiles)');

  test('DOCX + pictures → one PDF that opens unsaved and saves through the host', async ({ context, page }) => {
    await stubSavePicker(context);
    const external = trackExternalRequests(page);
    await page.goto('/');
    await page.locator('[data-card=create]').click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-testid=create-choose]').click()]);
    await chooser.setFiles([fixture('create/report.docx'), fixture('create/photo.jpg'), fixture('create/scan.tif')]);
    const list = page.locator('[data-testid=create-list] li');
    await expect(list).toHaveCount(3);
    // Reorder: move the TIFF above the JPEG.
    await list.nth(2).getByRole('button', { name: /up/i }).click();
    await expect(list.nth(1)).toHaveAttribute('data-name', 'scan.tif');
    await page.locator('[data-testid=create-page-numbers]').check();
    await page.locator('[data-testid=create-run]').click();
    await waitForDocument(page);
    const status = page.locator('[data-testid=document-view]:visible [data-testid=doc-status]');
    // DOCX 2 pages + TIFF 3 + JPEG 1; new documents are unsaved.
    await expect(status).toContainText('of 6');
    await expect(status).toContainText('Edited');
    await expect(page.locator('.doc-name')).toHaveText('report.pdf');
    await page.locator('[data-testid=document-view]:visible [data-testid=save]').click();
    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [saved] = await savedFiles(page);
    expect(saved!.name).toBe('report.pdf');
    expect(latin1(saved!.bytes.subarray(0, 5))).toBe('%PDF-');
    expect(latin1(saved!.bytes)).toContain('/StructTreeRoot');
    expect(external).toEqual([]);
  });

  test('Arabic UI, unsupported file is refused, Markdown converts', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('zood.locale', 'ar'));
    await page.goto('/');
    await page.locator('[data-card=create]').click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-testid=create-choose]').click()]);
    await chooser.setFiles([
      { name: 'guide.md', mimeType: 'text/markdown', buffer: fixtureBytes('create/guide.md') },
      { name: 'old.doc', mimeType: 'application/msword', buffer: Buffer.from('not supported') },
    ]);
    await expect(page.locator('[data-testid=create-list] li')).toHaveCount(1);
    await page.locator('[data-testid=create-run]').click();
    await waitForDocument(page);
    await expect(page.locator('.doc-name')).toHaveText('guide.pdf');
  });

  test('a Word file dropped on an open PDF goes to Create PDF, not Combine', async ({ page }) => {
    await page.goto('/');
    await openViaCard(page, fixture('sample-en.pdf'));
    const b64 = fs.readFileSync(fixture('create/report.docx')).toString('base64');
    const dt = await page.evaluateHandle((data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const t = new DataTransfer();
      t.items.add(new File([bytes], 'report.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
      return t;
    }, b64);
    const vw = page.viewportSize()!;
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      await page.dispatchEvent('.docview:not([hidden])', type, { dataTransfer: dt, clientX: vw.width * 0.25, clientY: vw.height / 2 });
    }
    await expect(page.locator('[data-testid=create-list] li')).toHaveCount(1);
    await expect(page.locator('[data-testid=create-list] li').first()).toHaveAttribute('data-name', 'report.docx');
    // The open document is untouched (no combine happened).
    await expect(page.locator('[data-testid=document-view]:visible [data-testid=doc-status]')).not.toContainText('Edited');
  });
});
