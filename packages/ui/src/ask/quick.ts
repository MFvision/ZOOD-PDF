import { DEVICE_MODELS } from '../ai/device/models';
import type { DeviceModel } from '../ai/device/models';
import { invokeHost } from '../core/host-tauri';
import { translate } from '../i18n/messages';
import type { TKey } from '../i18n/messages';
import { ASK_TOOLS, languageOf } from './plan';
import type { AskTool, Decision } from './plan';
import { modelReady } from './settings';

/**
 * Ask ZOOD's quick lane. A small decision model (Jev-Style 0.8B, `decide.rs`
 * in the host) reads what the person said and picks one action from a list,
 * with a probability for each, without writing a word — in about half a
 * second on a Mac. A quick action (a tool, finding a file, tidying a folder)
 * is then done with a short fixed reply in the person's language; anything
 * that needs words written or the screen seen goes on to the larger model as
 * before. When the decider is not sure, the person picks from its two best
 * guesses instead of it guessing.
 */

/** What the decider chooses between. */
export type QuickKey =
  | AskTool
  | 'find'
  | 'organize'
  | 'undo'
  | 'fill'
  | 'write'
  | 'summarize'
  | 'translate'
  | 'show'
  | 'answer';

/**
 * Each option as the decider reads it: English, with the Arabic a person
 * says for it. The Arabic words lifted the right answers from 36 to 39 of 42
 * test requests (half in Saudi Arabic) on the real model with 19 options; with
 * all of these it picks 37 of 42 (`decide.rs`, the ignored real-model test),
 * and no miss runs on its own: three are asked, one waits for Do it, and
 * one goes on to the larger model.
 */
export const QUICK_OPTIONS: Readonly<Record<QuickKey, string>> = {
  compress: 'make PDF files smaller in size / تصغير حجم الملف',
  word: 'convert a PDF to a Word document / تحويل إلى وورد',
  excel: 'convert PDF tables to an Excel spreadsheet / تحويل الجدول إلى اكسل',
  powerpoint: 'convert a PDF to PowerPoint slides / تحويل إلى بوربوينت',
  text: 'take the plain text out of a PDF / استخراج النص',
  images: 'turn PDF pages into pictures / تحويل الصفحات إلى صور',
  ocr: 'recognise the text in a scanned PDF or image / ملف مصور، التعرف على النص',
  combine: 'merge several files into one PDF / دمج الملفات',
  protect: 'lock a PDF with a password / وضع كلمة مرور أو رقم سري',
  unlock: 'remove the password from a PDF / إزالة كلمة المرور أو الباسورد',
  rotate: 'rotate pages / تدوير الصفحات المقلوبة',
  extract: 'take some pages out into a new PDF / أخذ صفحات من الملف',
  split: 'split a PDF into parts / تقسيم الملف',
  resize: 'change the page size, A4 or letter / تغيير مقاس الصفحة',
  numbers: 'add page numbers / ترقيم الصفحات',
  watermark: 'add a watermark or stamp text on pages / علامة مائية أو ختم نص على الصفحات',
  sign: 'sign the PDF / توقيع الملف',
  topdf: 'make a PDF from pictures or Office files / تحويل إلى PDF',
  find: 'search for a file or document / البحث عن ملف',
  organize:
    'tidy, sort, move or rename files and folders on the computer / ترتيب ونقل وتسمية الملفات والمجلدات',
  undo: 'undo the last tidy, put the files back / تراجع، رجّع الملفات مكانها',
  fill: "type the person's saved details (name, phone, ID) into a form / تعبئة الاسم والجوال",
  write: 'write or draft a reply, email or message / كتابة رد أو رسالة',
  summarize: 'summarize a document / تلخيص الملف',
  translate: 'translate text or a document / ترجمة',
  show: 'show where to click on the screen, explain the screen / وين أضغط، اشرح الشاشة',
  answer: 'answer a question or chat; no action / سؤال أو دردشة بدون إجراء',
};

export const QUICK_KEYS = Object.keys(QUICK_OPTIONS) as QuickKey[];

const TOOLS = new Set<string>(ASK_TOOLS);

/** The actions the quick lane does itself; the rest go to the larger model. */
export function isQuick(key: string): boolean {
  return TOOLS.has(key) || key === 'find' || key === 'organize' || key === 'undo';
}

/** Below this the decider asks instead of acting. */
export const SURE = 0.6;
/** At or above this a quick tool runs without a Do it. */
export const CERTAIN = 0.8;

export interface Ranked {
  key: string;
  p: number;
}

export type QuickOutcome =
  | { kind: 'act'; key: QuickKey; p: number }
  | { kind: 'choose'; keys: [QuickKey, QuickKey] }
  | { kind: 'model' };

/** What to do with the decider's ranking. */
export function readQuick(ranked: readonly Ranked[]): QuickOutcome {
  const [top, second] = ranked;
  // The decider's own keys only: never one of every object's ("constructor"), nor a key or a share of the wrong kind.
  const known = (one: Ranked | undefined): one is Ranked =>
    !!one && typeof one.key === 'string' && Object.hasOwn(QUICK_OPTIONS, one.key) && Number.isFinite(one.p);
  if (!known(top)) return { kind: 'model' };
  const key = top.key as QuickKey;
  if (!isQuick(key)) return { kind: 'model' };
  if (top.p >= SURE || !known(second))
    return { kind: 'act', key, p: top.p };
  return { kind: 'choose', keys: [key, second.key as QuickKey] };
}

/** The decision model in the catalogue. */
export function quickModel(): DeviceModel | undefined {
  return DEVICE_MODELS.find((model) => model.decides);
}

/** The decider is downloaded: the quick lane answers. */
export async function quickReady(): Promise<DeviceModel | null> {
  const model = quickModel();
  return model && (await modelReady(model)) ? model : null;
}

interface Decided {
  ranked: Ranked[];
  ms: number;
}

/** Ranks `options` for what the person said, on the host's decider. */
export async function decide(
  model: DeviceModel,
  state: string,
  question: string,
  options: Readonly<Record<string, string>>,
): Promise<Ranked[]> {
  const done = (await invokeHost('ai_decide', {
    request: {
      model: model.id,
      state,
      question,
      options: Object.entries(options).map(([key, text]) => ({ key, text })),
    },
  })) as Decided;
  return done.ranked;
}

/** The decider loads before the first ask, while the person is still speaking. */
export function warmQuick(): void {
  void quickReady().then((model) =>
    model ? invokeHost('ai_decide_warm', { model: model.id }).catch(() => undefined) : undefined,
  );
}

export const QUICK_QUESTION = 'What does the person want ZOOD PDF to do?';

/* ----------------------------------------------------------------- tidy */

export type TidyPlace = 'downloads' | 'desktop' | 'documents' | 'selection';
export type TidyHow = 'type' | 'month' | 'date' | 'invoices';

const PLACE_OPTIONS: Record<TidyPlace, string> = {
  downloads: 'the Downloads folder / التنزيلات',
  desktop: 'the Desktop / سطح المكتب',
  documents: 'the Documents folder / المستندات',
  selection: 'the selected files or folder, these files / هذي الملفات، الملفات المحددة',
};

const HOW_OPTIONS: Record<TidyHow, string> = {
  type: 'sort into folders by kind of file (PDFs, pictures, documents) / حسب النوع',
  month: 'sort into a folder per month / حسب الشهر',
  date: 'rename each file to start with its date / تسمية الملفات بالتاريخ',
  invoices: 'gather the invoices and receipts into one folder / جمع الفواتير',
};

/** Words that name the place outright, so the decider is not asked. */
const PLACE_WORDS: [TidyPlace, RegExp][] = [
  ['downloads', /download|تنزيل|التنزيلات|داونلود/i],
  ['desktop', /desktop|سطح المكتب|الديسكتوب/i],
  ['documents', /documents|المستندات|مستنداتي/i],
];

const HOW_WORDS: [TidyHow, RegExp][] = [
  ['invoices', /invoice|receipt|فاتور|فواتير|إيصال|ايصال/i],
  ['date', /rename|by date|بالتاريخ|سمّ|سم الملفات|تسمية|اسماء/i],
  ['month', /month|بالشهر|حسب الشهر|شهور/i],
  ['type', /type|kind|بالنوع|حسب النوع|انواع|أنواع/i],
];

/** Where and how to tidy, read from the words, or decided when they do not say. */
export async function tidyChoice(
  model: DeviceModel,
  words: string,
  selected: number,
): Promise<{ place: TidyPlace; how: TidyHow }> {
  const named = PLACE_WORDS.find(([, pattern]) => pattern.test(words))?.[0];
  const places: Partial<Record<TidyPlace, string>> = { ...PLACE_OPTIONS };
  if (!selected) delete places.selection;
  const place =
    named ??
    ((await decide(model, words, 'Which folder should be tidied?', places))[0]?.key as
      TidyPlace | undefined) ??
    'downloads';
  const how =
    HOW_WORDS.find(([, pattern]) => pattern.test(words))?.[0] ??
    ((await decide(model, words, 'How should the files be tidied?', HOW_OPTIONS))[0]?.key as
      TidyHow | undefined) ??
    'type';
  return { place, how };
}

/** The folder names a tidy makes, in the person's language. */
export function tidyNames(lang: 'ar' | 'en') {
  const name = (key: TKey) => translate(lang, key);
  return {
    pdf: name('ask.tidy.folder.pdf'),
    images: name('ask.tidy.folder.images'),
    documents: name('ask.tidy.folder.documents'),
    spreadsheets: name('ask.tidy.folder.spreadsheets'),
    presentations: name('ask.tidy.folder.presentations'),
    archives: name('ask.tidy.folder.archives'),
    audio: name('ask.tidy.folder.audio'),
    video: name('ask.tidy.folder.video'),
    installers: name('ask.tidy.folder.installers'),
    invoices: name('ask.tidy.folder.invoices'),
  };
}

export interface TidyPreview {
  folder: string;
  folderName: string;
  how: TidyHow;
  moves: [string, string][];
  count: number;
}

/* ---------------------------------------------------------------- words */

/** What follows "find", "where is", "دور لي"…: the words to search the Library for. */
export function searchWords(words: string): string {
  const lead =
    /^(please\s+)?(can you\s+)?(find|search( for)?|look for|where('s| is| are)|open|show me|get me)\s+(me\s+)?(the\s+|my\s+|a\s+)?/i;
  const leadAr =
    /^(لو سمحت\s+)?(ممكن\s+)?(دور|دوّر|ابحث|ابحثي|فتش|وين|أين|افتح|طلع|جيب|هات)(\s+(لي|لى|عن|على))*\s+/;
  const trail = /\s+(file|document|pdf|for me|please|الملف|ملف|لو سمحت)\s*[?؟.!]*$/i;
  const cleaned = words
    .trim()
    .replace(/[?؟.!]+$/, '')
    .replace(lead, '')
    .replace(leadAr, '')
    .replace(trail, '')
    .trim();
  return cleaned || words.trim();
}

/** The decision a quick action is, with its short fixed reply. */
export function quickDecision(
  key: QuickKey,
  words: string,
  files: number,
  toolName: (tool: AskTool, lang: 'ar' | 'en') => string,
): Decision {
  const lang = languageOf(words);
  const empty: Decision = {
    say: '',
    act: 'answer',
    tool: null,
    query: '',
    fields: [],
    profile: '',
    x: -1,
    y: -1,
    text: '',
  };
  if (TOOLS.has(key)) {
    const tool = key as AskTool;
    if (!files) return { ...empty, say: translate(lang, 'ask.quick.noFiles') };
    return {
      ...empty,
      act: 'tool',
      tool,
      say: translate(lang, 'ask.quick.tool', { tool: toolName(tool, lang), count: files }),
    };
  }
  if (key === 'find') {
    const query = searchWords(words);
    return { ...empty, act: 'find', query, say: translate(lang, 'ask.quick.find', { query }) };
  }
  return empty;
}

/** An option's name on a choice button, in the person's language. */
export function optionLabel(
  key: QuickKey,
  lang: 'ar' | 'en',
  toolName: (tool: AskTool, lang: 'ar' | 'en') => string,
): string {
  if (TOOLS.has(key)) return toolName(key as AskTool, lang);
  return translate(lang, `ask.quick.option.${key}` as TKey);
}
