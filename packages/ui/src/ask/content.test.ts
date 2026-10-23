import { describe, expect, it } from 'vitest';
import { asksAboutWords, asksTheWorld, asksToReadOut } from './content';
import { fuzzyOffers, fuzzyPick } from './fuzzy';
import { settingAsked, settingFirst, settingsPageAsked, unknownSetting } from './settingsBook';

const QUESTION = /[?؟]|^(?:what|why|which|who|is|are|does|ما |ماذا|وش |ايش|ليش|لماذا|هل )/i;

/** Where the island's lanes take `words` in another app (`Island.tsx` `respond`): a setting, an offer, or the model. */
function outside(words: string): string {
  if (asksToReadOut(words)) return 'READ';
  if (asksAboutWords(words)) return 'MODEL';
  const asked = settingAsked(words, true);
  if (settingFirst(words, true) && asked) return `setting:${asked.entry.id}`;
  if (!/[?؟]/.test(words) && asked) return `setting:${asked.entry.id}`;
  if (!/[?؟]/.test(words) && settingsPageAsked(words) !== undefined) return 'page';
  const question = QUESTION.test(words.trim()) || asksTheWorld(words);
  if (!question && fuzzyPick(words, [], true)) return 'fuzzy';
  if (!question && fuzzyOffers(words, [], true).length) return 'offer';
  if (unknownSetting(words)) return 'unknown-setting';
  return 'MODEL';
}

/** Asked in an email, a chat or a page: none of these is about ZOOD's settings. */
const ABOUT_WORDS = [
  'summarize this email', 'summarise this', 'give me a summary of this email', 'what is this email about?', 'لخص الايميل', 'لخص لي هذا', 'وش يقول هالايميل؟',
  'write a reply', 'reply to this email', 'draft a reply saying I agree', 'make a response', 'write a polite reply declining', 'respond to him that I will be late',
  'رد عليه', 'اكتب رد', 'اكتب رد مهذب', 'رد على الايميل اني موافق', 'جاوبه اني مشغول', 'reply in english', 'رد عليه بالانجليزي',
  'analyse this, what should I do?', 'analyze this', 'what should I do?', 'what do you think of this offer', 'is this a scam?', 'حلل هذا', 'وش رايك', 'وش اسوي؟', 'انصحني', 'هل هذا احتيال؟',
  'translate this', 'translate this email to arabic', 'ترجم هذا', 'ترجم الايميل للانجليزي',
  'make this shorter', 'make it more formal', 'fix my grammar', 'rewrite this', 'اختصر هذا', 'خله رسمي', 'صحح الاخطاء', 'اعد صياغة هذا',
  'what is the capital of Japan?', 'how many days until Ramadan', 'tell me a joke', 'who are you', 'how do I write a CV', 'عاصمة اليابان', 'قل لي نكتة', 'كيف اكتب سيرة ذاتية', 'متى رمضان',
  'explain this', 'اشرح هذا', 'what does this mean', 'extract the dates from this', 'make a to-do list from this email', 'add this to my calendar', 'list the action items', 'وش المطلوب مني',
  'change the tone to friendly', 'make the reply shorter',
];

/** Still Settings, from anywhere. */
const SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['answer in english', 'setting:answerLanguage'], ['رد علي بالانجليزي', 'setting:answerLanguage'], ['turn off talk back', 'setting:talkBack'],
  ['turn on dark mode', 'setting:theme'], ['change the menu', 'setting:menuBar'],
];

describe('Ask ZOOD in another app', () => {
  it('sends requests about words to the model, never to Settings or a "Did you mean"', () => {
    const wrong = ABOUT_WORDS.map((words) => [words, outside(words)]).filter(([, got]) => got !== 'MODEL');
    expect(wrong).toEqual([]);
  });

  it('never lets the quick tools take a request about words', () => {
    // The real decider took these for Extract text and for tidying (cloud CPU, 2026-10-23).
    for (const words of ['extract the dates from this email', 'make a to-do list from this', 'list the phone numbers in this message', 'طلع المواعيد من الايميل'])
      expect(asksAboutWords(words), words).toBe(true);
  });

  it('reads the window aloud when asked to', () => {
    for (const words of ['read this to me', 'read it out loud', 'read the email', 'اقرأ لي هذا', 'اقرا الايميل']) expect(outside(words), words).toBe('READ');
  });

  it('still opens Settings for a setting named', () => {
    for (const [words, expected] of SETTINGS) expect(outside(words), words).toBe(expected);
  });
});
