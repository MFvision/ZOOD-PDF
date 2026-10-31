import { normalize } from '../ai/chat/commands';

/**
 * "Don't delete page 3", «لا تحذف الصفحة», "no dark mode": a request that
 * says what NOT to do. The lanes that act at once (the command book, the
 * settings, the words one by one, a site, another app's shortcut) match
 * the command's name and never read the "don't" before it: "don't turn off
 * auto save" turned auto save off, and any Arabic request starting with
 * «لا» turned the one-tap setting off (its choice «لا شي»). Here the "don't"
 * is read first: a request that only says what not to do does nothing, and
 * one that mixes a "don't" with something to do is left to the model,
 * which reads the whole sentence and asks before it does anything.
 */

/** Courtesies and a name before the words: "please", "zood", «لو سمحت», «يا زود». */
const POLITE =
  /^(?:(?:hey |hi |ok |okay )?zood |please |pls |plz |just |ok |okay |(?:يا )?زود |لو سمحت |من فضلك |فضلا |ممكن |طيب |تكفي |تكفى )+/;

/**
 * Words that say "not this" at the start of a clause. "Don't forget to
 * save" and «لا تنسى تحفظ» are a request, not a refusal; "don't you think…"
 * is a question.
 */
const NOT_EN =
  /^(?:i |we )?(?:do not|dont|don t|didn t|did not|never|no need to|not|no|stop asking to|i don t want(?: you)? to|i do not want(?: you)? to|i dont want(?: you)? to)(?: |$)/;
const NOT_EN_FINE = /^(?:i |we )?(?:do not|dont|don t) (?:forget|you|hesitate|stop|miss)\b|^not only\b|^no (?:problem|worries)\b|^never ?mind\b/;
/** «لا تحذف», «ولا تطبع», «ما ابي», «ما ابغى احفظ», «بلاش», «مو لازم», «لا داعي», «بدون ما». */
const NOT_AR =
  /^(?:و|ف)?(?:لا|ما ابي|مابي|ما ابيك|ما ابغي|ما ابغا|مابغي|ما ابغاك|ما اريد|ما اريدك|ما بدي|ما ودي|ما له داعي|بلاش|مو لازم|مب لازم|لا داعي|لات\S+|بدون ما)(?: |$)/;
const NOT_AR_FINE = /^(?:و|ف)?لا (?:تنسي|تنسا|تنس|تنساني|تخاف|تشيل هم)(?: |$)|^(?:و|ف)?لا شي$/;

/** A request cut where one thing to do ends and the next begins. */
const CLAUSES =
  /\s*(?:[,،;؛.!\n]|\band then\b|\bthen\b|\bbut\b|\band\b|\bafter that\b|\binstead\b|(?<=^|\s)(?:ثم|لكن|بس|وبعدين|بعدين|بعدها)(?=\s|$))\s*|\s(?=و(?:لا|ما) )/;

/** Whether one clause says what not to do. */
export function negatedClause(clause: string): boolean {
  const said = `${normalize(clause.replace(/[’‘`´]/g, "'")).replace(/'/g, ' ')} `.replace(POLITE, '').trim();
  if (!said) return false;
  if (NOT_EN.test(said) && !NOT_EN_FINE.test(said)) return said.split(' ').length > 1;
  if (NOT_AR.test(said) && !NOT_AR_FINE.test(said)) return said.split(' ').length > 1 || /^(?:و|ف)?لات\S/.test(said);
  return false;
}

/**
 * What a request's "don't"s make of it: `all` — it only says what not to
 * do, so nothing is done; `some` — something to do with a "don't" beside it,
 * for the model to read whole; null — no "don't" at all.
 */
export function refusal(words: string): 'all' | 'some' | null {
  // Long words are a message, not a request with a "don't" in front.
  const clauses = words
    .slice(0, 2000)
    .split(CLAUSES)
    .map((clause) => clause.trim())
    .filter((clause) => `${normalize(clause)} `.replace(POLITE, '').trim() !== '');
  const negated = clauses.filter(negatedClause).length;
  if (negated === 0) return null;
  // "No, open the settings": a bare "no" first corrects; it does not refuse what follows.
  return negated === clauses.length ? 'all' : 'some';
}
