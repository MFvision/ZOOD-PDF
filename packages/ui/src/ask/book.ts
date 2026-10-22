import { commandOf, normalize } from '../ai/chat/commands';
import type { Command } from '../ai/chat/commands';
import { translate } from '../i18n/messages';
import { TOOLS } from '../tools/tools';
import { risky } from './guide';

/**
 * ZOOD's command book: what Ask ZOOD can do inside ZOOD PDF without looking
 * at the screen. An idea from CLI-Anything (HKUDS, Apache-2.0; no code taken):
 * an assistant that calls an app's own commands is many times faster and
 * surer than one that takes a picture, finds a button and clicks it, step
 * after step. ZOOD PDF is our own app, so its commands are already known —
 * every item of its menus (`shell/menuModel.ts`), the tools, a page, a search
 * — and the editor window hands the list over and runs them
 * (`shell/askBridge.ts`).
 *
 * A request is cut into its parts ("rotate the pages then compress it"),
 * and each part is matched here, at once, by the chat's own commands
 * (`commandOf`) or by the words of a command's name, in Arabic and English;
 * only a part that matches nothing goes to the small decider, never to the
 * model that reads the screen.
 */

/** One command of the book, as the editor window lists it. */
export interface BookEntry {
  id: string;
  /** Its name in the app's language, as the menu shows it. */
  label: string;
  /** The menu it is in, by its name: "File". */
  menu: string;
  enabled: boolean;
}

/** One step to run: a command, with the page or the words it takes. */
export interface BookStep {
  id: string;
  page?: number;
  query?: string;
  /** Its name, said and shown: "Save". */
  label: string;
  /** A setting (`id` "setting"): which, and the choice to set; null shows it (`settingsBook.ts`). */
  setting?: string;
  value?: string | null;
}

/** What the person asked for: to be shown, to have it done, or neither. */
export type Intent = 'show' | 'do';

/** The most parts one request is cut into. */
export const MAX_BOOK_STEPS = 6;

/**
 * The words a command is asked for by, in English and Arabic (as compared:
 * `normalize`d), beside its name in the menu. The decider reads them too.
 */
export const BOOK_WORDS: Readonly<Record<string, string>> = {
  open: 'open a file, open a pdf, open another file / افتح ملف، فتح ملف، افتح ملف ثاني',
  save: 'save, save the file, save it, save my changes / حفظ، احفظ، احفظ الملف، احفظه، احفظ التعديلات',
  versions: 'earlier versions, earlier versions of the file, older versions, version history / النسخ السابقه، نسخ سابقه، النسخ القديمه',
  'save-device': 'save a copy, save a copy on this device / احفظ نسخه، احفظ نسخه علي الجهاز',
  print: 'print, print it / طباعه، اطبع، اطبعه',
  close: 'close, close the file, close the document, close it / اغلاق الملف، سكر الملف، سكر، اقفل الملف، سكره',
  undo: 'undo, undo that, go back a step, take that back / تراجع، رجع اللي سويته، ارجع خطوه، تراجع عن اخر شي',
  redo: 'redo, redo that / اعاده، اعد، اعد الخطوه',
  'edit-mode': 'edit mode, edit the text, change the text, type on the pdf / وضع التحرير، تعديل النص، عدل النص، عدل الكلام، اكتب علي الملف',
  find: 'find, search in the file / بحث، ابحث في الملف',
  goto: 'go to a page / الذهاب الي صفحه، روح للصفحه',
  'zoom-in': 'zoom in, bigger, make it bigger / تكبير، كبر، كبر الصفحه',
  'zoom-out': 'zoom out, make the page smaller / تصغير العرض، صغر الصفحه، صغر العرض',
  'fit-width': 'fit to width, fit width / ملاءمه العرض',
  'fit-page': 'fit the whole page, fit page / ملاءمه الصفحه',
  actual: 'actual size, 100% / الحجم الفعلي',
  'left-pane': 'thumbnails, page list, side panel, navigation pane, show thumbnails, hide the side panel / الصور المصغره، المصغرات، قائمه الصفحات، اللوحه الجانبيه',
  'pane-bookmarks': 'bookmarks, show bookmarks, table of contents / الاشارات المرجعيه، الفهرس، المحتويات',
  'pane-attachments': 'attachments, attached files, show attachments / المرفقات، الملفات المرفقه',
  'pane-layers': 'layers / الطبقات',
  'right-pane': 'tools panel, tools pane / لوحه الادوات',
  markup: 'markup bar, markup toolbar, draw, pen / شريط التعليقات، شريط التعليق، قلم، رسم',
  'read-aloud': 'read aloud, read it to me, read the file, read it out loud, stop reading / القراءه بصوت، اقرا لي، اقرا الملف، اقرا الملف بصوت، اقراه، وقف القراءه',
  present: 'present, slideshow, start presenting, presentation mode, full screen presentation / عرض تقديمي، ابدا العرض، وضع العرض',
  'phone-remote': 'phone remote, connect my phone, use my phone, remote control, pair my phone / التحكم من الجوال، اوصل جوالي، اربط جوالي، جوالي، الريموت',
  settings: 'settings, preferences / الاعدادات',
  about: 'about zood pdf, about zood, about the app, version, which version, what version / حول التطبيق، الاصدار، كم الاصدار، عن التطبيق',
  support: 'help and support, help, i need help, support / المساعده والدعم، مساعده، ساعدني، الدعم',
  report: 'report a problem, report a bug, something is broken, send a complaint / الابلاغ عن مشكله، ابلغ عن مشكله، بلغ عن مشكله، فيه مشكله، شكوي',
  ideas: 'suggest an idea, i have an idea, send feedback, feature request / اقتراح فكره، عندي اقتراح، عندي فكره، اقترح',
  tour: 'the tour, tutorial, welcome tour, start the tour, show me around / الجوله التعريفيه، الجوله، الشرح، ابدا الجوله',
  'ask-keys': 'ask zood keys lesson, learn the ask zood keys / درس مفاتيح اسال زود',
  shortcuts: 'keyboard shortcuts, list of shortcuts / اختصارات لوحه المفاتيح، الاختصارات',
  home: 'home screen, go home, back to home, main screen / الشاشه الرئيسيه، الرئيسيه، ارجع للرئيسيه، روح للرئيسيه',
  'theme-dark': 'dark mode / الوضع الليلي، داكن',
  'theme-light': 'light mode / الوضع النهاري، فاتح',
  'theme-system': 'theme like the system / مثل النظام',
  'layout-continuous': 'continuous scrolling, scroll pages / تمرير متصل',
  'layout-single': 'one page at a time, single page / صفحه واحده',
  'layout-two': 'two pages side by side, two pages / صفحتين جنب بعض، صفحتين',
  'layout-book': 'book view, like a book / عرض الكتاب، مثل الكتاب',
};

/**
 * The words a tool is asked by, beside its name: what people say when they
 * want it ("add a password", "حط علامة مائية"). Its name in both languages
 * counts too (`toolWords`).
 */
export const TOOL_WORDS: Readonly<Record<string, string>> = {
  edit: 'edit, edit the pdf, edit pdf / تحرير، عدل الملف، تعديل الملف',
  organize: 'rotate, rotate pages, rotate the pages, delete a page, delete page, delete pages, remove a page, remove pages, split, split the pdf, split the file, extract pages, extract a page, reorder pages, move pages, insert pages, add pages, crop / دور الصفحات، تدوير، احذف صفحه، احذف الصفحه، حذف صفحات، شيل صفحه، قسم الملف، تقسيم، افصل الصفحات، استخرج صفحات، رتب الصفحات، اضف صفحات، قص',
  comment: 'comment, add a comment, add comments, add a note, annotate, highlight, sticky note / تعليق، اضف تعليق، تعليقات، ملاحظه، اضف ملاحظه، ظلل، تظليل',
  fillSign: 'sign, sign it, sign the file, sign the document, add my signature, signature, fill, fill the form, fill in the form, fill and sign / وقع، وقع الملف، توقيع، اضف توقيعي، توقيعي، عبي، عبي النموذج، تعبئه النموذج، املا النموذج',
  protect: 'password, add a password, set a password, remove the password, unlock, unlock the file, protect, protect the file, lock the file, encrypt / كلمه مرور، حط كلمه مرور، ضع كلمه مرور، شيل كلمه المرور، ازل كلمه المرور، افتح القفل، احمي الملف، قفل الملف، رقم سري، باسورد',
  redact: 'redact, black out, hide names, hide personal information, black out names / حجب، احجب، احجب الاسماء، اخف المعلومات، تنقيح، طمس',
  export: 'convert, export, convert to word, export to word, convert to excel, export to excel, convert to powerpoint, convert to images, save as word, save as excel, save it as word, to word, to excel / تحويل، حول، حوله وورد، حول الي وورد، حول الملف الي وورد، حول الي اكسل، حول الملف الي اكسل، حول لبوربوينت، صدر، تصدير',
  compare: 'compare, compare two files, compare files, what changed, differences / مقارنه، قارن، قارن ملفين، قارن الملفين، وش الفرق، الفروقات',
  ocr: 'ocr, text recognition, make it searchable, make the scan searchable, recognize text, scanned pdf, picture to text / التعرف علي النص، حول الصوره لنص، حول الصوره الي نص، نص من صوره، خله قابل للبحث، ملف ممسوح',
  combine: 'combine, merge, merge files, merge pdfs, combine files, join files / دمج، ادمج، ادمج الملفات، دمج الملفات، اجمع الملفات',
  create: 'create, create a pdf, create a new pdf, new pdf, make a pdf, new file, blank pdf / انشاء، انشئ ملف، انشئ ملف جديد، ملف جديد، سوي ملف جديد',
  compress: 'compress, compress it, make the file smaller, reduce the size, reduce file size, shrink the file, smaller file / ضغط، اضغط الملف، صغر حجم الملف، قلل الحجم، قلل حجم الملف، خفف الملف، صغر الملف',
  prepareForm: 'prepare a form, make a form, create a form, add form fields, form fields / اعداد نموذج، سوي نموذج، انشئ نموذج، اضف حقول، حقول النموذج',
  ai: 'ask the ai, ai assistant, ai chat, chat with the file, ask about the file / الذكاء الاصطناعي، اسال الذكاء، محادثه، كلم الملف',
  pageMarks: 'watermark, add a watermark, page numbers, add page numbers, number the pages, header, footer, header and footer, bates numbers / علامه مائيه، حط علامه مائيه، اضف علامه مائيه، ارقام الصفحات، اضف ارقام الصفحات، رقم الصفحات، ترقيم، راس الصفحه، تذييل',
  certificates: 'digital signature, certificate, sign with a certificate, digital id / التوقيع الرقمي، شهاده رقميه، الهويه الرقميه',
  standards: 'pdf/a, pdf a, standards, archive format / معايير، ارشفه، pdf/a',
  accessibility: 'accessibility, check accessibility, accessibility check, screen reader check / امكانيه الوصول، اتاحه الوصول، فحص الوصول',
  batch: 'batch, batch processing, many files at once, all files in a folder / معالجه دفعيه، دفعه، ملفات كثيره مره وحده',
  library: 'library, my library, my documents / المكتبه، مكتبتي، مستنداتي',
};

/** Commands that ask first in Do it for me: they close, overwrite, print. */
const ASK_FIRST = new Set(['close', 'save', 'save-device', 'print']);

/** A command that Do it for me runs only after the person says yes. */
export function asksFirst(step: BookStep): boolean {
  return ASK_FIRST.has(step.id) || step.id.startsWith('cloud-save') || risky(step.label);
}

/** The words of a tool's command: its name in both languages. */
function toolWords(id: string): string | null {
  const tool = TOOLS.find((one) => `tool-${one.id}` === id);
  if (!tool) return null;
  const names = `${translate('en', tool.labelKey)} / ${translate('ar', tool.labelKey)}`;
  const more = TOOL_WORDS[tool.id];
  return more ? `${names}, ${more}` : names;
}

/** What the decider reads for an entry. */
export function entryWords(entry: BookEntry): string {
  const hint = BOOK_WORDS[entry.id] ?? toolWords(entry.id);
  return hint ? `${entry.label} — ${hint}` : entry.label;
}

/** The enabled entries as the decider's options. */
export function bookOptions(entries: readonly BookEntry[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (const entry of entries) if (entry.enabled) options[entry.id] = entryWords(entry);
  options.none = 'none of these: something else / شي ثاني';
  return options;
}

const SHOW =
  /\b(?:show me|teach me|how (?:do|can|to)|where (?:do|is|can)|walk me through|guide me)\b|(?:وريني|ورني|علمني|كيف|وين اضغط|وين القي|اشرح لي كيف)/;
const DO =
  /\b(?:do it|do this|for me|you do|please do|click|press|turn (?:on|off)|go to|open|switch)\b|(?:سوها|سويها|سوي لي|نفذ|اضغط|افتح|شغل|طفي|روح|خذني|ودني)/;

/** Whether the words ask to be shown how, or to have it done; null for neither. */
export function intentOf(words: string): Intent | null {
  const said = normalize(words);
  if (SHOW.test(said)) return 'show';
  if (DO.test(said)) return 'do';
  return null;
}

/** The asking taken off, leaving what is to be done: "do it for me: save" → "save". */
export function withoutAsking(words: string): string {
  return normalize(words)
    .replace(
      /\b(?:(?:can|could|would) you|please|do it for me|do this for me|do it|for me|show me how to|show me how|show me|teach me how to|teach me|how do i|how can i|how to|walk me through|guide me to|help me)\b/g,
      ' ',
    )
    .replace(/(?:سوها لي|سويها لي|سوي لي|سوها|سويها|وريني كيف|وريني|ورني|علمني كيف|علمني|كيف|ممكن|لو سمحت|من فضلك|ابيك|ابغاك|تقدر)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A request cut into its parts, in order: "rotate the pages then compress
 * it", "دور الصفحات ثم احفظ". A lone "and" or "و" cuts only between
 * commands, so "find and replace" stays whole unless both halves match.
 */
export function partsOf(words: string): string[] {
  return withoutAsking(words)
    .split(/\s*(?:,|،|;|\band then\b|\bthen\b|\bafter that\b|\band\b|ثم|وبعدين|بعدين|وبعدها|بعدها|بعد كذا|\sو\s)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, MAX_BOOK_STEPS);
}

/** The chat's command as a step of the book. */
export function stepOfCommand(command: Command, entries: readonly BookEntry[]): BookStep | null {
  const named = (id: string, extra: Partial<BookStep> = {}): BookStep | null => {
    const entry = entries.find((one) => one.id === id);
    if (id !== 'home' && (!entry || !entry.enabled)) return null;
    return { id, label: entry?.label ?? translate('en', 'ai.do.home'), ...extra };
  };
  switch (command.kind) {
    case 'tool':
      return named(`tool-${command.tool}`);
    case 'openFile':
      return named('open');
    case 'home':
      return named('home');
    case 'settings':
      return named('settings');
    case 'tour':
      return named('tour');
    case 'shortcuts':
      return named('shortcuts');
    case 'theme':
      return named(`theme-${command.theme}`);
    case 'page':
      return named('goto', { page: command.page });
    case 'find':
      return named('find', { query: command.query });
    case 'zoom':
      return named(command.direction === 'in' ? 'zoom-in' : 'zoom-out');
  }
}

/** A page number in the words: "page 5", "الصفحه ٣". */
export function pageIn(part: string): number | undefined {
  const page = /(\d{1,5})/.exec(normalize(part));
  return page ? Number(page[1]) : undefined;
}

/** The names an entry is asked by, as compared. */
export function namesOf(entry: BookEntry): string[] {
  const hint = BOOK_WORDS[entry.id] ?? toolWords(entry.id) ?? '';
  return [entry.label, ...hint.split(/\s*[/،,]\s*/)]
    .map((name) => normalize(name.replace(/[…•]/g, '')))
    .filter((name) => name.length >= 3);
}

/** `name` is in `text` as whole words: as said, or with the little words ("the", "a", "ال") left out of both. */
function hasWords(text: string, name: string): boolean {
  if (` ${text} `.includes(` ${name} `) || ` ${text} `.includes(` ال${name} `)) return true;
  const bare = (words: string) => ` ${words.split(' ').filter((word) => !LITTLE.has(word)).map((word) => (word.length > 4 ? word.replace(/^ال/, '') : word)).join(' ')} `;
  const plainName = bare(name).trim();
  return plainName.length >= 3 && bare(text).includes(` ${plainName} `);
}

/** Words that change nothing of what is asked. */
const LITTLE = new Set(['the', 'a', 'an', 'my', 'this', 'that', 'it', 'of', 'please', 'هذا', 'هذي', 'هذه', 'لي', 'علي', 'الي', 'في']);

/** Words that say nothing of which command: "print this document" is "print". */
const FILLER =
  /(?:^|\s)(?:the|a|an|it|this|that|these|file|document|pdf|for|me|now|my|please|button|هذا|هذي|هذه|الملف|ملف|المستند|لي|الحين|الان|زر)(?=\s|$)/g;

/** How much of the part a name says, 0..1: a name must be most of what was said. */
function coverage(text: string, name: string): number {
  const said = text.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  return said ? Math.min(1, name.replace(FILLER, ' ').trim().length / said.length) : 1;
}

/**
 * The entry a part names, by its words, when one names it more fully than
 * any other and its name is most of what was said: "turn on dark mode" →
 * theme-dark, but "open the contract" is not Open. Null when none, or two tie.
 */
export function entryNamed(part: string, entries: readonly BookEntry[]): BookEntry | null {
  const text = normalize(part);
  let best: BookEntry | null = null;
  let length = 0;
  let tie = false;
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const longest = Math.max(
      0,
      ...namesOf(entry)
        .filter((name) => hasWords(text, name) && coverage(text, name) >= 0.5)
        .map((name) => name.length),
    );
    if (longest === 0) continue;
    if (longest > length) {
      best = entry;
      length = longest;
      tie = false;
    } else if (longest === length) tie = true;
  }
  return best && !tie ? best : null;
}

/** A step for one part, found without asking any model, or null. */
export function stepOf(part: string, entries: readonly BookEntry[]): BookStep | null {
  const command = commandOf(part);
  if (command) {
    const step = stepOfCommand(command, entries);
    if (step) return step;
  }
  const entry = entryNamed(part, entries);
  if (!entry) return null;
  return stepFor(entry, part);
}

/** The step of `entry` for what was said: a page number goes with Go to page. */
export function stepFor(entry: BookEntry, part: string): BookStep {
  const step: BookStep = { id: entry.id, label: entry.label };
  if (entry.id === 'goto') {
    const page = pageIn(part);
    if (page !== undefined) step.page = page;
  }
  return step;
}

/** A plain-language line for a step: "Save", "Go to page 5". */
export function stepWords(step: BookStep): string {
  if (step.page !== undefined) return `${step.label.replace(/[…]/g, '')} ${step.page}`;
  if (step.query) return `${step.label.replace(/[…]/g, '')}: ${step.query}`;
  return step.label.replace(/[…]/g, '');
}

/* -------------------------------------------------------------- other apps */

/** A button of another app, as the host read it (`ask/controls.rs`). */
export interface Control {
  name: string;
  role: string;
  /** Its middle, in thousandths of the screen (as the pointer takes it). */
  x: number;
  y: number;
}

/** "click", "press the", "اضغط على": the words before a button's name. */
const PRESS =
  /^(?:(?:click|press|tap|hit|choose|select|pick|open|go to)(?: on)?(?: the)? |(?:اضغط|انقر|دوس|اختر|افتح|روح)(?: علي| على)? )/;

/**
 * The control a part names, by its words: "click Print" → Print; the
 * longest name said wins, and a name said by two controls in different
 * places is the first (the window lists the top before the bottom). Null
 * when no name is said.
 */
export function controlNamed(part: string, controls: readonly Control[]): Control | null {
  const text = normalize(part).replace(PRESS, '').trim();
  if (!text) return null;
  let best: Control | null = null;
  let length = 0;
  for (const control of controls) {
    const name = normalize(control.name);
    if (name.length < 2) continue;
    const said = text === name || hasWords(text, name) || (name.length >= 4 && hasWords(name, text));
    const size = text === name ? name.length + 1000 : name.length;
    if (said && size > length) {
      best = control;
      length = size;
    }
  }
  return best;
}

/** The controls' names as the decider's options, each name once, at most `most`. */
export function controlOptions(controls: readonly Control[], most = 60): Record<string, string> {
  const options: Record<string, string> = {};
  for (const [index, control] of controls.entries()) {
    if (Object.keys(options).length >= most) break;
    if (!Object.values(options).includes(control.name)) options[String(index)] = control.name;
  }
  options.none = 'none of these / ولا واحد';
  return options;
}

/* ------------------------------------------------------------------ words */

/** What the island says when a step cannot be done, in the person's language. */
const BOOK_ENDINGS = {
  disabled: { en: '{name} isn’t available right now.', ar: '«{name}» غير متاح الآن.' },
  missing: { en: 'I couldn’t find {name} in ZOOD PDF.', ar: 'ما لقيت «{name}» في زود PDF.' },
  page: { en: 'That page isn’t in this file.', ar: 'هذي الصفحة مو موجودة في الملف.' },
  menu: { en: 'Choose {name} in the {menu} menu.', ar: 'اختر «{name}» من قائمة {menu}.' },
  notFound: { en: 'I couldn’t find “{name}” on the screen.', ar: 'ما لقيت «{name}» على الشاشة.' },
  pressIn: { en: 'Press {name}?', ar: 'أضغط «{name}»؟' },
} as const;

export type BookEnding = keyof typeof BOOK_ENDINGS;

export function bookEnding(
  kind: BookEnding,
  language: 'ar' | 'en',
  values: { name?: string; menu?: string } = {},
): string {
  return BOOK_ENDINGS[kind][language]
    .replace('{name}', values.name ?? '')
    .replace('{menu}', values.menu ?? '');
}
