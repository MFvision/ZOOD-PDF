import type { TagRule } from './ops';

/**
 * The person's tag rules: "if the text holds فاتورة, tag it فواتير".
 *
 * The rules themselves live in the index, beside the documents they tag, and
 * the core runs them (`library.rules`) with the same normalization the search
 * uses — so a rule written with tashkeel still matches text without it, and a
 * document already carrying the tag is left alone, which makes running them
 * twice change nothing. What is here is only what turns a person's typing
 * into a rule and a rule back into a line they can read.
 */

/** Words and tags a person typed, split on commas and new lines, trimmed and deduplicated. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[,،\n]/)) {
    const tag = part.trim();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/** A key for a rule in a list: rules have no identity of their own in the index. */
export const ruleKey = (rule: TagRule, at: number): string => `${at}:${rule.tag}:${rule.words.join('|')}`;

/** The words of a rule as one line, the way they were typed. */
export const ruleWords = (rule: TagRule): string => rule.words.join('، ');

/**
 * A rule worth keeping: a tag, at least one word, and not one the list
 * already has. `alsoName` looks at the file's name as well as its text.
 */
export function addRule(rules: readonly TagRule[], words: string, tag: string, alsoName: boolean): TagRule[] {
  const rule: TagRule = {
    tag: tag.trim(),
    words: parseTags(words),
    scope: alsoName ? 'both' : 'text',
    enabled: true,
  };
  if (!rule.tag || rule.words.length === 0) return [...rules];
  const same = (one: TagRule) => one.tag === rule.tag && one.words.join('|') === rule.words.join('|');
  if (rules.some(same)) return [...rules];
  return [...rules, rule];
}

export function removeRule(rules: readonly TagRule[], at: number): TagRule[] {
  return rules.filter((_, index) => index !== at);
}
