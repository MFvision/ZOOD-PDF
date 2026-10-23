import { normalize } from '../ai/chat/commands';

/**
 * Everyday commands in another app, by the app's own shortcut: "print",
 * «اطبع», "new tab", "zoom in". Each is pressed as Ctrl (Command on a Mac)
 * with a key, the same in nearly every app (`hands.rs`, `SHORTCUTS`), so
 * it needs no picture of the screen and no button to find: a Mac's Print
 * is in a menu the window does not list, and works this way all the same.
 * Only a request that is the command alone counts ("print this", not
 * "print the second page in colour"), so nothing more is guessed.
 */

export type Shortcut =
  | 'print'
  | 'save'
  | 'find'
  | 'select-all'
  | 'copy'
  | 'new-tab'
  | 'close-tab'
  | 'reopen-tab'
  | 'refresh'
  | 'zoom-in'
  | 'zoom-out'
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'new-window';

/** What each is called, in English and in Arabic (as `normalize` leaves them). */
const NAMES: Readonly<Record<Shortcut, readonly string[]>> = {
  print: ['print', 'print it', 'print this', 'print the page', 'print the email', 'اطبع', 'اطبعه', 'اطبعها', 'اطبع هذا', 'اطبع الصفحه', 'طباعه'],
  save: ['save', 'save it', 'save this', 'save the file', 'احفظ', 'احفظه', 'احفظها', 'احفظ الملف', 'حفظ'],
  find: ['find', 'find on this page', 'search this page', 'find in page', 'دور في الصفحه', 'ابحث في الصفحه', 'بحث في الصفحه'],
  'select-all': ['select all', 'select everything', 'حدد الكل', 'حدد كل شي', 'تحديد الكل'],
  copy: ['copy', 'copy it', 'copy this', 'copy that', 'انسخ', 'انسخه', 'انسخها', 'انسخ هذا', 'نسخ'],
  'new-tab': ['new tab', 'open a new tab', 'open new tab', 'تبويب جديد', 'افتح تبويب جديد', 'تاب جديد', 'افتح تاب جديد'],
  'close-tab': ['close tab', 'close this tab', 'close the tab', 'سكر التبويب', 'اقفل التبويب', 'سكر التاب', 'اقفل التاب'],
  'reopen-tab': ['reopen the tab', 'reopen tab', 'reopen closed tab', 'reopen the closed tab', 'رجع التبويب', 'رجع التاب', 'افتح التبويب المقفل'],
  refresh: ['refresh', 'reload', 'refresh the page', 'reload the page', 'refresh this page', 'حدث الصفحه', 'تحديث الصفحه', 'ريفرش'],
  'zoom-in': ['zoom in', 'make it bigger', 'bigger text', 'كبر', 'كبر الشاشه', 'تكبير', 'كبر الخط'],
  'zoom-out': ['zoom out', 'make it smaller', 'smaller text', 'صغر', 'صغر الشاشه', 'تصغير', 'صغر الخط'],
  undo: ['undo', 'undo that', 'undo it', 'تراجع', 'تراجع عن هذا', 'رجع زي ما كان'],
  redo: ['redo', 'redo that', 'اعاده', 'اعد التراجع'],
  bold: ['bold', 'make it bold', 'make this bold', 'خط عريض', 'خله عريض', 'غامق'],
  italic: ['italic', 'make it italic', 'make this italic', 'مائل', 'خط مائل', 'خله مائل'],
  underline: ['underline', 'underline it', 'underline this', 'تحته خط', 'حط خط تحته'],
  'new-window': ['new window', 'open a new window', 'نافذه جديده', 'افتح نافذه جديده'],
};

/** Closing loses what was there: asked first. */
export const ASKS_FIRST: ReadonlySet<Shortcut> = new Set(['close-tab']);

/** The keys, as told to the person when Do it for me is off. */
export function keysOf(shortcut: Shortcut, mac: boolean): string {
  const key: Record<Shortcut, string> = {
    print: 'P', save: 'S', find: 'F', 'select-all': 'A', copy: 'C', 'new-tab': 'T', 'close-tab': 'W',
    'reopen-tab': 'Shift+T', refresh: 'R', 'zoom-in': '+', 'zoom-out': '-', undo: 'Z',
    redo: mac ? 'Shift+Z' : 'Y', bold: 'B', italic: 'I', underline: 'U', 'new-window': 'N',
  };
  return `${mac ? '⌘' : 'Ctrl+'}${key[shortcut]}`;
}

/** The asking taken off: "please", "do it for me", «لو سمحت», "press", "اضغط". */
const ASKING =
  /^(?:(?:please|can you|could you|zood|hey zood|do it for me|for me|just|now) )*|(?: (?:please|for me|now|thanks|thank you))+$|^(?:(?:لو سمحت|ممكن|زود|تكفى|سوها لي|ابيك|ابغاك) )*|(?: (?:لو سمحت|الحين|تكفى))+$/g;

/** The everyday command `words` are, alone; null for anything more or else. */
export function shortcutAsked(words: string): Shortcut | null {
  const said = normalize(words).replace(/[.!؟?]+$/, '').replace(ASKING, '').replace(/\s+/g, ' ').trim();
  if (!said) return null;
  for (const [shortcut, names] of Object.entries(NAMES) as [Shortcut, readonly string[]][])
    if (names.some((name) => normalize(name) === said)) return shortcut;
  return null;
}
