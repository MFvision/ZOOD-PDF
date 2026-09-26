/** Drives the real Scan & OCR interface (used by the e2e specs and the benchmark). */
import { expect, type Page } from '@playwright/test';

export type Lang = 'ar' | 'en' | 'fa' | 'ur';

/** Opens the Scan & OCR sheet from the "+" menu (home) on the given tab. */
export async function openScanFromPlus(page: Page, tab: 'scan' | 'searchable' = 'scan'): Promise<void> {
  await page.locator('[data-testid=plus]').click();
  await page.locator('[role=menu] [role=menuitem]').filter({ hasText: /Scan & OCR|المسح والتعرّف الضوئي/ }).click();
  await page.locator(`[data-ocr-tab=${tab}]`).click();
}

/** Selects exactly `langs` in the language chips. */
export async function pickLanguages(page: Page, langs: Lang[]): Promise<void> {
  // turn the wanted ones on first (the last selected chip cannot be turned off)
  for (const l of langs) {
    const chip = page.locator(`[data-testid=ocr-langs] [data-lang=${l}]`);
    if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
  }
  for (const l of ['ar', 'en', 'fa', 'ur'] as Lang[]) {
    if (langs.includes(l)) continue;
    const chip = page.locator(`[data-testid=ocr-langs] [data-lang=${l}]`);
    if ((await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
  }
  for (const l of ['ar', 'en', 'fa', 'ur'] as Lang[]) {
    await expect(page.locator(`[data-testid=ocr-langs] [data-lang=${l}]`)).toHaveAttribute('aria-pressed', String(langs.includes(l)));
  }
}

/** Adds image files in the Scan tab and waits for each skew measurement; returns the angles. */
export async function addScanImages(page: Page, files: string[]): Promise<number[]> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-testid=scan-choose]').click()]);
  await chooser.setFiles(files);
  const angles = page.locator('[data-testid=scan-angle]');
  await expect(angles).toHaveCount(files.length, { timeout: 60_000 });
  for (let i = 0; i < files.length; i++) await expect(angles.nth(i)).not.toHaveAttribute('data-angle', '', { timeout: 120_000 });
  const out: number[] = [];
  for (let i = 0; i < files.length; i++) out.push(Number(await angles.nth(i).getAttribute('data-angle')));
  return out;
}

/** Clicks "Create PDF" and waits until the new document is open in the viewer. */
export async function createScanPdf(page: Page, timeout = 300_000): Promise<void> {
  await expect(page.locator('[data-testid=scan-create]')).toBeEnabled({ timeout: 60_000 });
  await page.locator('[data-testid=scan-create]').click();
  await expect(page.locator('[data-testid=ocr-progress]')).toBeVisible();
  await expect(page.locator('[data-testid=ocr-scan]')).toHaveCount(0, { timeout });
  const view = page.locator('[data-testid=document-view]:visible');
  await expect(view.locator('.doc-name')).toHaveText(/^(Scan|مسح ضوئي) .*\.pdf$/);
  await expect(view.locator('.viewer-loading')).toHaveCount(0, { timeout: 60_000 });
}
