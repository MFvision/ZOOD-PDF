import type { LibraryOps } from './ops';
import type { TagRule } from './store';

/**
 * The person's tag rules: "if the text holds فاتورة, tag it فواتير".
 *
 * A rule is run by asking the index for its word — the same search the person
 * types, with the same Arabic normalization, so a rule written with tashkeel
 * still matches text without it — and tagging every document that comes back.
 * Rules are the person's, kept on this device beside the index, and run only
 * when they ask or when files have just been indexed. A document already
 * carrying the tag is left alone, so running rules twice changes nothing.
 */

/** How many hits a rule looks at: bounded, because a common word matches everything. */
const PAGE = 250;
const PAGES = 8;

export function ruleId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A rule worth keeping: both halves written, trimmed, and not already there. */
export function addRule(rules: readonly TagRule[], word: string, tag: string): TagRule[] {
  const rule = { id: ruleId(), word: word.trim(), tag: tag.trim() };
  if (!rule.word || !rule.tag) return [...rules];
  if (rules.some((existing) => existing.word === rule.word && existing.tag === rule.tag)) return [...rules];
  return [...rules, rule];
}

export function removeRule(rules: readonly TagRule[], id: string): TagRule[] {
  return rules.filter((rule) => rule.id !== id);
}

/** Tags a person typed, split on commas and spaces, trimmed and deduplicated. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[,،\n]/)) {
    const tag = part.trim();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

export interface RulesOutcome {
  /** How many documents took a tag they did not have. */
  tagged: number;
  /** Which documents changed, so the results on screen can be refreshed. */
  keys: string[];
}

/** Runs every rule over the whole index, or over `only` when a run has just added files. */
export async function applyRules(
  ops: LibraryOps,
  handle: number,
  rules: readonly TagRule[],
  only?: readonly string[],
): Promise<RulesOutcome> {
  const wanted = only ? new Set(only) : null;
  const changed = new Set<string>();
  for (const rule of rules) {
    if (!rule.word || !rule.tag) continue;
    const carries = new Map<string, boolean>();
    for (let page = 0; page < PAGES; page += 1) {
      const found = await ops.search(handle, rule.word, { limit: PAGE, offset: page * PAGE });
      for (const hit of found.hits) {
        if (wanted && !wanted.has(hit.key)) continue;
        if (!carries.has(hit.key)) carries.set(hit.key, hit.tags.includes(rule.tag));
      }
      if (found.hits.length < PAGE || (page + 1) * PAGE >= found.total) break;
    }
    for (const [key, already] of carries) {
      if (already) continue;
      await ops.tag(handle, key, { add: [rule.tag] });
      changed.add(key);
    }
  }
  return { tagged: changed.size, keys: [...changed] };
}
