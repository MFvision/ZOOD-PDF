/**
 * What ZOOD suggests for files thrown on it (`src-tauri/src/sort.rs`): the
 * rules, with no model. Pictures and PDFs in a series ("scan 1", "scan 2")
 * become one PDF; a PDF that holds several documents (three invoices scanned
 * together) becomes one file each; every file goes into a folder by what it
 * is; names that say nothing ("IMG_2034", "scan0001") get one that does.
 * The on-device model may then name the kind of a file the rules could not
 * (`ai.ts`). Nothing here touches a file: the window does what is chosen.
 */

export type FileKind =
  | 'pdf'
  | 'images'
  | 'documents'
  | 'spreadsheets'
  | 'presentations'
  | 'archives'
  | 'audio'
  | 'video'
  | 'installers'
  | 'other';

/** A file of the session, as the host gives it. */
export interface SortFile {
  index: number;
  name: string;
  path: string;
  size: number;
  /** Last changed: "2026-10-21". */
  day: string;
  kind: FileKind;
  /** Made by this sort (a merge or a split). */
  made: boolean;
}

/** What a file says, as the host read it. */
export interface FileLook {
  pages: number;
  texts: string[];
  title: string;
  locked: boolean;
}

/** What a document is about: the folders a sort makes, beyond the kinds of file. */
export const TOPICS = ['invoices', 'bank', 'contracts', 'ids', 'travel', 'medical', 'cvs', 'certificates'] as const;
export type Topic = (typeof TOPICS)[number];
/** A file's folder: its topic, or its kind when it has none. */
export type Shelf = Topic | FileKind | 'originals';

/** Words that make a document one of a topic, in its name or its words; the first topic found wins. */
const TOPIC_WORDS: Record<Topic, { en: RegExp; ar: readonly string[] }> = {
  invoices: { en: /\b(tax invoice|invoice|receipt|bill|inv[-_]\d)/i, ar: ['فاتورة', 'فواتير', 'ﻓﺎﺗﻮرة', 'إيصال', 'ايصال', 'سند قبض'] },
  bank: { en: /\b(bank statement|account statement|statement of account|iban|bank transfer)\b/i, ar: ['كشف حساب', 'كشف الحساب', 'حوالة', 'آيبان', 'ايبان'] },
  contracts: { en: /\b(contract|agreement|nda|lease|terms and conditions)\b/i, ar: ['عقد', 'اتفاقية', 'مذكرة تفاهم'] },
  ids: { en: /\b(passport|national id|iqama|id card|identity card|driving licen[cs]e|driver'?s licen[cs]e|residence permit)\b/i, ar: ['هوية', 'جواز', 'إقامة', 'اقامة', 'رخصة قيادة', 'بطاقة الأحوال'] },
  travel: { en: /\b(boarding pass|e-?ticket|itinerary|booking confirmation|reservation|flight|hotel)\b/i, ar: ['تذكرة', 'حجز', 'بطاقة صعود', 'رحلة', 'فندق'] },
  medical: { en: /\b(medical|prescription|lab results?|clinic|hospital|diagnosis)\b/i, ar: ['تقرير طبي', 'وصفة', 'مستشفى', 'عيادة', 'تحاليل', 'تحليل'] },
  cvs: { en: /\b(resume|résumé|curriculum vitae|cv)\b/i, ar: ['سيرة ذاتية', 'السيرة الذاتية'] },
  certificates: { en: /\b(certificate|diploma|certification)\b/i, ar: ['شهادة'] },
};

/** The topic `text` names, if any. */
export function topicOfText(text: string): Topic | null {
  if (!text) return null;
  for (const topic of TOPICS) {
    const words = TOPIC_WORDS[topic];
    if (words.en.test(text) || words.ar.some((word) => text.includes(word))) return topic;
  }
  return null;
}

/** A file's topic: from its name first, then from its first pages. */
export function topicOf(file: SortFile, look: FileLook | undefined): Topic | null {
  return topicOfText(stemOf(file.name).replace(/[_-]+/g, ' ')) ?? topicOfText((look?.texts ?? []).slice(0, 2).join('\n'));
}

export const stemOf = (name: string) => name.replace(/\.[^.\\/]{1,8}$/, '');
const extensionOf = (name: string) => /\.([^.\\/]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? '';

/* ------------------------------------------------------------------ merge */

/** A trailing number, "(2)", "copy", "page 3", "صفحة ٣": what a series of files differs by. */
const COPY = /[\s_\-.]*(\(\d+\)|copy|نسخة)$/i;
const NUMBERED = /[\s_\-.]*(page|pg|part|صفحة|جزء)?[\s_\-.]*([0-9٠-٩]{1,4})$/i;
/** "Report 2026": a year is part of the name, not a place in a series. */
const YEAR = /^(19|20)\d\d$/;
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toNumber = (digits: string) => Number([...digits].map((d) => (ARABIC_DIGITS.includes(d) ? ARABIC_DIGITS.indexOf(d) : d)).join(''));

/** The name a file shares with the rest of its series, and its number in it (0 when none). */
export function seriesOf(name: string): { base: string; key: string; number: number; numbered: boolean } {
  let base = stemOf(name).trim();
  let numbered = false;
  let number = 0;
  if (COPY.test(base)) {
    base = base.replace(COPY, '');
    numbered = true;
    number = 1;
  }
  const match = NUMBERED.exec(base);
  if (match && match.index > 0 && !(match[2]!.length === 4 && YEAR.test(match[2]!) && !match[1])) {
    number = toNumber(match[2]!);
    base = base.slice(0, match.index);
    numbered = true;
  }
  base = base.replace(/[\s_\-.]+$/, '');
  return { base, key: base.toLowerCase(), number, numbered };
}

/** Photos from a camera or phone are not pages of a document: they are not merged. */
const CAMERA = /^(img|dsc|dscn|dcim|pxl|photo|image|vid|mvimg|screenshot|screen shot|لقطة شاشة|صورة|whatsapp image.*)$/i;
const SCAN_WORDS = /scan|camscanner|document|doc|page|مسح|ممسوح|مستند|صفحة/i;

export interface MergeSuggestion {
  id: string;
  kind: 'merge';
  /** The files, in the order their pages go. */
  files: number[];
  /** PDFs are combined; pictures become the pages of one PDF. */
  as: 'pdf' | 'images';
  /** The merged file's name, without ".pdf". */
  name: string;
}

export function mergeSuggestions(files: readonly SortFile[]): MergeSuggestion[] {
  const groups = new Map<string, { file: SortFile; number: number; numbered: boolean; base: string }[]>();
  for (const file of files) {
    if (file.made || (file.kind !== 'pdf' && file.kind !== 'images')) continue;
    const series = seriesOf(file.name);
    if (!series.key) continue;
    if (file.kind === 'images' && CAMERA.test(series.key) && !SCAN_WORDS.test(series.key)) continue;
    const key = `${file.kind}:${series.key}`;
    const group = groups.get(key) ?? [];
    group.push({ file, ...series });
    groups.set(key, group);
  }
  const suggestions: MergeSuggestion[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2 || group.length > 60 || !group.some((member) => member.numbered)) continue;
    group.sort((a, b) => a.number - b.number || a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));
    suggestions.push({
      id: `merge:${key}`,
      kind: 'merge',
      files: group.map((member) => member.file.index),
      as: group[0]!.file.kind === 'pdf' ? 'pdf' : 'images',
      name: group[0]!.base,
    });
  }
  return suggestions;
}

/* ------------------------------------------------------------------ split */

const PAGE_ONE = [/\bpage\s*1\s*(of|\/)\s*\d+/i, /صفحة\s*(1|١)\s*(من|\/)/, /^\s*(1|١)\s*\/\s*[0-9٠-٩]+\s*$/m];
const DOCUMENT_NUMBER = /(?:tax invoice|invoice|receipt|فاتورة(?: ضريبية)?|إيصال|ايصال)[^\n]{0,24}?(?:no\.?|number|#|رقم)\s*[:#.]?\s*([A-Za-z0-9٠-٩][A-Za-z0-9٠-٩\-/]{0,24})/i;

/** The pages (from 0) where a new document starts, the first always among them. */
export function documentStarts(texts: readonly string[]): number[] {
  const starts = [0];
  let number = texts[0] ? DOCUMENT_NUMBER.exec(texts[0])?.[1] ?? null : null;
  for (let page = 1; page < texts.length; page++) {
    const text = texts[page] ?? '';
    const found = DOCUMENT_NUMBER.exec(text)?.[1] ?? null;
    const newNumber = found !== null && number !== null && found !== number;
    if (newNumber || PAGE_ONE.some((pattern) => pattern.test(text))) starts.push(page);
    if (found !== null) number = found;
  }
  return starts;
}

export interface SplitSuggestion {
  id: string;
  kind: 'split';
  file: number;
  /** Each part's pages, from 0. */
  parts: number[][];
}

export function splitSuggestions(files: readonly SortFile[], looks: ReadonlyMap<number, FileLook>): SplitSuggestion[] {
  const suggestions: SplitSuggestion[] = [];
  for (const file of files) {
    const look = looks.get(file.index);
    if (file.made || file.kind !== 'pdf' || !look || look.pages < 2) continue;
    const starts = documentStarts(look.texts);
    if (starts.length < 2) continue;
    const parts = starts.map((start, k) => {
      const end = k + 1 < starts.length ? starts[k + 1]! : look.pages;
      return Array.from({ length: end - start }, (_, i) => start + i);
    });
    suggestions.push({ id: `split:${file.index}`, kind: 'split', file: file.index, parts });
  }
  return suggestions;
}

/* ----------------------------------------------------------------- rename */

/** Words a name made by a camera, a scanner or a download is made of. */
const EMPTY_WORDS =
  /\b(img|dsc|dscn|pxl|scan|scanned|document|doc|file|download|downloads|untitled|new|image|photo|screenshot|screen shot|camscanner|whatsapp image|at|pm|am|copy|page)\b|صورة|مستند|ملف|مسح|ممسوح|جديد|بدون عنوان|لقطة شاشة|نسخة|صفحة/gi;

/** A name that says nothing of what the file is: "IMG_2034", "scan0001", "Document (3)". */
export function saysNothing(name: string): boolean {
  const rest = stemOf(name).replace(/[\d٠-٩_\-.()[\]]+/g, ' ').replace(EMPTY_WORDS, ' ');
  return rest.replace(/[^\p{L}]/gu, '').length < 2;
}

/** A line of a document that names it: the first short line of words. */
export function namingLine(texts: readonly string[], title = ''): string {
  const cleanTitle = title.trim();
  if (cleanTitle && !saysNothing(cleanTitle) && cleanTitle.length <= 60) return words(cleanTitle, 6);
  for (const raw of (texts[0] ?? '').split(/\r?\n/).slice(0, 12)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const letters = line.replace(/[^\p{L}]/gu, '').length;
    if (line.length < 3 || line.length > 70 || letters < 3 || letters < line.length / 2) continue;
    if (PAGE_ONE.some((pattern) => pattern.test(line))) continue;
    // A heading that only says the kind ("Tax invoice"): the topic says that already.
    if (topicOfText(line) && line.split(' ').length <= 2) continue;
    return words(line, 6);
  }
  return '';
}

const words = (line: string, most: number) =>
  line
    .replace(/[/\\:*?"<>|]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, most)
    .join(' ');

export interface RenameSuggestion {
  id: string;
  kind: 'rename';
  names: { file: number; name: string }[];
}

/** The words the window gives each topic's name in a file's new name ("Invoice"). */
export type TopicWord = (topic: Topic) => string;

export function renameSuggestion(
  files: readonly SortFile[],
  looks: ReadonlyMap<number, FileLook>,
  topics: ReadonlyMap<number, Topic | null>,
  word: TopicWord,
): RenameSuggestion | null {
  const names: { file: number; name: string }[] = [];
  for (const file of files) {
    if (file.made || !saysNothing(file.name)) continue;
    const look = looks.get(file.index);
    const topic = topics.get(file.index) ?? null;
    const line = namingLine(look?.texts ?? [], look?.title ?? '');
    if (!topic && !line) continue;
    const parts = [topic ? word(topic) : '', line].filter(Boolean);
    // "Invoice - Invoice Jarir": the topic once.
    if (topic && line.toLowerCase().startsWith(word(topic).toLowerCase())) parts.shift();
    const name = [...parts, file.day].filter(Boolean).join(' - ');
    if (name && name !== stemOf(file.name)) names.push({ file: file.index, name });
  }
  return names.length ? { id: 'rename', kind: 'rename', names } : null;
}

/* ---------------------------------------------------------------- folders */

export interface FolderSuggestion {
  id: string;
  kind: 'folders';
  /** Each shelf and its files. */
  shelves: { shelf: Shelf; files: number[] }[];
}

export function shelfOf(file: SortFile, topic: Topic | null): Shelf {
  return topic ?? file.kind;
}

export function folderSuggestion(
  files: readonly SortFile[],
  topics: ReadonlyMap<number, Topic | null>,
  retired: ReadonlySet<number> = new Set(),
): FolderSuggestion | null {
  const shelves = new Map<Shelf, number[]>();
  for (const file of files) {
    if (retired.has(file.index)) continue;
    const shelf = shelfOf(file, topics.get(file.index) ?? null);
    shelves.set(shelf, [...(shelves.get(shelf) ?? []), file.index]);
  }
  const count = [...shelves.values()].reduce((sum, list) => sum + list.length, 0);
  if (count < 2) return null;
  return {
    id: 'folders',
    kind: 'folders',
    shelves: [...shelves.entries()].map(([shelf, list]) => ({ shelf, files: list })).sort((a, b) => b.files.length - a.files.length),
  };
}

/* -------------------------------------------------------------- the whole */

export type Suggestion = MergeSuggestion | SplitSuggestion | FolderSuggestion | RenameSuggestion;
export type SuggestionKind = Suggestion['kind'];
/** The order Do all goes in: new files first, then names, then folders. */
export const KIND_ORDER: readonly SuggestionKind[] = ['merge', 'split', 'rename', 'folders'];

export function topicsOf(files: readonly SortFile[], looks: ReadonlyMap<number, FileLook>, guessed: ReadonlyMap<number, Topic> = new Map()): Map<number, Topic | null> {
  return new Map(files.map((file) => [file.index, topicOf(file, looks.get(file.index)) ?? guessed.get(file.index) ?? null]));
}

export function suggest(
  files: readonly SortFile[],
  looks: ReadonlyMap<number, FileLook>,
  word: TopicWord,
  guessed: ReadonlyMap<number, Topic> = new Map(),
): Suggestion[] {
  const topics = topicsOf(files, looks, guessed);
  const merges = mergeSuggestions(files);
  const splits = splitSuggestions(files, looks);
  const rename = renameSuggestion(files, looks, topics, word);
  const folders = folderSuggestion(files, topics);
  return [...merges, ...splits, ...(rename ? [rename] : []), ...(folders ? [folders] : [])];
}

/** The files a suggestion works on, for counting and the voice. */
export function filesOf(suggestion: Suggestion): number[] {
  switch (suggestion.kind) {
    case 'merge':
      return suggestion.files;
    case 'split':
      return [suggestion.file];
    case 'rename':
      return suggestion.names.map((n) => n.file);
    case 'folders':
      return suggestion.shelves.flatMap((s) => s.files);
  }
}

export { extensionOf };
