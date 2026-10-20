import { schemaToGrammar } from '../ai/device/grammar';
import { ALL_TARGETS, TARGET_WORDS, valueOf } from '../ai/profile/wallet';
import type { Target, WalletProfile } from '../ai/profile/wallet';

/**
 * What Ask ZOOD decides, and how the model is asked for it.
 *
 * The person's words go to the model they chose, with what the moment holds
 * — the files selected when the keys went down, the names (never the
 * values) of their saved details, and, for a model that reads pictures, the
 * screen — and the model answers with one decision in JSON, held to its
 * shape by a grammar: something to say aloud, and at most one thing to do.
 * The decision is checked again here before anything is shown: a tool with
 * no files, a detail with no value, a point off the screen are not done.
 */

/** The quick tools Ask ZOOD can run, as the host knows them (`quick.rs`, `TOOLS`). */
export const ASK_TOOLS = [
  'compress',
  'word',
  'excel',
  'powerpoint',
  'text',
  'images',
  'ocr',
  'combine',
  'protect',
  'unlock',
  'rotate',
  'extract',
  'split',
  'resize',
  'numbers',
  'watermark',
  'sign',
  'topdf',
] as const;
export type AskTool = (typeof ASK_TOOLS)[number];

/** What each tool does, as the model is told. */
const TOOL_WORDS: Record<AskTool, string> = {
  compress: 'make the files smaller',
  word: 'convert PDF to Word',
  excel: 'convert PDF tables to Excel',
  powerpoint: 'convert PDF to PowerPoint',
  text: 'take the text out of a PDF',
  images: 'turn PDF pages into pictures',
  ocr: 'recognise the text of a scanned PDF (Arabic and English)',
  combine: 'combine several files into one PDF',
  protect: 'protect a PDF with a password',
  unlock: 'remove a PDF password',
  rotate: 'rotate pages',
  extract: 'take some pages out into a new PDF',
  split: 'split a PDF into parts',
  resize: 'change the page size',
  numbers: 'add page numbers',
  watermark: 'add a watermark',
  sign: 'sign the PDF',
  topdf: 'make a PDF of pictures or Office files',
};

export type Act = 'answer' | 'tool' | 'find' | 'fill' | 'point';

export interface Decision {
  /** What is said aloud and shown: one or two short sentences. */
  say: string;
  act: Act;
  tool: AskTool | null;
  /** Words to look for in the Library. */
  query: string;
  /** The details to type, in order, with Tab between them. */
  fields: Target[];
  /** The profile whose details are typed. */
  profile: string;
  /** Where to click, in thousandths of the screen. */
  x: number;
  y: number;
}

/** What the model is told about the moment it is asked in. */
export interface Moment {
  /** The names of the files selected in File Explorer or Finder. */
  files: readonly string[];
  /** A picture of the screen goes with the question. */
  screen: boolean;
  profiles: readonly WalletProfile[];
}

/** The details a profile has a value for: all the model may choose from. */
export function filledTargets(profile: WalletProfile | undefined): Target[] {
  if (!profile) return [];
  const known: Target[] = ALL_TARGETS.filter((target) => valueOf(profile, target) !== '');
  for (const custom of profile.custom) if (custom.value.trim() && custom.label.trim()) known.push(`custom.${custom.label}`);
  return known;
}

function acts(moment: Moment): Act[] {
  return moment.screen ? ['answer', 'tool', 'find', 'fill', 'point'] : ['answer', 'tool', 'find', 'fill'];
}

function targetsOf(moment: Moment): Target[] {
  const all = new Set<Target>();
  for (const profile of moment.profiles) for (const target of filledTargets(profile)) all.add(target);
  return [...all];
}

/** The decision's shape, as a grammar the model's sampling is held to. */
export function decisionGrammar(moment: Moment): string {
  const targets = targetsOf(moment);
  const profiles = moment.profiles.map((profile) => profile.name);
  const properties: Record<string, object> = {
    say: { type: 'string' },
    act: { enum: acts(moment) },
    tool: { enum: [...ASK_TOOLS, 'none'] },
    query: { type: 'string' },
    // An enum needs one value at least; with nothing saved, an empty list is the only answer.
    fields: { type: 'array', items: { enum: targets.length ? targets : ['none'] } },
    profile: { enum: profiles.length ? profiles : ['none'] },
  };
  if (moment.screen) {
    properties.x = { type: 'integer' };
    properties.y = { type: 'integer' };
  }
  return schemaToGrammar({ type: 'object', properties, required: Object.keys(properties) });
}

/** The instructions the model is given, in English: the reply follows the person's language. */
export function systemPrompt(moment: Moment): string {
  const files = moment.files.length ? moment.files.map((name) => `- ${name}`).join('\n') : '(no files are selected)';
  const tools = ASK_TOOLS.map((tool) => `- ${tool}: ${TOOL_WORDS[tool]}`).join('\n');
  const details = targetsOf(moment)
    .map((target) => {
      const words = TARGET_WORDS[target as keyof typeof TARGET_WORDS];
      return `- ${target}${words ? ` (${words.en} / ${words.ar})` : ''}`;
    })
    .join('\n');
  const profiles = moment.profiles.map((profile) => profile.name).join(', ');
  const lines = [
    'You are Ask ZOOD, the assistant of ZOOD PDF, running on the person\'s own computer. The person held a key and spoke; you get their words as text (it may have small mistakes). Decide one action and a short reply.',
    '',
    'Actions:',
    '- "tool": run a ZOOD quick tool on the selected files. Only when files are selected. Put the tool in "tool".',
    '- "find": find a document in the person\'s Library. Put the words to search for in "query", in the language the document is likely written in.',
    '- "fill": type the person\'s saved details where their cursor is, in order, pressing Tab between them. Put the details in "fields" and the profile in "profile".',
  ];
  if (moment.screen) {
    lines.push('- "point": show the person where to click next on the screen in the picture. Put the place in "x" and "y", in thousandths of the picture\'s width and height (0 to 1000).');
  }
  lines.push(
    '- "answer": only answer: a question about ZOOD PDF or about the screen, or anything that fits no action.',
    '',
    'Selected files:',
    files,
    '',
    'Quick tools:',
    tools,
    '',
    `Saved details (their values are typed by the app, never told to you)${profiles ? `, profiles: ${profiles}` : ''}:`,
    details || '(nothing is saved yet: "fill" cannot be used)',
    '',
    'ZOOD PDF can also: edit PDF text, fill and sign forms, read aloud, compare two PDFs, redact, translate with the on-device AI, search the Library, and be used from a phone as a remote.',
    '',
    'Rules: reply in the language the person spoke (Arabic or English), in one or two short sentences that sound natural read aloud. Never make up file names, values or places. When the request needs something that is missing (no files selected, a detail not saved), use "answer" and say what is needed. Fill unused fields with "none", "", [] or 0.',
  );
  return lines.join('\n');
}

const TOOL_SET = new Set<string>(ASK_TOOLS);

/** The model's JSON as a decision that can be done, or null when it is not one. */
export function readDecision(text: string, moment: Moment): Decision | null {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const say = typeof raw.say === 'string' ? raw.say.trim().slice(0, 400) : '';
  let act: Act = acts(moment).includes(raw.act as Act) ? (raw.act as Act) : 'answer';
  const tool = typeof raw.tool === 'string' && TOOL_SET.has(raw.tool) ? (raw.tool as AskTool) : null;
  const query = typeof raw.query === 'string' ? raw.query.trim().slice(0, 200) : '';
  const profile = moment.profiles.find((one) => one.name === raw.profile) ?? moment.profiles[0];
  const allowed = new Set(filledTargets(profile));
  const fields = Array.isArray(raw.fields) ? (raw.fields.filter((field) => typeof field === 'string' && allowed.has(field as Target)) as Target[]).slice(0, 20) : [];
  const coordinate = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(1000, Math.max(0, Math.round(value))) : -1);
  const x = coordinate(raw.x);
  const y = coordinate(raw.y);

  // What cannot be done is not done: it is said instead.
  if (act === 'tool' && (!tool || moment.files.length === 0)) act = 'answer';
  if (act === 'find' && !query) act = 'answer';
  if (act === 'fill' && fields.length === 0) act = 'answer';
  if (act === 'point' && (x < 0 || y < 0 || !moment.screen)) act = 'answer';
  if (!say && act === 'answer') return null;
  return { say, act, tool: act === 'tool' ? tool : null, query, fields: act === 'fill' ? fields : [], profile: profile?.name ?? '', x, y };
}

/**
 * Arabic when a fair part of the text is in Arabic letters: someone asking
 * in Arabic often names a file or an app in English.
 */
export function languageOf(text: string): 'ar' | 'en' {
  const arabic = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > 0 && arabic * 2 >= latin ? 'ar' : 'en';
}
