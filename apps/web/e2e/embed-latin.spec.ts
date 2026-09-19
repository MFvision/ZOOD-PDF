import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, corpus, embedTiles, pageBox, test, useAction } from './helpers';

/**
 * EmbedPDF's own interface — its toolbars, menus, sidebars, dialogs and
 * loading screens — has no English in it while Warraq is in Arabic.
 *
 * Every visible text, name, tooltip and placeholder inside EmbedPDF is read
 * in each of its states, and any word in Latin script fails the test, but
 * for the document's own words (it is an Arabic file that names PDF,
 * OpenType and Google) and the names of fonts, which are names.
 */

/** Arabic, with outlines and comments, whose own text has a few Latin words. */
const FILE = corpus('generated/variant-arabic-metadata-outlines-annots.pdf');
const TRUTH = fileURLToPath(new URL('../../../tests/corpus/arabic/truth/variant-arabic-metadata-outlines-annots.txt', import.meta.url));

/** Names, not words: the standard fonts' families, as a font picker lists them. */
const FONT_NAMES = ['Helvetica', 'Courier', 'Times', 'Roman', 'Symbol', 'Zapf', 'Dingbats'];

const documentWords = new Set(readFileSync(TRUTH, 'utf8').match(/\p{Script=Latin}+/gu) ?? []);

/** Latin-script words in EmbedPDF's interface as it is on screen now: "where: text". */
async function latinOnScreen(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('embedpdf-container')?.shadowRoot;
    if (!root) return [];
    const found = new Set<string>();
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const note = (where: string, text: string | null) => {
      // A colour's code (#FF8D00) is notation, not a word.
      const words = text?.replace(/#[0-9a-f]{3,8}\b/gi, '').match(/\p{Script=Latin}{2,}/gu) ?? [];
      for (const word of words) found.add(`${word} — ${where}: ${text!.trim().slice(0, 80)}`);
    };
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (parent && !['STYLE', 'SCRIPT'].includes(parent.tagName) && shown(parent)) note(`text in <${parent.tagName.toLowerCase()}>`, node.textContent);
        return;
      }
      // A form field is named by the document (its name is the file's data,
      // "Combobox_fcacab1a" for one EmbedPDF has just made): not chrome.
      const field = node instanceof HTMLElement && node.hasAttribute('name');
      if (node instanceof Element && shown(node) && !field) {
        for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) note(`${attribute}`, node.getAttribute(attribute));
      }
      node.childNodes.forEach(walk);
    };
    walk(root);
    return [...found];
  });
}

/** Keeps what is not the document's own words or a font's name. */
const chrome = (findings: string[]) =>
  findings.filter((finding) => {
    const word = finding.split(' — ')[0]!;
    return !documentWords.has(word) && !FONT_NAMES.includes(word);
  });

test('no English in EmbedPDF while Warraq is in Arabic, in any of its states', async ({ page, stayLocal: _ }) => {
  test.setTimeout(240_000);
  const seen = new Map<string, string[]>();
  const look = async (state: string) => {
    // A frame for what the last click opened to draw.
    await page.waitForTimeout(300);
    const found = chrome(await latinOnScreen(page));
    if (found.length > 0) seen.set(state, found);
  };

  await page.goto('/');
  await page.getByRole('menubar').getByRole('combobox', { name: 'Language' }).selectOption({ label: 'العربية' });

  // Its loading screens come and go while the file opens: watched frame by
  // frame, every text on them kept.
  await page.evaluate(() => {
    const store = ((window as unknown as { __whileLoading: Set<string> }).__whileLoading = new Set());
    const tick = () => {
      const root = document.querySelector('embedpdf-container')?.shadowRoot;
      if (root) {
        const texts = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = texts.nextNode(); node; node = texts.nextNode()) {
          const text = node.textContent?.trim();
          if (text && node.parentElement?.tagName !== 'STYLE') store.add(text);
        }
      }
      if (!(window as unknown as { __loaded?: boolean }).__loaded) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('input[type="file"]').setInputFiles(FILE);
  await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
  const whileLoading = await page.evaluate(() => {
    (window as unknown as { __loaded: boolean }).__loaded = true;
    return [...(window as unknown as { __whileLoading: Set<string> }).__whileLoading];
  });
  // The loading screen was seen, and in Arabic.
  expect(whileLoading).toContain('جارٍ تشغيل محرّك العرض…');
  const loadingLatin = whileLoading.filter((text) => /\p{Script=Latin}{2,}/u.test(text));
  if (loadingLatin.length > 0) seen.set('loading', loadingLatin);

  const embed = page.locator('embedpdf-container');
  const button = (name: string) => embed.getByRole('button', { name, exact: true }).first();
  const tab = (name: string) => embed.getByRole('tablist').getByRole('button', { name, exact: true });
  const escape = () => page.keyboard.press('Escape');

  await page.getByRole('toolbar').getByRole('button', { name: 'شريط أدوات التعليق', exact: true }).click();
  await look('view');
  for (const mode of ['تعليق', 'أشكال', 'إدراج', 'نموذج', 'تنقيح', 'عرض']) {
    await tab(mode).click();
    await look(`mode ${mode}`);
  }

  for (const menu of ['قائمة المستند', 'إعدادات الصفحة']) {
    await button(menu).click();
    await look(`menu ${menu}`);
    await escape();
  }

  // A drop-down field drawn on the page, from Prepare form: the options it starts with.
  await chooseTool(page, 'إعداد نموذج');
  await useAction(page, 'قائمة منسدلة');
  const form = await pageBox(page);
  await page.mouse.move(form.x + form.width * 0.3, form.y + form.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(form.x + form.width * 0.7, form.y + form.height * 0.85, { steps: 15 });
  await page.mouse.up();
  await expect(embed.getByText('الخيار 1').first()).toBeVisible();
  await look('a new drop-down field');
  await escape();

  // A text box, and the style of text: font, bold, italic, alignment.
  await tab('تعليق').click();
  await button('نص').click();
  const box = await pageBox(page);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.85);
  await page.keyboard.type('نص');
  await look('a text box');
  await button('نمط التعليق التوضيحي').click();
  await expect(button('غامق')).toBeVisible();
  await expect(button('محاذاة إلى اليمين')).toBeVisible();
  await look('text style');
  await escape();
  await button('نمط التعليق التوضيحي').click();

  // The file's own comments and the new one: no author is "ضيف", dates are Arabic.
  await button('التعليقات').click();
  await expect(embed.getByText('ضيف').first()).toBeVisible();
  await look('comments sidebar');
  await button('التعليقات').click();

  await tab('إدراج').click();
  await button('ختم').click();
  await look('stamps');
  await escape();
  await button('التوقيعات').click();
  await button('إنشاء توقيع وأحرف أولى').click();
  await expect(embed.getByTitle('أسود').first()).toBeVisible();
  await look('create a signature');
  await escape();

  await tab('تنقيح').click();
  await button('لوحة التنقيح').click();
  await look('redaction panel');
  await button('لوحة التنقيح').click();

  await tab('عرض').click();
  for (const item of ['طباعة', 'الأمان']) {
    await button('قائمة المستند').click();
    await embed.getByRole('menuitem', { name: item }).or(button(item)).first().click();
    await look(`dialog ${item}`);
    await escape();
  }

  // A screenshot: an area dragged, and its preview.
  await button('قائمة المستند').click();
  await embed.getByRole('menuitem', { name: 'لقطة شاشة' }).or(button('لقطة شاشة')).first().click();
  const again = await pageBox(page);
  await page.mouse.move(again.x + 80, again.y + 80);
  await page.mouse.down();
  await page.mouse.move(again.x + 300, again.y + 240, { steps: 8 });
  await page.mouse.up();
  await expect(embed.getByRole('img', { name: 'المنطقة الملتقطة من الصفحة' })).toBeVisible();
  await look('screenshot preview');
  await embed.getByRole('button', { name: 'إلغاء' }).click();

  // Search, and its next and previous.
  await page.keyboard.press('ControlOrMeta+f');
  await embed.getByPlaceholder('بحث').fill('وراق');
  await expect(embed.getByRole('button', { name: 'النتيجة التالية' })).toBeVisible();
  await look('search');

  // EmbedPDF's sidebar: the pages and the outline.
  await page.keyboard.press('F4');
  await look('sidebar');

  expect(Object.fromEntries(seen)).toEqual({});
});
