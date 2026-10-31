/**
 * Going to a website, and answering Ask ZOOD back.
 *
 * "Can you go to Amazon dot com? Amazon dot sa" once went to the model as a
 * general question: it had no way to open a site, so it thought for a long
 * time and at best offered "do you want me to take you there?". The person's
 * "yes" then reached a new request with nothing to agree to. Here a site
 * that is asked for is opened in the browser at once, with no model, and a
 * short "yes" / «إيه» right after an answer acts on that answer.
 */

/** How long an answer can still be answered back: "yes" a few minutes later still means it. */
export const FOLLOW_UP_MS = 4 * 60_000;

/** The answer just given, kept so the next words can answer it. */
export interface LastTurn {
  words: string;
  /** What was said, then the longer text, if any. */
  say: string;
  text: string;
  /** A web address the answer is about, opened by a "yes". */
  url: string | null;
  at: number;
}

const ARABIC_DIACRITICS = /[ً-ْـ]/g;

function plain(words: string): string {
  return words
    .toLowerCase()
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[“”"«»'’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The endings of web addresses people say: "amazon dot sa", «امازون دوت كوم». */
const ENDINGS =
  'com|sa|net|org|io|ai|co|edu|gov|info|uk|ae|eg|com\\.sa|gov\\.sa|edu\\.sa|org\\.sa|net\\.sa|co\\.uk';
const SPOKEN_DOT = /\s*(?:\bdot\b|دوت|نقطة)\s*/g;
const SPOKEN_ENDING: Record<string, string> = {
  كوم: 'com',
  نت: 'net',
  اورج: 'org',
  'اس اي': 'sa',
  'اس ايه': 'sa',
};

/** Well-known sites people name without ".com": only those that are never also an app on the computer. */
const KNOWN_SITES: Record<string, string> = {
  amazon: 'amazon.sa',
  امازون: 'amazon.sa',
  noon: 'noon.com',
  نون: 'noon.com',
  google: 'google.com',
  قوقل: 'google.com',
  جوجل: 'google.com',
  youtube: 'youtube.com',
  يوتيوب: 'youtube.com',
  wikipedia: 'wikipedia.org',
  ويكيبيديا: 'wikipedia.org',
  linkedin: 'linkedin.com',
  لينكدان: 'linkedin.com',
  gmail: 'mail.google.com',
  جيميل: 'mail.google.com',
  absher: 'absher.sa',
  ابشر: 'absher.sa',
};

/** "go to", "open", "take me to", «افتح», «روح», «ودني». */
const GO =
  /(?:^|\b)(?:go to|goto|open(?: up)?|take me to|bring up|visit|navigate to|browse to|head to|launch|load|pull up)\b|(?:^|\s)(?:افتح|افتحي|روح|روحي|ودني|وديني|خذني|ادخل|اذهب|اذهبي|دخلني|شغل)(?:\s|$)/;
/** Words that say a site is meant, not a file or a page of a PDF. */
const SITE_WORD =
  /\b(?:website|site|web ?page|page of|online)\b|(?:^|\s)(?:موقع|الموقع|صفحة|الصفحة)(?:\s|$)/;
/** Never a website: ZOOD's own things and the computer's. */
const NOT_A_SITE =
  /\b(?:file|folder|pdf|document|page \d|settings?|drive|tab|window|app|application|tool)\b|(?:ملف|مجلد|مستند|اعدادات|الاعدادات)/;

/** A spoken address made written: "amazon dot com" → "amazon.com". */
function writtenAddresses(said: string): string {
  let out = said;
  for (const [spoken, written] of Object.entries(SPOKEN_ENDING)) {
    out = out.replace(
      new RegExp(`(?:\\bdot\\b|دوت|نقطة)\\s*${spoken}(?=\\s|$|[?؟.!,،])`, 'g'),
      `.${written}`,
    );
  }
  return out.replace(SPOKEN_DOT, '.');
}

const DOMAIN = new RegExp(
  `(?:https?:\\/\\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${ENDINGS}))(?=$|[\\s/?؟.!,،:)])(\\/[^\\s]*)?`,
  'gi',
);

/** Every web address in some words, as https addresses, in the order they come. */
export function addressesIn(text: string): string[] {
  const out: string[] = [];
  for (const match of writtenAddresses(text.toLowerCase()).matchAll(DOMAIN)) {
    const host = match[1]!.replace(/^\.+/, '');
    if (!host.includes('.')) continue;
    const path = (match[2] ?? '').replace(/[).,،!?؟]+$/, '');
    const url = `https://${host}${path}`;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** The first web address written out in an answer: a link it gives, or a site it names. */
export function linkIn(text: string): string | null {
  const written = /https?:\/\/[^\s)<>\]"']+/i.exec(text);
  if (written) return written[0].replace(/[.,،!?؟]+$/, '');
  return addressesIn(text)[0] ?? null;
}

/**
 * The website asked for — "go to amazon dot com", «افتح موقع نون»,
 * "open youtube" — or null when the words ask for something else.
 * When a person corrects themselves ("amazon dot com? amazon dot sa"),
 * the last address they said is the one they meant.
 */
export function siteAsked(words: string): string | null {
  const said = plain(words);
  if (!said || !GO.test(said)) return null;
  const addresses = addressesIn(said);
  if (addresses.length > 0) return addresses.at(-1)!;
  if (NOT_A_SITE.test(said)) return null;
  // A well-known site by its name alone, or any name said with "website".
  // «نون دوت كوم» is written «نون.com»: a known name, whatever it ends with.
  const names = writtenAddresses(said)
    .split(/[\s,،?؟!]+/)
    .map((name) => name.replace(/\..*$/, ''))
    .filter(Boolean);
  let known: string | null = null;
  for (const name of names) if (KNOWN_SITES[name]) known = KNOWN_SITES[name]!;
  if (known) return `https://${known}`;
  if (SITE_WORD.test(said)) {
    const rest = said
      .replace(GO, ' ')
      .replace(SITE_WORD, ' ')
      .replace(/\b(?:can|could|would|you|please|the|a|an|of|me|for|to|and)\b/g, ' ')
      .replace(/(?:^|\s)(?:ممكن|لو سمحت|لي|ال)(?=\s|$)/g, ' ')
      .replace(/[?؟.!,،]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (rest && rest.split(' ').length <= 4)
      return `https://www.google.com/search?q=${encodeURIComponent(rest)}`;
  }
  return null;
}

/** The host of an address, as people say it: "amazon.sa". */
export function siteName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host === 'google.com' && url.includes('/search?q='))
      return new URL(url).searchParams.get('q') ?? host;
    return host;
  } catch {
    return url;
  }
}

const YES = new Set([
  'yes',
  'yeah',
  'yea',
  'yep',
  'yup',
  'sure',
  'ok',
  'okay',
  'ok go',
  'alright',
  'please',
  'yes please',
  'please do',
  'do it',
  'go ahead',
  'go on',
  'take me there',
  'take me',
  'open it',
  "let's go",
  'lets go',
  'of course',
  'definitely',
  'absolutely',
  'sounds good',
  'why not',
  'correct',
  'right',
  "that's right",
  'نعم',
  'ايوه',
  'ايوا',
  'ايه',
  'اي',
  'اية',
  'اكيد',
  'تمام',
  'طيب',
  'يلا',
  'يالله',
  'اوكي',
  'اوك',
  'ماشي',
  'لو سمحت',
  'من فضلك',
  'ودني',
  'وديني',
  'خذني',
  'افتحه',
  'افتحها',
  'سوها',
  'سويها',
  'بالضبط',
  'صح',
  'اكيد لو سمحت',
]);
const NO = new Set([
  'no',
  'nope',
  'nah',
  'no thanks',
  'no thank you',
  'not now',
  'cancel',
  'never mind',
  'nevermind',
  'forget it',
  'لا',
  'لا شكرا',
  'لا مشكور',
  'لا خلاص',
  'خلاص',
  'الغ',
  'الغي',
  'بعدين',
  'مو الحين',
  'لا يا شيخ',
  'ولا شي',
]);

function short(words: string): string {
  return plain(words)
    .replace(/^(?:(?:hey |ok |okay )?zood[, ]+|(?:يا )?زود[، ]+)/, '')
    .replace(/[.!?؟,،…]+/g, ' ')
    .replace(/\b(?:please|thanks|thank you)\b$/, '')
    .replace(/(?:شكرا|مشكور)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Yes", "sure, take me there", «إيه ودني»: agreeing to what was just offered. */
export function isYes(words: string): boolean {
  const said = short(words);
  if (!said || said.split(' ').length > 5) return false;
  if (YES.has(said)) return true;
  // "yes, take me there", «ايه افتحه»: a yes followed by words that only agree.
  const [first, ...rest] = said.split(' ');
  return (
    YES.has(first!) &&
    (YES.has(rest.join(' ')) ||
      rest.every(
        (word) =>
          YES.has(word) || /^(?:it|there|now|me|to|the|site|website|الحين|لي|الموقع)$/.test(word),
      ))
  );
}

/** "No", «لا شكرًا»: what was offered is not wanted. */
export function isNo(words: string): boolean {
  const said = short(words);
  // Only a whole "no": «لا ترد بالصوت» and "stop reading" are requests of their own.
  return NO.has(said);
}

/** Whether an answer is still fresh enough to be answered back. */
export function stillFresh(turn: LastTurn | null, now: number): turn is LastTurn {
  return turn !== null && now - turn.at < FOLLOW_UP_MS;
}

/** Whether an answer ends with a question to the person: they are expected to answer it. */
export function asksBack(say: string): boolean {
  return /[?؟]\s*$/.test(say.trim());
}

/**
 * The turn before, as the model is shown it ahead of the new words, so
 * "and in summer?" or "yes" is read as the reply it is. The answer is cut
 * short: the model needs what was said, not every line of it.
 */
export function historyMessages(
  turn: LastTurn | null,
  now: number,
): { role: 'user' | 'assistant'; content: string }[] {
  if (!stillFresh(turn, now)) return [];
  const answer = JSON.stringify({ say: turn.say, act: 'answer', text: turn.text.slice(0, 1200) });
  return [
    { role: 'user', content: turn.words },
    { role: 'assistant', content: answer },
  ];
}
