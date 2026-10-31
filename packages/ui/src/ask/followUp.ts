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

import { isOpenableUrl } from '../links/openLink';

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

// A name starts only after something that is not part of one: without this, a
// long "a.a.a.a…" or "www.www.…" was tried again from every letter, and a
// 10 000-letter answer took a quarter of a second to read (40 000: four).
const DOMAIN = new RegExp(
  `(?<![a-z0-9.-])(?:https?:\\/\\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${ENDINGS}))(?=$|[\\s/?؟.!,،:)])(\\/[^\\s]*)?`,
  'gi',
);

/** Every web address in some words, as https addresses, in the order they come. */
export function addressesIn(text: string): string[] {
  const out: string[] = [];
  // Spaces made one first: `SPOKEN_DOT` tried every one of a long run of them again.
  for (const match of writtenAddresses(text.toLowerCase().replace(/\s+/g, ' ')).matchAll(DOMAIN)) {
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
/** Hosts that are never a website out on the internet: this computer, its network, a printer, a router. */
const LOCAL_HOST = /^(?:localhost|.*\.(?:localhost|local|lan|home|internal|intranet|corp|arpa|test|invalid|example))$/;

/**
 * Whether Ask ZOOD may open `url` with no question asked: a web address
 * (http or https) of a named site out on the internet. Never `file:`,
 * `javascript:` or anything else, never an address with a name and password
 * in it, a port, a number for a host (192.168.1.1, 169.254.169.254) or a
 * host of this computer or its network, never one with characters that hide
 * where it goes. A page or a PDF can put words in an answer; it must not be
 * able to send a "yes" to the router or to a file on the disk.
 */
export function safeSite(url: string): boolean {
  if (!isOpenableUrl(url) || !/^https?:\/\//i.test(url.trim())) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (parsed.username || parsed.password || parsed.port) return false;
  if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return false;
  return !LOCAL_HOST.test(host);
}

/**
 * The site a "yes" to an answer opens, or null. Only an answer that asks
 * back has one, and only an address it asks about out loud (in `say`), a
 * well-known site, or one the person named themselves: the answer's longer
 * text can come from the page, the PDF or a web page, and "Visit
 * http://evil.example" written there must not open when the person says
 * "okay" to something else.
 */
export function offeredUrl(words: string, say: string, text: string): string | null {
  if (!asksBack(say)) return null;
  const asked = siteAsked(words);
  const inText = linkIn(text);
  const named = (url: string | null) => {
    if (!url) return false;
    const host = siteName(url).toLowerCase();
    return Object.values(KNOWN_SITES).includes(host) || plain(words).includes(host);
  };
  const url = linkIn(say) ?? (named(inText) ? inText : null) ?? asked;
  return url && safeSite(url) ? url : null;
}

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
