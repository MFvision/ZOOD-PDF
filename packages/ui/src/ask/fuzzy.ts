import { namesOf, stepFor } from './book';
import type { BookEntry, BookStep } from './book';
import { choiceNames, choiceSaid, plain, SETTINGS_BOOK, switchOf } from './settingsBook';
import type { SettingAsk, SettingEntry } from './settingsBook';
import { translate } from '../i18n/messages';

/**
 * The last way Ask ZOOD finds a command or a setting before any model is
 * asked: by its words, one by one, not as a whole phrase. Every command of
 * the book and every setting is known by the words of all its names; a
 * request is matched to the one whose words cover most of what was said,
 * the rarer words counting more ("lock it with a password": "password" is
 * Protect's alone). It answers only when one is clearly ahead, so "save
 * my work" is Save, and a request that could be two things is left to the
 * models, or to the person.
 */

/** Words that say nothing of which: "please", "it", "the", "لي". */
const STOP = new Set(
  (
    'the a an my me it its this that these those to of in on for with please i want would like can could you your be is are was ' +
    'and or at by from into up out now just some bit little so do does let lets im id ' +
    'لي في علي على من الي الى عن هذا هذي هذه ذا ابي ابغي ابغى ابيك ممكن لو سمحت فضلك من فضلك يا زود zood شوي الحين الان'
  ).split(' '),
);

/** A word as compared: plurals and endings off ("passwords" → "password", "حوّله" → "حول"). */
export function stem(word: string): string {
  if (/^[a-z]+$/.test(word)) {
    if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
    if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
    if (word.length > 4 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -1);
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
  }
  let arabic = word;
  if (arabic.length > 4) arabic = arabic.replace(/(?:ها|هم|كم|نا)$/, '');
  if (arabic.length > 3) arabic = arabic.replace(/ه$/, '');
  if (arabic.length > 4) arabic = arabic.replace(/^(?:ل|ب)(?=ل?[^ا])/, '');
  return arabic;
}

/** The words of `text` that count, as compared. */
export function wordsOf(text: string): string[] {
  return plain(text.replace(/-/g, ' '))
    .split(' ')
    .filter((word) => word.length >= 2 && !STOP.has(word))
    .map(stem);
}

interface Candidate {
  kind: 'book' | 'setting';
  entry: BookEntry | SettingEntry;
  words: Set<string>;
}

function settingNames(entry: SettingEntry): string[] {
  const names = entry.names.filter((name) => !name.startsWith('!'));
  const labels = entry.unnamed ? [] : [translate('en', entry.label), translate('ar', entry.label)];
  const choices = (entry.choices ?? []).flatMap(choiceNames).filter((name) => !/^\d+$/.test(name));
  return [...names, ...labels, ...choices];
}

/** What was picked: a command to run, or a setting with its choice (null: shown). */
export type Picked = { kind: 'book'; step: BookStep } | { kind: 'setting'; ask: SettingAsk };

/** To be done at once: the share of what was said the best must cover, and how far ahead of the next it must be. */
const SURE_COVER = 0.6;
const SURE_AHEAD = 0.15;
/** To be offered as a choice: the least share covered. */
const OFFER_COVER = 0.4;
/** The most choices offered. */
const MOST = 3;

interface Ranked {
  picked: Picked;
  id: string;
  cover: number;
  score: number;
}

/** The commands and settings the words point to, best first, each with how sure. */
export function fuzzyRank(words: string, entries: readonly BookEntry[], desktop = true): Ranked[] {
  const said = [...new Set(wordsOf(words))];
  if (said.length === 0 || said.length > 10) return [];
  const candidates: Candidate[] = [
    ...entries.filter((entry) => entry.enabled).map((entry) => ({ kind: 'book' as const, entry, words: new Set(namesOf(entry).flatMap(wordsOf)) })),
    ...SETTINGS_BOOK.filter((entry) => !entry.desktop || desktop).map((entry) => ({ kind: 'setting' as const, entry, words: new Set(settingNames(entry).flatMap(wordsOf)) })),
  ];
  // Rarer words count more: a word every command has says little of which.
  const weight = (word: string) => {
    const count = candidates.filter((one) => one.words.has(word)).length;
    return count === 0 ? 0 : Math.log(1 + candidates.length / count);
  };
  const weights = said.map(weight);
  // Words no command knows ("work", "thing") count a little against all.
  const whole = weights.reduce((sum, value) => sum + (value || 0.25), 0);
  // How much of what was said each covers, and, between those that cover as much, how little else it is:
  // "save my work" is Save, whose words are few, before "save results", one word of many.
  return candidates
    .map((one) => {
      const matched = said.reduce((sum, word, index) => sum + (one.words.has(word) ? (weights[index] ?? 0) : 0), 0);
      const own = [...one.words].reduce((sum, word) => sum + weight(word), 0);
      const cover = matched / whole;
      return { one, cover, score: cover * 0.75 + (own ? matched / own : 0) * 0.25 };
    })
    .filter((row) => row.cover >= OFFER_COVER)
    .sort((a, b) => b.score - a.score)
    .map((row) => ({ picked: pickedOf(row.one, words, said), id: row.one.entry.id, cover: row.cover, score: row.score }));
}

/** The one command or setting the words clearly point to, to be done at once; null when none is clearly ahead. */
export function fuzzyPick(words: string, entries: readonly BookEntry[], desktop = true): Picked | null {
  const [best, next] = fuzzyRank(words, entries, desktop);
  if (!best || best.cover < SURE_COVER) return null;
  if (next && best.score - next.score < SURE_AHEAD) return null;
  return best.picked;
}

/** The few the words could mean, to be offered as a choice ("Did you mean…"), or none. */
export function fuzzyOffers(words: string, entries: readonly BookEntry[], desktop = true): Picked[] {
  return fuzzyRank(words, entries, desktop).slice(0, MOST).map((row) => row.picked);
}

function pickedOf(one: Candidate, words: string, said: readonly string[]): Picked {
  if (one.kind === 'book') return { kind: 'book', step: stepFor(one.entry as BookEntry, words) };
  const entry = one.entry as SettingEntry;
  if (entry.kind === 'show') return { kind: 'setting', ask: { entry, value: null } };
  const asked = switchOf(words);
  if (entry.kind === 'choice') {
    // A choice named in full first; then "off" or "on"; then a choice by one of its words.
    const switched = asked === 'on' ? entry.on : asked === 'off' ? entry.off : undefined;
    const chosen = choiceSaid(entry, plain(words)) ?? switched ?? choiceByWord(entry, said);
    if (chosen) return { kind: 'setting', ask: { entry, value: chosen } };
  }
  if (entry.kind === 'toggle') return { kind: 'setting', ask: { entry, value: asked } };
  const value = asked === 'on' ? entry.on : asked === 'off' ? entry.off : undefined;
  return { kind: 'setting', ask: { entry, value: value ?? null } };
}

/** A choice named by one of its words: "purple" → Purple. */
function choiceByWord(entry: SettingEntry, said: readonly string[]): string | null {
  const hits = (entry.choices ?? []).filter((choice) => choiceNames(choice).some((name) => wordsOf(name).some((word) => said.includes(word))));
  return hits.length === 1 ? (hits[0]?.value ?? null) : null;
}
