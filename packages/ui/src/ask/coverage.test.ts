import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOK_WORDS, TOOL_WORDS, intentOf, partsOf, stepOf } from './book';
import type { BookEntry } from './book';
import { FRESH, PHRASES } from './coverage.cases';
import { asksAboutWords, asksTheWorld } from './content';
import { fuzzyOffers, fuzzyPick } from './fuzzy';
import { SETTINGS_BOOK, settingAsked, settingFirst, settingsPageAsked } from './settingsBook';
import { translate } from '../i18n/messages';
import type { TKey } from '../i18n/messages';
import { TOOLS } from '../tools/tools';

/**
 * Ask ZOOD's reach, measured: every request of `coverage.cases.ts` is run
 * through the lanes the island runs before any model (`Island.tsx`
 * `respond`): settings named with a choice, the command book, settings by
 * name, then by their words one by one. And every setting in Settings and
 * every menu command must be known to them by name, so a new one cannot be
 * added that Ask ZOOD does not know ("change the menu" once found nothing).
 */

const MENU: ReadonlyArray<readonly [string, TKey, TKey]> = [
  ['about', 'help.about', 'app.name'], ['settings', 'settings.open', 'app.name'],
  ['open', 'file.open', 'menu.file'], ['save', 'file.save', 'menu.file'], ['versions', 'versions.menu', 'menu.file'],
  ['save-device', 'cloud.menu.saveToDevice', 'menu.file'], ['print', 'file.print', 'menu.file'], ['close', 'file.close', 'menu.file'],
  ['undo', 'edit.undo', 'menu.edit'], ['redo', 'edit.redo', 'menu.edit'], ['edit-mode', 'edit.mode', 'menu.edit'],
  ['find', 'edit.find', 'menu.edit'], ['goto', 'edit.goToPage', 'menu.edit'],
  ['zoom-in', 'view.zoomIn', 'menu.view'], ['zoom-out', 'view.zoomOut', 'menu.view'], ['fit-width', 'view.fitWidth', 'menu.view'],
  ['fit-page', 'view.fitPage', 'menu.view'], ['actual', 'view.actualSize', 'menu.view'], ['left-pane', 'view.leftPane', 'menu.view'],
  ['pane-bookmarks', 'view.bookmarks', 'menu.view'], ['pane-attachments', 'view.attachments', 'menu.view'], ['pane-layers', 'view.layers', 'menu.view'],
  ['right-pane', 'view.rightPane', 'menu.view'], ['markup', 'shell.markup', 'menu.view'], ['read-aloud', 'readAloud.label', 'menu.view'],
  ['present', 'present.start', 'menu.tools'], ['phone-remote', 'remote.menu', 'menu.tools'],
  ['support', 'help.support', 'menu.help'], ['report', 'help.report', 'menu.help'], ['ideas', 'help.ideas', 'menu.help'],
  ['tour', 'help.tour', 'menu.help'], ['ask-keys', 'help.askKeys', 'menu.help'], ['ask-guide', 'help.askGuide', 'menu.help'],
  ['quick-asks', 'help.quickAsks', 'menu.help'], ['always-ready', 'help.reach', 'menu.help'], ['ai-chat', 'help.aiChat', 'menu.help'],
  ['shortcuts', 'help.shortcuts', 'menu.help'],
];

function entries(lang: 'ar' | 'en'): BookEntry[] {
  const list: BookEntry[] = MENU.map(([id, key, menu]) => ({ id, label: translate(lang, key), menu: translate(lang, menu), enabled: true }));
  for (const tool of TOOLS) list.push({ id: `tool-${tool.id}`, label: translate(lang, tool.labelKey), menu: translate(lang, 'menu.tools'), enabled: true });
  for (const layout of ['continuous', 'single', 'two', 'book'] as const)
    list.push({ id: `layout-${layout}`, label: `${translate(lang, 'prefs.pageLayout')}: ${translate(lang, `prefs.layout.${layout}`)}`, menu: translate(lang, 'menu.view'), enabled: true });
  list.push({ id: 'home', label: translate(lang, 'home.title'), menu: '', enabled: true });
  return list;
}

const QUESTION = /[?؟]|^(?:what|why|which|who|is|are|does|ما |ماذا|وش |ايش|ليش|لماذا|هل )/i;

/** Where the island's lanes take `words`, as the cases write it; `offer: …` for a choice offered. */
function route(words: string, list: BookEntry[]): string {
  const said = intentOf(words);
  const question = !said && QUESTION.test(words.trim());
  const about = asksAboutWords(words);
  if (!question && (about || !settingFirst(words))) {
    const parts = partsOf(words);
    const steps = parts.map((part) => stepOf(part, list));
    if (parts.length && steps.every(Boolean))
      return 'book:' + steps.map((step) => `${step!.id}${step!.page ? `#${step!.page}` : ''}${step!.query ? `?${step!.query}` : ''}`).join('+');
  }
  if (about) return 'MODEL';
  if (said || !/[?؟]/.test(words)) {
    const asked = settingAsked(words, true);
    if (asked) return `setting:${asked.entry.id}=${asked.value ?? ''}`;
    const page = settingsPageAsked(words);
    if (page !== undefined) return `page:${page ?? 'general'}`;
  }
  if (!question && !asksTheWorld(words)) {
    const picked = fuzzyPick(words, list);
    if (picked) return picked.kind === 'book' ? `book:${picked.step.id}` : `setting:${picked.ask.entry.id}=${picked.ask.value ?? ''}`;
    const offers = fuzzyOffers(words, list).map((one) => (one.kind === 'book' ? `book:${one.step.id}` : `setting:${one.ask.entry.id}=${one.ask.value ?? ''}`));
    if (offers.length) return `offer: ${offers.join(' , ')}`;
  }
  return 'MODEL';
}

function measure(cases: ReadonlyArray<readonly [string, string]>) {
  const rows = { reached: 0, offered: 0, missed: [] as string[], wrong: [] as string[], total: 0 };
  for (const lang of ['en', 'ar'] as const) {
    const list = entries(lang);
    for (const [words, expected] of cases) {
      rows.total += 1;
      const got = route(words, list);
      const answers = expected.split('|');
      if (answers.some((one) => (one === 'MODEL' ? got === 'MODEL' || got.startsWith('offer') : got.startsWith(one)))) rows.reached += 1;
      else if (got.startsWith('offer') && answers.some((one) => got.includes(one))) rows.offered += 1;
      else if (got === 'MODEL' || got.startsWith('offer')) rows.missed.push(`${lang} ${words} → ${got}`);
      else rows.wrong.push(`${lang} ${words} → ${got} (want ${expected})`);
    }
  }
  return rows;
}

describe('Ask ZOOD reach', () => {
  it('reaches nearly every request it was written with', () => {
    const rows = measure(PHRASES);
    expect(rows.reached / rows.total).toBeGreaterThanOrEqual(0.97);
  });

  it('reaches or offers most fresh requests, and does nothing it was not asked', () => {
    const rows = measure(FRESH);
    expect(rows.reached / rows.total).toBeGreaterThanOrEqual(0.7);
    expect((rows.reached + rows.offered) / rows.total).toBeGreaterThanOrEqual(0.88);
    // A wrong pick of a setting's row only shows it; a wrong command would do something.
    expect(rows.wrong.filter((row) => row.includes('→ book:')), rows.wrong.join('\n')).toEqual([]);
  });

  it('changes nothing for a question or a sentence that is not a request', () => {
    for (const words of ['print my name in bold', 'open the contract from yesterday', 'what does night reading do?', 'وش يسوي الحجب؟']) {
      const got = route(words, entries('en'));
      expect(got === 'MODEL' || got.startsWith('offer'), `${words} → ${got}`).toBe(true);
    }
  });
});

describe('Ask ZOOD knows every setting and command', () => {
  /** Rows of Settings that are not settings: links, the About page, help, permission states, actions on everything. */
  const NOT_SETTINGS = new Set([
    'ask.access.accessibility', 'ask.access.input', 'ask.access.screen', 'ask.settings.about', 'ask.settings.examples', 'ask.settings.practise',
    'fontLibrary.title', 'help.ideas', 'help.report', 'help.support', 'help.tour', 'prefs.aboutBuilder', 'prefs.aboutCompany', 'prefs.aboutEmail',
    'prefs.aboutLicence', 'prefs.aboutNotices', 'prefs.aboutPhone', 'prefs.aboutSupport', 'prefs.aboutWhat', 'prefs.clearAll', 'prefs.cloudDrives',
    'prefs.menuCommands', 'prefs.outputFolder', 'prefs.quick', 'prefs.shortcutsReset', 'quick.settings.howTo', 'readAloud.betterVoice',
    'support.tab.ask', 'support.tab.learn',
  ]);

  it('has a book entry for every row of Settings', () => {
    const pages = ['../settings/pages.tsx', './AskSettings.tsx'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
    const rows = new Set([...pages.matchAll(/label=\{t\('([a-zA-Z.]+)'\)/g)].map((match) => match[1]!));
    const known = new Set(SETTINGS_BOOK.map((entry) => entry.label as string));
    const missing = [...rows].filter((key) => !known.has(key) && !NOT_SETTINGS.has(key));
    expect(missing, 'Settings rows Ask ZOOD cannot reach: add them to SETTINGS_BOOK (settingsBook.ts)').toEqual([]);
  });

  it('has words for every menu command', () => {
    const model = readFileSync(new URL('../shell/menuModel.ts', import.meta.url), 'utf8');
    const ids = [...model.matchAll(/\bid: '([a-z-]+)'/g)].map((match) => match[1]!).filter((id) => !['app', 'file', 'edit', 'view', 'tools', 'help'].includes(id));
    const missing = ids.filter((id) => !BOOK_WORDS[id] && !['settings', 'quick-asks', 'ask-guide', 'always-ready', 'ai-chat'].includes(id));
    expect(missing, 'menu commands with no words in BOOK_WORDS (book.ts)').toEqual([]);
    expect(TOOLS.filter((tool) => !TOOL_WORDS[tool.id]).map((tool) => tool.id), 'tools with no words in TOOL_WORDS (book.ts)').toEqual([]);
  });
});
