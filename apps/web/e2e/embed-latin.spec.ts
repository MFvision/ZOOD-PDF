import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { chooseTool, corpus, embedTiles, pageBox, test, useAction } from './helpers';

/**
 * EmbedPDF's own interface — its toolbars, menus, sidebars, dialogs and
 * loading screens — speaks the language on screen, in every state.
 *
 * Every visible text, name, tooltip and placeholder inside EmbedPDF is read
 * in each of its states. In Arabic any word in Latin script fails the test,
 * but for the document's own words (it is an Arabic file that names PDF,
 * OpenType and Google) and the names of fonts, which are names. In English
 * a translation key shown as it is ("form.toggleFillMode") fails it.
 */

/** Arabic, with outlines and comments, whose own text has a few Latin words. */
const FILE = corpus('generated/variant-arabic-metadata-outlines-annots.pdf');
const TRUTH = fileURLToPath(new URL('../../../tests/corpus/arabic/truth/variant-arabic-metadata-outlines-annots.txt', import.meta.url));

/** Names, not words: the standard fonts' families, as a font picker lists them. */
const FONT_NAMES = ['Helvetica', 'Courier', 'Times', 'Roman', 'Symbol', 'Zapf', 'Dingbats'];

const documentWords = new Set(readFileSync(TRUTH, 'utf8').match(/\p{Script=Latin}+/gu) ?? []);

/** Every visible text, name, tooltip, placeholder and picture's text in EmbedPDF: "where: text". */
async function textsOnScreen(page: Page): Promise<{ where: string; text: string }[]> {
  return page.evaluate(() => {
    const root = document.querySelector('embedpdf-container')?.shadowRoot;
    if (!root) return [];
    const found: { where: string; text: string }[] = [];
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        const text = node.textContent?.trim();
        if (text && parent && !['STYLE', 'SCRIPT'].includes(parent.tagName) && shown(parent)) {
          found.push({ where: `text in <${parent.tagName.toLowerCase()}>`, text });
        }
        return;
      }
      // A form field is named by the document (its name is the file's data,
      // "Combobox_fcacab1a" for one EmbedPDF has just made): not chrome.
      const field = node instanceof HTMLElement && node.hasAttribute('name');
      if (node instanceof Element && shown(node) && !field) {
        for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) {
          const text = node.getAttribute(attribute)?.trim();
          if (text) found.push({ where: attribute, text });
        }
      }
      node.childNodes.forEach(walk);
    };
    walk(root);
    return found;
  });
}

/** In Arabic: Latin-script words that are not the document's own or a font's name. */
function latinWords(texts: { where: string; text: string }[]): string[] {
  const out = new Set<string>();
  for (const { where, text } of texts) {
    // A colour's code (#FF8D00) is notation, not a word.
    for (const word of text.replace(/#[0-9a-f]{3,8}\b/gi, '').match(/\p{Script=Latin}{2,}/gu) ?? []) {
      if (!documentWords.has(word) && !FONT_NAMES.includes(word)) out.add(`${word} — ${where}: ${text.slice(0, 80)}`);
    }
  }
  return [...out];
}

/** In any language: a translation key shown instead of its text. */
function rawKeys(texts: { where: string; text: string }[]): string[] {
  return [...new Set(texts.filter(({ text }) => /^[a-z][a-zA-Z]*(\.[a-zA-Z0-9]+)+$/.test(text)).map(({ where, text }) => `${where}: ${text}`))];
}

/** What the walk clicks, by its name in each language. */
const LABELS = {
  ar: {
    language: 'العربية',
    markupBar: 'شريط أدوات التعليق',
    loading: 'جارٍ تشغيل محرّك العرض…',
    modes: ['تعليق', 'أشكال', 'إدراج', 'نموذج', 'تنقيح', 'عرض'],
    annotate: 'تعليق',
    insert: 'إدراج',
    redact: 'تنقيح',
    view: 'عرض',
    documentMenu: 'قائمة المستند',
    pageSettings: 'إعدادات الصفحة',
    prepareForm: 'إعداد نموذج',
    dropdown: 'قائمة منسدلة',
    firstOption: 'الخيار 1',
    text: 'نص',
    style: 'نمط التعليق التوضيحي',
    bold: 'غامق',
    alignRight: 'محاذاة إلى اليمين',
    comments: 'التعليقات',
    noAuthor: 'ضيف',
    stamp: 'ختم',
    signatures: 'التوقيعات',
    createSignature: 'إنشاء توقيع وأحرف أولى',
    black: 'أسود',
    redactionPanel: 'لوحة التنقيح',
    print: 'طباعة',
    security: 'الأمان',
    screenshot: 'لقطة شاشة',
    captured: 'المنطقة الملتقطة من الصفحة',
    cancel: 'إلغاء',
    search: 'بحث',
    next: 'النتيجة التالية',
  },
  en: {
    language: 'English',
    markupBar: 'Markup toolbar',
    loading: 'Initializing PDF engine...',
    modes: ['Annotate', 'Shapes', 'Insert', 'Form', 'Redact', 'View'],
    annotate: 'Annotate',
    insert: 'Insert',
    redact: 'Redact',
    view: 'View',
    documentMenu: 'Document Menu',
    pageSettings: 'Page Settings',
    prepareForm: 'Prepare form',
    dropdown: 'Dropdown',
    firstOption: 'Option 1',
    text: 'Text',
    style: 'Annotation Style',
    bold: 'Bold',
    alignRight: 'Align right',
    comments: 'Comment',
    noAuthor: 'Guest',
    stamp: 'Rubber Stamp',
    signatures: 'Signatures',
    createSignature: 'Create Signature & Initials',
    black: 'Black',
    redactionPanel: 'Redaction Sidebar',
    print: 'Print',
    security: 'Security',
    screenshot: 'Screenshot',
    captured: 'Captured PDF area',
    cancel: 'Cancel',
    search: 'Search',
    next: 'Next result',
  },
};

/**
 * Opens the file with the interface in `lang` and walks EmbedPDF through its
 * states; `check` says what is wrong with the texts on screen in each. Returns
 * what it found, by state.
 */
async function walk(page: Page, lang: 'ar' | 'en', check: (texts: { where: string; text: string }[]) => string[]) {
  const l = LABELS[lang];
  const seen = new Map<string, string[]>();
  const look = async (state: string) => {
    // A frame for what the last click opened to draw.
    await page.waitForTimeout(300);
    const found = check(await textsOnScreen(page));
    if (found.length > 0) seen.set(state, found);
  };

  await page.goto('/');
  await page.getByRole('menubar').getByRole('combobox').first().selectOption({ label: l.language });

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
  // The loading screen was seen, in the language on screen.
  expect(whileLoading).toContain(l.loading);
  const loading = check(whileLoading.map((text) => ({ where: 'loading', text })));
  if (loading.length > 0) seen.set('loading', loading);

  const embed = page.locator('embedpdf-container');
  const button = (name: string) => embed.getByRole('button', { name, exact: true }).first();
  const tab = (name: string) => embed.getByRole('tablist').getByRole('button', { name, exact: true });
  const escape = () => page.keyboard.press('Escape');

  await page.getByRole('toolbar').getByRole('button', { name: l.markupBar, exact: true }).click();
  await look('view');
  for (const mode of l.modes) {
    await tab(mode).click();
    await look(`mode ${mode}`);
  }

  for (const menu of [l.documentMenu, l.pageSettings]) {
    await button(menu).click();
    await look(`menu ${menu}`);
    await escape();
  }

  // A drop-down field drawn on the page, from Prepare form: the options it starts with.
  await chooseTool(page, l.prepareForm);
  await useAction(page, l.dropdown);
  // In the part of the page the window shows: a document opens at its top.
  const form = await pageBox(page);
  await page.mouse.move(form.x + form.width * 0.3, form.y + form.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(form.x + form.width * 0.7, form.y + form.height * 0.6, { steps: 15 });
  await page.mouse.up();
  await expect(embed.getByText(l.firstOption).first()).toBeVisible();
  await look('a new drop-down field');
  await escape();

  // A text box, and the style of text: font, bold, italic, alignment.
  await tab(l.annotate).click();
  await button(l.text).click();
  const box = await pageBox(page);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.65);
  await page.keyboard.type('نص');
  await look('a text box');
  await button(l.style).click();
  await expect(button(l.bold)).toBeVisible();
  await expect(button(l.alignRight)).toBeVisible();
  await look('text style');
  await escape();
  await button(l.style).click();

  // The file's own comments and the new one, which has no author.
  await button(l.comments).click();
  await expect(embed.getByText(l.noAuthor).first()).toBeVisible();
  await look('comments sidebar');
  await button(l.comments).click();

  await tab(l.insert).click();
  await button(l.stamp).click();
  await look('stamps');
  await escape();
  await button(l.signatures).click();
  await button(l.createSignature).click();
  await expect(embed.getByTitle(l.black).first()).toBeVisible();
  await look('create a signature');
  await escape();

  await tab(l.redact).click();
  await button(l.redactionPanel).click();
  await look('redaction panel');
  await button(l.redactionPanel).click();

  await tab(l.view).click();
  for (const item of [l.print, l.security]) {
    await button(l.documentMenu).click();
    await embed.getByRole('menuitem', { name: item }).or(button(item)).first().click();
    await look(`dialog ${item}`);
    await escape();
  }

  // A screenshot: an area dragged, and its preview.
  await button(l.documentMenu).click();
  await embed.getByRole('menuitem', { name: l.screenshot }).or(button(l.screenshot)).first().click();
  const again = await pageBox(page);
  await page.mouse.move(again.x + 80, again.y + 80);
  await page.mouse.down();
  await page.mouse.move(again.x + 300, again.y + 240, { steps: 8 });
  await page.mouse.up();
  await expect(embed.getByRole('img', { name: l.captured })).toBeVisible();
  await look('screenshot preview');
  await embed.getByRole('button', { name: l.cancel }).click();

  // Search, and its next and previous.
  await page.keyboard.press('ControlOrMeta+f');
  await embed.getByPlaceholder(l.search).fill('وراق');
  await expect(embed.getByRole('button', { name: l.next })).toBeVisible();
  await look('search');

  // EmbedPDF's sidebar: the pages and the outline.
  await page.keyboard.press('F4');
  await look('sidebar');

  return Object.fromEntries(seen);
}

test('no English in EmbedPDF while Warraq is in Arabic, in any of its states', async ({ page, stayLocal: _ }) => {
  test.setTimeout(240_000);
  expect(await walk(page, 'ar', (texts) => [...latinWords(texts), ...rawKeys(texts)])).toEqual({});
});

test('no translation key shown as it is in EmbedPDF in English, in any of its states', async ({ page, stayLocal: _ }) => {
  test.setTimeout(240_000);
  expect(await walk(page, 'en', rawKeys)).toEqual({});
});
