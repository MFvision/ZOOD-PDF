import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, corpus, documentStatus, enterEditText, openPdf, test } from './helpers';

/** A file of `tests/fixtures/create`, written by its `make_fixtures.py`. */
const fixture = (name: string) => fileURLToPath(new URL(`../../../tests/fixtures/create/${name}`, import.meta.url));

const panel = (page: Page) => page.locator('.pane-end');
const outcome = (page: Page) => panel(page).locator('[role="status"]').last();

/** The corpus's own truth for the page both files hold. */
const TRUTH = readFileSync(
  fileURLToPath(new URL('../../../tests/corpus/arabic/truth/scan-notonaskh-300dpi-skewed-jpeg.txt', import.meta.url)),
  'utf8',
);

/** Arabic words a person would search for, none of them carrying diacritics. */
const WORDS = ['الحروف', 'البرنامج', 'العربية'];

/** How much of the truth's Arabic a text holds, scored as `ocr.spec.ts` scores it. */
function share(text: string): number {
  const words = [...new Set(TRUTH.split(/[\s|:،.()—؟]+/).filter((word) => /[؀-ۿ]/.test(word) && word.length >= 3))];
  return words.filter((word) => text.includes(word)).length / words.length;
}

/** Reads the page with Warraq's own reader — the text `ingest.ts` hands to `library.add`. */
async function recognizeAndRead(page: Page, cleanup: readonly string[] = []): Promise<string> {
  await chooseTool(page, 'Scan & OCR');
  for (const step of ['Remove shadows and stains', 'Strengthen the contrast', 'Black and white', 'Remove specks', 'Remove dark borders']) {
    await panel(page).getByRole('checkbox', { name: step }).setChecked(cleanup.includes(step));
  }
  await panel(page).getByRole('button', { name: 'Recognize text', exact: true }).click();
  await expect(outcome(page)).toContainText('Text layer added', { timeout: 240_000 });
  const first = await enterEditText(page);
  return ((await first.locator('.text-layer').textContent()) ?? '').replace(/\s+/g, ' ');
}

/**
 * What the Library does with a file that holds no text of its own.
 *
 * A scanned PDF goes through Scan & OCR — the same `ocr/run.ts` and
 * `ocr/cleanup.ts` the tool uses, reached through the `readPagesWith` this
 * part added, not a copy of them. A picture is made a page first by Create
 * PDF's `create.images`, and then read exactly as the scan is. Both paths
 * are proven here in a real browser, on a scanned Arabic page and on a
 * photograph of one: the words a search must find really are read off them.
 *
 * Holding those words and answering a search over them are the core's
 * (`library.*`) and the panel's; their spec comes with those.
 */
test.describe('the Library reads Arabic off a scan and off a photograph', () => {
  test.setTimeout(300_000);

  test('a scanned Arabic page is read word for word', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    await openPdf(page, corpus('generated/scan-notonaskh-300dpi-skewed-jpeg.pdf'));
    const text = await recognizeAndRead(page);
    // Measured 94 % of the truth's words; the Library puts exactly this in the index.
    expect(share(text)).toBeGreaterThan(0.85);
    for (const word of WORDS) expect(text, word).toContain(word);
  });

  test('a photograph of an Arabic page, shadow and all, is read too', async ({ page, stayLocal: _ }) => {
    await page.goto('/');
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Create PDF…' }).click(),
    ]);
    // A picture becomes a page through `create.images` — the Library's own first step for one.
    await chooser.setFiles([fixture('photo-arabic.jpg')]);
    await expect(panel(page).getByRole('status').first()).toHaveText(/^Made “.+\.pdf”\.$/, { timeout: 120_000 });
    await expect(documentStatus(page)).toContainText(/Page 1 of \d+/, { timeout: 60_000 });

    // Exactly `LIBRARY_CLEANUP`: what the Library cleans a photograph up with.
    const text = await recognizeAndRead(page, ['Remove shadows and stains', 'Strengthen the contrast']);
    // Measured 93 % of the page's words this way, against 13 % with no cleanup at all.
    expect(share(text)).toBeGreaterThan(0.85);
    for (const word of WORDS) expect(text, word).toContain(word);
  });
});
