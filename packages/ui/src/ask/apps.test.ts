import { describe, expect, it } from 'vitest';
import { controlNamed, controlNamedAlone, intentOf, partsOf } from './book';
import type { Control } from './book';
import { asksAboutWords } from './content';
import { shortcutAsked } from './shortcuts';

/**
 * Ask ZOOD in other apps, without a picture: each request is routed as the
 * island routes it (`Island.tsx` `respond`) against the buttons a real app
 * lists to the system (written down from Outlook, Word, Chrome with Gmail,
 * File Explorer, Mac Mail and Finder). "keys" is the app's own shortcut,
 * "button" a button found by its name, "model" the AI (a picture of the
 * screen when the model sees, else words only). The decider's guess, which
 * needs the real model, is left out: only what is certain is counted.
 */

const APPS: Record<string, string[]> = {
  outlook: ['New Email', 'Delete', 'Archive', 'Reply', 'Reply All', 'Forward', 'Move', 'Mark as Unread', 'Flag', 'Search', 'Send', 'Attach File', 'File', 'Home', 'View', 'Help'],
  word: ['File', 'Home', 'Insert', 'Layout', 'Review', 'View', 'Bold', 'Italic', 'Underline', 'Font', 'Font Size', 'Share', 'Comments', 'Undo', 'Styles', 'Find', 'Replace'],
  gmail: ['Back', 'Forward', 'Reload', 'New Tab', 'Compose', 'Inbox', 'Search mail', 'Archive', 'Report spam', 'Delete', 'Mark as unread', 'Reply', 'Forward', 'Send', 'Attach files'],
  explorer: ['Back', 'Forward', 'Up', 'New', 'Cut', 'Copy', 'Paste', 'Rename', 'Share', 'Delete', 'Sort', 'View', 'Search', 'Downloads', 'Documents', 'Desktop'],
  mail: ['Get Mail', 'New Message', 'Archive', 'Delete', 'Junk', 'Reply', 'Reply All', 'Forward', 'Flag', 'Search', 'File', 'Edit', 'View', 'Mailbox', 'Message', 'Format', 'Window', 'Help'],
  finder: ['Back', 'Forward', 'View', 'Group', 'Share', 'Edit Tags', 'Action', 'Search', 'AirDrop', 'Recents', 'Applications', 'Desktop', 'Documents', 'Downloads', 'File', 'Edit', 'Go', 'Window', 'Help'],
};

const CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['outlook', 'reply all', 'button'], ['outlook', 'archive', 'button'], ['outlook', 'send', 'button'], ['outlook', 'forward', 'button'],
  ['outlook', 'click new email', 'button'], ['outlook', 'print this', 'keys'], ['outlook', 'ارسل', 'button'], ['outlook', 'ارشف', 'button'],
  ['outlook', 'رد علي الكل', 'button'], ['outlook', 'احذفها', 'button'], ['outlook', 'show me where flag is', 'button'], ['outlook', 'اطبع', 'keys'],
  ['outlook', 'move this email to the projects folder', 'model'], ['outlook', 'reply and say I agree', 'model'],
  ['word', 'make it bold', 'keys'], ['word', 'underline this', 'keys'], ['word', 'save', 'keys'], ['word', 'احفظ', 'keys'],
  ['word', 'click insert', 'button'], ['word', 'share', 'button'], ['word', 'undo', 'keys'], ['word', 'خط عريض', 'keys'],
  ['word', 'make the title blue and 24 points', 'model'], ['word', 'add a table with 3 columns', 'model'],
  ['gmail', 'compose', 'button'], ['gmail', 'new tab', 'keys'], ['gmail', 'refresh', 'keys'], ['gmail', 'zoom in', 'keys'],
  ['gmail', 'report spam', 'button'], ['gmail', 'archive', 'button'], ['gmail', 'تبويب جديد', 'keys'], ['gmail', 'كبر', 'keys'],
  ['gmail', 'close this tab', 'keys'], ['gmail', 'search for invoices from last month', 'model'],
  ['explorer', 'rename', 'button'], ['explorer', 'open downloads', 'button'], ['explorer', 'copy', 'keys'], ['explorer', 'select all', 'keys'],
  ['explorer', 'paste', 'button'], ['explorer', 'sort by date', 'model'], ['explorer', 'حدد الكل', 'keys'],
  ['mail', 'get mail', 'button'], ['mail', 'new message', 'button'], ['mail', 'junk', 'button'], ['mail', 'print', 'keys'],
  ['mail', 'رساله جديده', 'button'], ['mail', 'click reply all', 'button'],
  ['finder', 'open downloads', 'button'], ['finder', 'airdrop', 'button'], ['finder', 'new window', 'keys'], ['finder', 'go to applications', 'button'],
  ['finder', 'empty the trash', 'model'],
];

const controlsOf = (names: string[]): Control[] => names.map((name, index) => ({ name, role: 'button', x: 10 + index * 50, y: 100 }));

/** Before the fix: buttons only after "click" or "show me", no shortcuts, no other language. */
function before(words: string, controls: Control[]): string {
  if (!intentOf(words) || asksAboutWords(words)) return 'model';
  const part = partsOf(words)[0] ?? '';
  const exact = controls.find((control) => controlNamed(part, controls) === control);
  return exact ? 'button' : 'model';
}

function now(words: string, controls: Control[]): string {
  if (shortcutAsked(words)) return 'keys';
  const parts = partsOf(words);
  if (intentOf(words) && controlNamed(parts[0] ?? '', controls)) return 'button';
  if (asksAboutWords(words)) return 'model';
  if (!intentOf(words) && parts.length === 1 && parts[0]!.split(' ').length <= 4 && controlNamedAlone(parts[0]!, controls)) return 'button';
  return 'model';
}

describe('Ask ZOOD in other apps without a picture', () => {
  it('reaches everyday commands by shortcut or by name', () => {
    const rows = CASES.map(([app, words, want]) => ({ app, words, want, was: before(words, controlsOf(APPS[app]!)), got: now(words, controlsOf(APPS[app]!)) }));
    const wrong = rows.filter((row) => row.got !== row.want).map((row) => `${row.app}: ${row.words} → ${row.got}, want ${row.want}`);
    const share = (key: 'was' | 'got') => rows.filter((row) => row[key] !== 'model').length;
    console.log(`without a picture: before ${share('was')}/${rows.length}, now ${share('got')}/${rows.length}`);
    expect(wrong).toEqual([]);
  });
});
