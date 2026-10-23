/**
 * Requests about words, not about ZOOD: "summarize this email", "write a
 * reply", "اكتب رد مهذب", "what should I do?", "make it more formal". They
 * go to the model with the window's words, never to Settings or the word
 * matcher, which once took "write a reply" for the double-tap setting
 * (its name has "reply" in it) and "make it more formal" for the tab bar.
 * A request that says "setting" is about Settings, and is left to them.
 */

/** Lower case, without Arabic's marks and with one alef; «ى» kept, so «رد على» is not «رد علي». */
function simple(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/\s+/g, ' ')
    .trim();
}

const SETTING = /\bsettings?\b|\bpreferences?\b|اعداد/;

const ENGLISH = new RegExp(
  [
    String.raw`\b(?:write|draft|compose|reply|respond|summar(?:y|ies|i[sz]e\w*)|translate|rewrite|rephrase|reword|paraphrase|proofread|shorten|analy[sz]\w*|tl;?dr)\b`,
    String.raw`\bmake (?:it|this|that|the (?:reply|email|message|text|answer))\b.*\b(?:shorter|longer|formal|friendl\w*|polite\w*|nicer|kinder|clearer|simpler|professional|casual|warmer|firmer)\b`,
    String.raw`\bfix (?:my |the |this )?(?:grammar|spelling|typos?|wording)\b`,
    String.raw`\b(?:tone|to-?do|todo|action items?|key points|calendar|reminder)\b`,
    String.raw`\bwhat (?:should|do) i (?:do|say|answer|reply|write)\b`,
    String.raw`\bwhat (?:is|does) (?:this|that|it) (?:email|message|letter|text|say|mean)\b`,
    String.raw`\bwhat do you think\b|\bis (?:this|it) (?:a )?(?:scam|fake|phishing|spam|safe)\b`,
  ].join('|'),
);

const ARABIC = new RegExp(
  [
    String.raw`(?:^| )(?:اكتب|اكتبي|اكتبلي|اكتب لي|صيغ|ردلي|رد لي|جاوب|جاوبه|جاوبها|جاوبهم|لخص|لخصلي|ملخص|تلخيص|ترجم|ترجملي|اختصر|صحح|حلل|حللي|انصحني|نسق)(?= |$)`,
    String.raw`(?:^| )رد (?:عليه|عليها|عليهم|على|ع)(?= |$)`,
    String.raw`صياغه|صياغة|نبره|نبرة|رسمي|بلطف|مهذب|المطلوب مني|مهام|تقويم|موعد`,
    String.raw`(?:^| )(?:وش|ايش|ماذا) (?:اسوي|اسويه|افعل|ارد|اكتب|يقول|يقصد|تقصد|رايك)(?= |$)`,
    String.raw`احتيال|نصب`,
  ].join('|'),
);

/** Whether `words` ask for something done with words (written, summed up, read, judged), not with ZOOD. */
export function asksAboutWords(words: string): boolean {
  const said = simple(words);
  if (!said || SETTING.test(said)) return false;
  return ENGLISH.test(said) || ARABIC.test(said);
}

const READ_OUT =
  /\bread (?:this|it|that|me|the (?:email|message|page|text|letter|article|reply))\b|\bread (?:aloud|out)\b|(?:^| )(?:اقرا|اقرالي|اقراه|اقراها)(?= |$)/;

/** "Read this to me", «اقرأ لي هذا»: the window's words said aloud. */
export function asksToReadOut(words: string): boolean {
  const said = simple(words);
  return !SETTING.test(said) && READ_OUT.test(said);
}

const WORLD = /^(?:how (?:many|much|long|old|far)|when (?:is|are|was|does|did|will)|tell me (?:a|about)|كم |متى |قل لي |قول لي )/;

/** A question about the world, not a command: "how many days until Ramadan", «متى العيد». */
export function asksTheWorld(words: string): boolean {
  return WORLD.test(simple(words));
}
