import type { ToolId } from '../../tools/tools';

/**
 * The app, at the person's word: a short command typed into the chat —
 * "open compress", "go to page 5", "dark mode", "افتح الإعدادات" — is done
 * at once, on this device, with no model asked. Only what can be undone in
 * one more step is here: a panel opened, a page shown, the theme changed.
 * Nothing is saved, deleted or sent.
 *
 * A command starts with what to do ("open", "go to", "افتح"…) or is a bare
 * name of a place ("dark mode", "settings"), and is short; anything else —
 * "how do I compress a file?" — is a question, and goes to the model, which
 * is told these commands so it can hand them over.
 */
export type Command =
  | { kind: 'tool'; tool: ToolId }
  | { kind: 'openFile' }
  | { kind: 'home' }
  | { kind: 'settings' }
  | { kind: 'theme'; theme: 'dark' | 'light' }
  | { kind: 'page'; page: number }
  | { kind: 'find'; query: string }
  | { kind: 'zoom'; direction: 'in' | 'out' }
  | { kind: 'tour' }
  | { kind: 'shortcuts' };

/** The tools that need no PDF open: they work on files of their own. */
export const NO_FILE_TOOLS: readonly ToolId[] = ['batch', 'library', 'create', 'combine'];

/** As compared: no tashkeel or tatweel, one alef, yaa and taa marbuta, Western digits, lower case, single spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/[.!؟?،,؛;:"'«»()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Courtesies before the command, taken off: "please", "can you", "zood", "لو سمحت", "ممكن". */
const POLITE =
  /^(?:(?:hey |hi |ok |okay )?zood |please |pls |can you |could you |would you |will you |i want (?:you )?to |i want |i'd like to |let's |lets |زود |يا زود |لو سمحت |من فضلك |فضلا |ممكن |ابي |ابغي |ابغى |بغيت |اريد |اريدك |عطني |هات |تقدر )+/;

/** What to do, at the start. */
const VERB =
  /^(?:open(?: up)?|show(?: me)?|go(?: back)? to|go|take me to|bring up|switch to|switch|turn on|turn off|use|start|launch|enable|disable|make it|set|change to|افتح(?:ي|لي)?|فتح|اعرض|اعرض لي|وريني|ورني|روح(?: الي| لل| ل)?|رح(?: الي| ل)?|اذهب(?: الي| لل| ل)?|انتقل(?: الي| لل| ل)?|ودني(?: الي| لل| ل)?|خذني(?: الي| لل| ل)?|ارجع(?: الي| لل| ل)?|حول(?: الي| لل| ل)?|بدل(?: الي| لل| ل)?|شغل|فعل|طفي|اطفي|غير(?: الي| لل| ل)?|استخدم)(?:\s+|$)/;

/** Words that are a command on their own, being what they do: "compress", "دمج". */
interface Target {
  pattern: RegExp;
  command: Command;
}

const tool = (id: ToolId): Command => ({ kind: 'tool', tool: id });

/** The places and tools, by their names in English and Arabic; the first match wins, so the longer names come first. */
const TARGETS: readonly Target[] = [
  { pattern: /^(?:the )?(?:dark|night)(?: mode| theme)?$|^(?:ال)?(?:وضع )?(?:ال)?(?:ليلي|داكن|مظلم)$/, command: { kind: 'theme', theme: 'dark' } },
  { pattern: /^(?:the )?(?:light|day)(?: mode| theme)?$|^(?:ال)?(?:وضع )?(?:ال)?(?:نهاري|فاتح)$/, command: { kind: 'theme', theme: 'light' } },
  { pattern: /^(?:a |the )?(?:pdf|file|document)$|^(?:a )?(?:new )?(?:pdf )?file$|^(?:ملف|مستند|ملف pdf|pdf)$/, command: { kind: 'openFile' } },
  { pattern: /^(?:the )?(?:home|home screen|start screen|start)$|^(?:ال)?(?:رئيسيه|شاشه الرئيسيه|الشاشه الرئيسيه|صفحه الرئيسيه|الصفحه الرئيسيه)$/, command: { kind: 'home' } },
  { pattern: /^(?:the )?(?:settings|preferences|options)$|^(?:ال)?(?:اعدادات|ضبط|تفضيلات)$/, command: { kind: 'settings' } },
  { pattern: /^(?:the )?(?:tour|welcome tour|tutorial|guide|help center|help centre)$|^(?:ال)?(?:جوله|جوله التعريفيه|شرح|مساعده)$/, command: { kind: 'tour' } },
  { pattern: /^(?:the )?(?:keyboard )?shortcuts$|^(?:ال)?اختصارات$/, command: { kind: 'shortcuts' } },
  { pattern: /^(?:my |the )?(?:library|documents|my documents)$|^(?:ال)?مكتب(?:ه|تي)$|^مستنداتي$/, command: tool('library') },
  { pattern: /^(?:the )?(?:digital signature|certificates?)$|^(?:ال)?(?:توقيع الرقمي|شهادات?)$/, command: tool('certificates') },
  { pattern: /^(?:the )?(?:prepare|make|create) (?:a )?form$|^(?:ال)?اعداد (?:ال)?نموذج$/, command: tool('prepareForm') },
  { pattern: /^(?:the )?(?:watermark|page numbers?|headers?|footers?|page marks)$|^(?:ال)?(?:علامه (?:ال)?مائيه|ترقيم(?: الصفحات)?|ارقام الصفحات|علامات الصفحات)$/, command: tool('pageMarks') },
  { pattern: /^(?:to |into )?(?:word|excel|powerpoint|text|images?)$|^(?:the )?(?:export|convert|conversion)$|^(?:the )?(?:convert|export)(?: (?:it|this|pdf))?(?: to| into)? (?:word|excel|powerpoint|text|images?)$|^(?:ال)?(?:تصدير|تحويل)(?: (?:الي|ل))? ?(?:وورد|ورد|اكسل|اكسيل|بوربوينت|باوربوينت|نص|صور)?$|^(?:الي |ل)?(?:وورد|ورد|اكسل|اكسيل|بوربوينت|باوربوينت)$/, command: tool('export') },
  { pattern: /^(?:the )?(?:compress(?:ion)?|shrink|make (?:it )?smaller)$|^(?:ال)?(?:ضغط|تصغير(?: الحجم)?|صغر الحجم)$|^اضغط(?:ه)?$/, command: tool('compress') },
  { pattern: /^(?:the )?(?:combine|merge|join)(?: (?:files|pdfs))?$|^(?:ال)?(?:دمج|ادمج)(?: (?:ال)?ملفات)?$/, command: tool('combine') },
  { pattern: /^(?:the )?(?:ocr|scan(?: (?:&|and) ocr)?|text recognition|recogni[sz]e(?: text)?)$|^(?:ال)?(?:تعرف(?: علي النص)?|مسح(?: ضوئي)?|ocr)$/, command: tool('ocr') },
  { pattern: /^(?:the )?(?:edit|edit text|editing|editor)$|^(?:ال)?(?:تحرير|تعديل)(?: (?:ال)?نص)?$/, command: tool('edit') },
  { pattern: /^(?:the )?(?:organi[sz]e|organi[sz]e pages|rotate|rotate pages|pages|reorder pages)$|^(?:ال)?(?:تنظيم|ترتيب|تدوير)(?: (?:ال)?صفحات)?$/, command: tool('organize') },
  { pattern: /^(?:the )?(?:comments?|annotate|annotations?|highlight)$|^(?:ال)?(?:تعليق|تعليقات|تظليل)$/, command: tool('comment') },
  { pattern: /^(?:the )?(?:fill(?: (?:&|and) sign)?|sign(?: it)?|signature|fill (?:the |a )?form)$|^(?:ال)?(?:تعبئه|توقيع|تعبئه وتوقيع|وقع|وقعه)$/, command: tool('fillSign') },
  { pattern: /^(?:the )?(?:protect(?:ion)?|password|lock(?: it)?|encrypt)$|^(?:ال)?(?:حمايه|كلمه (?:ال)?مرور|قفل|تشفير)$/, command: tool('protect') },
  { pattern: /^(?:the )?(?:redact(?:ion)?|black out)$|^(?:ال)?(?:تنقيح|حجب)$/, command: tool('redact') },
  { pattern: /^(?:the )?(?:compare|comparison|diff)(?: (?:two )?(?:files|pdfs))?$|^(?:ال)?(?:مقارنه|قارن)$/, command: tool('compare') },
  { pattern: /^(?:the )?(?:create(?: a)? pdf|new pdf|make a pdf)$|^(?:ال)?(?:انشاء|انشئ)(?: pdf| ملف)?$/, command: tool('create') },
  { pattern: /^(?:the )?(?:standards|pdf ?\/ ?a)$|^(?:ال)?معايير$/, command: tool('standards') },
  { pattern: /^(?:the )?accessibility$|^(?:ال)?(?:اتاحه الوصول|وصول)$/, command: tool('accessibility') },
  { pattern: /^(?:the )?batch(?: processing)?$|^(?:ال)?(?:معالجه (?:ال)?دفعيه|دفعه)$/, command: tool('batch') },
];

/** Verbs that name their tool, a command with nothing after them or "it", "this", "the file": "compress it", "ادمج". */
const SELF: readonly Target[] = [
  { pattern: /^(?:compress|shrink)(?: (?:it|this|the file|the pdf|this file))?$|^اضغط(?:ه|ها)?(?: (?:ال)?ملف)?$/, command: tool('compress') },
  { pattern: /^(?:combine|merge)(?: (?:them|files|pdfs|my files))?$|^ادمج(?:هم)?(?: (?:ال)?ملفات)?$/, command: tool('combine') },
  { pattern: /^(?:sign)(?: (?:it|this|the file|the pdf))?$|^وقع(?:ه|ها)?$/, command: tool('fillSign') },
  { pattern: /^(?:protect|lock|encrypt)(?: (?:it|this|the file|the pdf))?$|^(?:احم|احمي|اقفل|شفر)(?:ه|ها)?(?: (?:ال)?ملف)?$/, command: tool('protect') },
  { pattern: /^(?:redact)(?: (?:it|this))?$|^نقح(?:ه|ها)?$/, command: tool('redact') },
  { pattern: /^(?:rotate|organi[sz]e)(?: (?:the )?pages)?$|^(?:دور|نظم|رتب) (?:ال)?صفحات$/, command: tool('organize') },
  { pattern: /^(?:convert|export)(?: (?:it|this|the file|the pdf))?(?: to| into)? (?:word|excel|powerpoint|text|images?)$|^حول(?:ه|ها)? (?:الي |ل)?(?:وورد|ورد|اكسل|اكسيل|بوربوينت|باوربوينت|نص|صور)$/, command: tool('export') },
  { pattern: /^zoom in$|^كبر(?: (?:ال)?(?:عرض|صفحه))?$|^تكبير$/, command: { kind: 'zoom', direction: 'in' } },
  { pattern: /^zoom out$|^صغر(?: (?:ال)?(?:عرض|صفحه))?$|^تصغير$/, command: { kind: 'zoom', direction: 'out' } },
];

/** Longer than this, words are a message, not a command. */
const LONGEST = 60;

/** The command `text` is, or null when it is a message for the model. */
export function commandOf(text: string): Command | null {
  if (text.trim().length > LONGEST || /\n/.test(text.trim())) return null;
  let words = normalize(text);
  // A question is never a command: "how do I compress?", "كيف اضغط".
  if (/[?؟]/.test(text) || /^(?:how|what|why|when|where|which|who|can i|do i|is there|does|كيف|ليش|لماذا|ماذا|ما هو|ما هي|وش|ايش|متي|هل|اين|وين)(?=\s|$)/.test(words)) return null;
  words = words.replace(POLITE, '').replace(/ (?:please|pls|now|for me|thanks|لو سمحت|من فضلك|فضلا|الحين|الان|لي)$/, '').trim();
  // "Go to page 5", "page 12", "الصفحه 3", "صفحه ٤".
  const page = /^(?:(?:go|jump|skip|move|take me) ?(?:to)? |(?:روح|اذهب|انتقل|ودني|خذني|افتح)(?: الي| لل| ل)? ?)?(?:the )?(?:page|(?:ال)?صفحه|ل?لصفحه) (?:number |رقم )?(\d{1,5})$/.exec(words);
  if (page) return { kind: 'page', page: Number(page[1]) };
  // "Find invoice", "search for the fee", "ابحث عن الرسوم".
  // A bare "دوّر" is also "rotate" ("دور الصفحات"): it searches only with "على" or "عن".
  const find = /^(?:find|search for|search|look for|ابحث عن|ابحث|دور علي|دور عن)\s+(.+)$/.exec(words);
  if (find) {
    // The words looked for as they were typed, with their marks: the words before them dropped.
    const said = text.trim().replace(/[.!؟?،,؛;:"'«»()]+/g, ' ').split(/\s+/).filter(Boolean);
    const query = said.slice(Math.max(0, said.length - (find[1] ?? '').split(' ').length)).join(' ');
    if (query.length > 0 && query.length <= 40) return { kind: 'find', query };
  }
  for (const self of SELF) if (self.pattern.test(words)) return self.command;
  const verb = VERB.exec(words);
  const rest = verb ? words.slice(verb[0].length).trim() : words;
  // "Turn off dark mode" is light mode, and the other way round.
  if (verb && /^(?:turn off|disable|طفي|اطفي)/.test(verb[0])) {
    if (/^(?:the )?(?:dark|night)(?: mode)?$|^(?:ال)?(?:وضع )?(?:ال)?(?:ليلي|داكن)$/.test(rest)) return { kind: 'theme', theme: 'light' };
    if (/^(?:the )?(?:light|day)(?: mode)?$|^(?:ال)?(?:وضع )?(?:ال)?(?:نهاري|فاتح)$/.test(rest)) return { kind: 'theme', theme: 'dark' };
    return null;
  }
  for (const target of TARGETS) {
    if (!target.pattern.test(rest)) continue;
    // A bare word is a command only for a place or a mode: "settings", "dark mode" — not "word" or "pages" said alone.
    if (!verb && target.command.kind === 'tool' && !/^(?:(?:my |the )?library|مكتبتي|المكتبه|batch)$/.test(rest)) return null;
    if (!verb && target.command.kind === 'openFile') return null;
    return target.command;
  }
  return null;
}
