import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { INVOICE, WORD_EXPORT, embedPage, enterEditText, openPdf, test } from './helpers';

/**
 * Read aloud, driven from the toolbar, with the browser's speech faked in
 * the page: the voices are two of the system's kind (Arabic and English),
 * each utterance ends a moment after it starts, and every utterance is
 * recorded, so the test can check what was read, in which order, with which
 * voice, and what was marked on the page meanwhile.
 */

interface Spoken {
  text: string;
  voice: string | null;
  lang: string;
  rate: number;
}

async function installSpeech(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const voices = [
      { voiceURI: 'uri:Maged', name: 'Maged', lang: 'ar-SA', localService: true, default: false },
      { voiceURI: 'uri:Ava', name: 'Ava (Premium)', lang: 'en-US', localService: true, default: false },
      { voiceURI: 'uri:Cloud', name: 'Cloud voice', lang: 'en-US', localService: false, default: false },
    ];
    const spoken: Spoken[] = [];
    let paused = false;
    let pending: (() => void) | null = null;
    class Utterance {
      text: string;
      lang = '';
      rate = 1;
      voice: { voiceURI: string; name: string } | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    const synth = {
      paused: false,
      getVoices: () => voices,
      speak: (utterance: Utterance) => {
        spoken.push({ text: utterance.text, voice: utterance.voice?.name ?? null, lang: utterance.lang, rate: utterance.rate });
        const end = () => {
          if (paused) {
            pending = end;
            return;
          }
          pending = null;
          utterance.onend?.();
        };
        setTimeout(end, 120);
      },
      cancel: () => {
        pending = null;
      },
      pause: () => {
        paused = true;
        synth.paused = true;
      },
      resume: () => {
        paused = false;
        synth.paused = false;
        pending?.();
      },
      addEventListener: () => {},
    };
    Object.defineProperty(globalThis, 'speechSynthesis', { value: synth, configurable: true });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
    (globalThis as unknown as { __spoken: Spoken[] }).__spoken = spoken;
  });
}

const spoken = (page: Page) => page.evaluate(() => (globalThis as unknown as { __spoken: Spoken[] }).__spoken);
const bar = (page: Page) => page.getByRole('region', { name: 'Read aloud' });

async function readWithWarraq(file: string): Promise<string[]> {
  const root = new URL('../../../packages/ui/src/core-wasm/', import.meta.url);
  const core = await import(new URL('warraq_core.js', root).href);
  await core.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', root)) });
  const doc = core.Document.open(new Uint8Array(readFileSync(file)));
  try {
    return Array.from({ length: doc.page_count() as number }, (_, index) => doc.extract_text(index) as string);
  } finally {
    doc.free();
  }
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

test.describe('read aloud', () => {
  test('reads the page in logical order with the Arabic voice, marks each sentence on the page, pauses, resumes and stops', async ({ page, stayLocal: _ }) => {
    await installSpeech(page);
    await page.goto('/');
    await openPdf(page, INVOICE);
    await page.getByRole('toolbar').getByRole('button', { name: 'Read aloud' }).click();
    await expect(bar(page)).toBeVisible();
    // The system's local voices, and none that is not local.
    const arabic = bar(page).getByLabel('Arabic voice');
    await expect(arabic.locator('option')).toHaveText(['Best installed', 'Maged']);
    await expect(bar(page).getByLabel('English voice').locator('option')).toHaveText(['Best installed', 'Ava (Premium)']);

    await bar(page).getByRole('button', { name: 'This page' }).click();
    await expect(bar(page)).toContainText('Reading page 1…');
    // The sentence being read is marked over EmbedPDF's page.
    const marks = page.locator('.read-aloud-embed span');
    await expect(marks.first()).toBeVisible();
    const box = await marks.first().boundingBox();
    expect(box!.width).toBeGreaterThan(5);
    expect(box!.height).toBeGreaterThan(3);

    await bar(page).getByRole('button', { name: 'Pause' }).click();
    expect(await page.evaluate(() => (globalThis.speechSynthesis as unknown as { paused: boolean }).paused)).toBe(true);
    const before = (await spoken(page)).length;
    await page.waitForTimeout(400);
    expect((await spoken(page)).length).toBe(before);
    await bar(page).getByRole('button', { name: 'Resume' }).click();
    await expect.poll(async () => (await spoken(page)).length).toBeGreaterThan(before);

    await bar(page).getByRole('button', { name: 'Stop' }).click();
    await expect(marks).toHaveCount(0);
    await expect(bar(page)).not.toContainText('Reading page');

    // What was read: the page's text, sentence by sentence, in the order Warraq reads it, in the Arabic voice.
    const [pageText] = await readWithWarraq(INVOICE);
    const said = await spoken(page);
    expect(said.length).toBeGreaterThan(1);
    const whole = squash(pageText!);
    let at = 0;
    for (const utterance of said) {
      const index = whole.indexOf(squash(utterance.text), at);
      expect(index, `"${utterance.text}" is read in order`).toBeGreaterThanOrEqual(at);
      at = index;
    }
    expect(said.find((u) => /[؀-ۿ]/.test(u.text))?.voice).toBe('Maged');
    expect(said[0]!.rate).toBe(1);
  });

  test('marks the sentence in Edit text too, and goes on to the next page for the whole document', async ({ page, stayLocal: _ }) => {
    await installSpeech(page);
    await page.goto('/');
    await openPdf(page, WORD_EXPORT);
    await page.getByRole('toolbar').getByRole('button', { name: 'Read aloud' }).click();
    await bar(page).getByLabel('Speed').selectOption('1.5');
    await bar(page).getByRole('button', { name: 'From here to the end' }).click();
    await expect(bar(page)).toContainText('Reading page 1…');
    await expect(bar(page)).toContainText('Reading page 2…', { timeout: 60_000 });
    await expect.poll(() => embedPage(page)).toBe(2);
    await expect(bar(page)).toContainText('Finished reading.', { timeout: 60_000 });
    const said = await spoken(page);
    expect(said.every((u) => u.rate === 1.5)).toBe(true);
    expect(said.some((u) => u.voice === 'Ava (Premium)')).toBe(true);

    // Warraq's own view: the mark is a layer of the page.
    const first = await enterEditText(page);
    await bar(page).getByRole('button', { name: 'This page' }).click();
    await expect(first.locator('.read-aloud-layer span').first()).toBeVisible();
    await bar(page).getByRole('button', { name: 'Close read aloud' }).click();
    await expect(bar(page)).toHaveCount(0);
  });
});
