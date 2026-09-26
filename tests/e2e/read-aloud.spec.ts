/**
 * Read aloud (local text-to-speech) through the real interface, English and Arabic. The browser's
 * `speechSynthesis` is replaced by a recording fake that exposes two on-device voices (Arabic and
 * English) plus network voices that must never be used. Utterances are released one by one so the
 * spec can check the reading order, the voice per language, the highlight on the page, pause /
 * resume / next, speed, keyboard shortcuts, and that nothing leaves the device or edits the file.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { fixture, openViaCard, pageBox, trackExternalRequests } from './helpers';

interface Spoken {
  text: string;
  voice: string | null;
  lang: string;
  rate: number;
}

type FakeVoice = { name: string; lang: string; localService: boolean; voiceURI: string; default: boolean };

const LOCAL: FakeVoice[] = [
  { name: 'Maged', lang: 'ar-SA', localService: true, voiceURI: 'local-ar', default: false },
  { name: 'Samantha', lang: 'en-US', localService: true, voiceURI: 'local-en', default: true },
];
// Ranked above the local ones if they were ever considered (Premium), so using them would show.
const NETWORK: FakeVoice[] = [
  { name: 'Google US English', lang: 'en-US', localService: false, voiceURI: 'net-en', default: false },
  { name: 'Cloud Voice (Premium)', lang: 'ar-SA', localService: false, voiceURI: 'net-ar', default: false },
  { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', localService: false, voiceURI: 'net-en-2', default: false },
];

async function installFakeSpeech(context: BrowserContext, voices: FakeVoice[]): Promise<void> {
  await context.addInitScript((list: FakeVoice[]) => {
    type U = {
      text: string;
      voice: FakeVoice | null;
      lang: string;
      rate: number;
      pitch: number;
      onstart?: () => void;
      onend?: () => void;
      onerror?: (e: { error: string }) => void;
    };
    const events = new EventTarget();
    const state = { spoken: [] as Spoken[], current: null as U | null, cancels: 0 };
    const finish = () => {
      const u = state.current;
      state.current = null;
      u?.onend?.();
    };
    const synth = {
      speaking: false,
      pending: false,
      paused: false,
      getVoices: () => list.map((v) => ({ ...v })),
      speak(u: U) {
        state.spoken.push({ text: u.text, voice: u.voice ? u.voice.voiceURI : null, lang: u.lang, rate: u.rate });
        state.current = u;
        setTimeout(() => state.current === u && u.onstart?.(), 0);
      },
      cancel() {
        state.cancels++;
        const u = state.current;
        state.current = null;
        // Like Chrome: the cancelled utterance reports "interrupted".
        if (u) setTimeout(() => u.onerror?.({ error: 'interrupted' }), 0);
      },
      pause() {},
      resume() {},
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      onvoiceschanged: null,
    };
    class FakeUtterance {
      voice = null;
      lang = '';
      rate = 1;
      pitch = 1;
      constructor(public text: string) {}
    }
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true });
    (window as unknown as { __speech: unknown }).__speech = { state, finish };
  }, voices);
}

async function setup(browser: Browser, locale: 'en' | 'ar', voices: FakeVoice[] = [...NETWORK, ...LOCAL]): Promise<{ page: Page; external: string[] }> {
  const context = await browser.newContext({ locale: locale === 'ar' ? 'ar-SA' : 'en-US' });
  await installFakeSpeech(context, voices);
  const page = await context.newPage();
  const external = trackExternalRequests(page);
  await page.goto('/');
  return { page, external };
}

const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __speech: { state: { spoken: Spoken[] } } }).__speech.state.spoken);
const cancels = (page: Page) => page.evaluate(() => (window as unknown as { __speech: { state: { cancels: number } } }).__speech.state.cancels);
/** Ends the utterance being spoken (the fake never ends one by itself). */
const finish = (page: Page) => page.evaluate(() => (window as unknown as { __speech: { finish(): void } }).__speech.finish());

async function expectSpoken(page: Page, n: number, text: string, voice: string) {
  await expect.poll(async () => (await spoken(page)).length).toBe(n);
  const last = (await spoken(page))[n - 1]!;
  expect(last.text).toBe(text);
  expect(last.voice).toBe(voice);
}

/** The highlight's top edge as a fraction of the page height. */
async function highlightTop(page: Page, pageIndex: number): Promise<number> {
  const mark = page.locator(`[data-testid=reading-highlight][data-page="${pageIndex}"]`).first();
  await expect(mark).toBeVisible();
  const m = (await mark.boundingBox())!;
  const p = await pageBox(page, 0);
  return (m.y + 1 - p.y) / p.height;
}

/** The highlight's left edge as a fraction of the page width (page 1 on screen). */
async function highlightLeft(page: Page): Promise<number> {
  const m = (await page.locator('[data-testid=reading-highlight][data-page="0"]').first().boundingBox())!;
  const p = await pageBox(page, 0);
  return (m.x + 2 - p.x) / p.width;
}

// Page 1 of the fixture (A4, 841.89 pt): heading y≈77, Arabic ≈132, English ≈166, mixed ≈200.
const A4 = 841.89;

const TEXT = {
  heading: 'دليل القراءة',
  arabic: 'مرحبًا بك، هذه فقرةٌ عربية تُقرأ بصوتٍ عربي.',
  english: 'This paragraph is written in English and uses the English voice.',
  mixedAr1: 'ينطق التطبيق عبارة',
  mixedEn: 'Read Aloud Mode',
  mixedAr2: 'بصوت إنجليزي ثم يكمل بالعربية.',
  page2: 'Second page',
  page2Ar: 'هذه الفقرة الأخيرة في الصفحة الثانية.',
};

for (const locale of ['en', 'ar'] as const) {
  test.describe(`Read aloud (${locale})`, () => {
    test('reads paragraphs in order with an Arabic or English local voice, highlights and follows them; pause, resume, next, speed, shortcuts', async ({ browser }) => {
      const { page, external } = await setup(browser, locale);
      await openViaCard(page, fixture('read-aloud.pdf'));
      const view = page.locator('[data-testid=document-view]:visible');
      const button = view.locator('[data-testid=read-aloud]');
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute('aria-label', locale === 'ar' ? 'القراءة بصوت عالٍ' : 'Read aloud');
      await button.click();
      const player = view.locator('[data-testid=read-aloud-player]');
      await expect(player).toBeVisible();

      // 1. Arabic heading, Arabic voice; tatweel stripped, tashkeel kept.
      await expectSpoken(page, 1, TEXT.heading, 'local-ar');
      await expect(player).toHaveAttribute('data-status', 'playing');
      await expect(view.locator('[data-testid=read-aloud-status]')).toHaveText(locale === 'ar' ? 'الفقرة ١ من ٦' : 'Paragraph 1 of 6');
      expect(Math.abs((await highlightTop(page, 0)) - 76.8 / A4)).toBeLessThan(0.012);
      // Horizontally too: the Arabic heading is right-aligned (x 408–528 of 595 pt).
      expect(Math.abs((await highlightLeft(page)) - 408 / 595.28)).toBeLessThan(0.02);

      await finish(page);
      await expectSpoken(page, 2, TEXT.arabic, 'local-ar');
      await expect.poll(() => highlightTop(page, 0)).toBeGreaterThan(125 / A4);
      expect(Math.abs((await highlightTop(page, 0)) - 131.94 / A4)).toBeLessThan(0.012);

      // 2. English paragraph, English voice; the highlight moves down to it.
      await finish(page);
      await expectSpoken(page, 3, TEXT.english, 'local-en');
      await expect.poll(() => highlightTop(page, 0)).toBeGreaterThan(160 / A4);
      await expect(view.locator('[data-testid=read-aloud-status]')).toHaveText(locale === 'ar' ? 'الفقرة ٣ من ٦' : 'Paragraph 3 of 6');

      // 3. Pause cancels the utterance; resume repeats the sentence.
      const c0 = await cancels(page);
      await view.locator('[data-testid=read-aloud-toggle]').click();
      await expect(player).toHaveAttribute('data-status', 'paused');
      expect(await cancels(page)).toBeGreaterThan(c0);
      await view.locator('[data-testid=read-aloud-toggle]').click();
      await expect(player).toHaveAttribute('data-status', 'playing');
      await expectSpoken(page, 4, TEXT.english, 'local-en');

      // 4. Speed: remembered on the device and used from the next sentence.
      await view.locator('[data-testid=read-aloud-rate]').selectOption('1.5');
      await expectSpoken(page, 5, TEXT.english, 'local-en');
      expect((await spoken(page))[4]!.rate).toBe(1.5);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zood.readAloud') ?? '{}').rate)).toBe(1.5);

      // 5. Next paragraph: the mixed one, split into Arabic / English / Arabic runs.
      await view.locator('[data-testid=read-aloud-next]').click();
      await expectSpoken(page, 6, TEXT.mixedAr1, 'local-ar');
      await finish(page);
      await expectSpoken(page, 7, TEXT.mixedEn, 'local-en');
      await finish(page);
      await expectSpoken(page, 8, TEXT.mixedAr2, 'local-ar');

      // 6. On to page 2: the view follows and the highlight is on the second page.
      await finish(page);
      await expectSpoken(page, 9, TEXT.page2, 'local-en');
      await expect(page.locator('[data-testid=reading-highlight][data-page="1"]')).toBeVisible();
      await expect(view.locator('[data-testid=doc-status]')).toHaveText(locale === 'ar' ? /صفحة ٢ من ٢/ : /Page 2 of 2/);

      // 7. Keyboard: Alt+Shift+P pauses, Alt+Shift+B goes back a paragraph.
      await page.keyboard.press('Alt+Shift+KeyP');
      await expect(player).toHaveAttribute('data-status', 'paused');
      await page.keyboard.press('Alt+Shift+KeyB');
      await expectSpoken(page, 10, TEXT.mixedAr1, 'local-ar');
      await expect(player).toHaveAttribute('data-status', 'playing');

      // Never a network voice, never without a voice.
      const all = await spoken(page);
      expect(all.every((s) => s.voice === 'local-ar' || s.voice === 'local-en')).toBe(true);

      // 8. Voice picker: one per language, only local voices, with the Siri note.
      await view.locator('[data-testid=read-aloud-voices-toggle]').click();
      const voices = view.locator('[data-testid=read-aloud-voices]');
      await expect(voices.locator('select')).toHaveCount(2);
      const options = await voices.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
      expect(options.sort()).toEqual(['local-ar', 'local-en']);
      await expect(voices).toContainText('Siri');

      // 9. Close: speech stops and the highlight goes away. Reading never edits the document.
      await view.locator('[data-testid=read-aloud-close]').click();
      await expect(player).toHaveCount(0);
      await expect(page.locator('[data-testid=reading-highlight]')).toHaveCount(0);
      await expect(view.locator('[data-testid=doc-status]')).not.toContainText(/Edited|معدَّل/);

      // 10. Starting again reads from the page on screen (page 2 after "Next page"), via Alt+Shift+R.
      await view.locator('.tb-nav button').nth(1).click();
      await expect(view.locator('[data-testid=doc-status]')).toHaveText(locale === 'ar' ? /صفحة ٢ من ٢/ : /Page 2 of 2/);
      const before = (await spoken(page)).length;
      await page.keyboard.press('Alt+Shift+KeyR');
      await expect(player).toBeVisible();
      await expectSpoken(page, before + 1, TEXT.page2, 'local-en');
      expect(external).toEqual([]);
      await page.context().close();
    });
  });
}

test('no on-device voice: the Read aloud control is not shown', async ({ browser }) => {
  const { page } = await setup(browser, 'en', NETWORK);
  await openViaCard(page, fixture('read-aloud.pdf'));
  const view = page.locator('[data-testid=document-view]:visible');
  await expect(view.locator('[data-testid=tool-picker]')).toBeEnabled();
  // The web backend waits up to 1.5 s for voices to load before giving up.
  await page.waitForTimeout(2500);
  await expect(view.locator('[data-testid=read-aloud]')).toHaveCount(0);
  await page.context().close();
});

test('Arabic document with no Arabic voice says so and never reads Arabic with another voice', async ({ browser }) => {
  const { page } = await setup(browser, 'ar', [...NETWORK, LOCAL[1]!]);
  await openViaCard(page, fixture('sample-ar.pdf'));
  const view = page.locator('[data-testid=document-view]:visible');
  await view.locator('[data-testid=read-aloud]').click();
  await expect(view.locator('[data-testid=read-aloud-missing]')).toContainText('العربية');
  // Only the Latin run ("PDF") may be spoken, with the English voice; no Arabic text is spoken at all.
  const all = await spoken(page);
  expect(all.every((s) => s.voice === 'local-en' && !/[\u0621-\u064A]/.test(s.text))).toBe(true);
  await page.context().close();
});
