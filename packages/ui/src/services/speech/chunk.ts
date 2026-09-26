/**
 * Utterance chunking. Chrome silently stops an utterance after roughly 15 seconds and every
 * engine answers "pause" better at sentence granularity, so each paragraph run is spoken as
 * sentences of at most MAX_CHUNK characters.
 */

export const MAX_CHUNK = 200;

/** Sentence end (Latin + Arabic question mark + Urdu full stop + ellipsis) followed by space. */
const SENTENCE = /([.!?؟۔…]+["'»”’)\]]*)\s+/g;
/** Clause marks for a second-level split: Arabic/Latin comma, semicolons, colon, dash. */
const CLAUSE = /([،,؛;:—–])\s+/g;

function splitKeep(text: string, re: RegExp): string[] {
  return text
    .replace(re, '$1\u0000')
    .split('\u0000')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Packs pieces (joined by spaces) into chunks of at most `max` characters. */
function pack(pieces: string[], max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (!cur) cur = p;
    else if (cur.length + 1 + p.length <= max) cur = `${cur} ${p}`;
    else {
      out.push(cur);
      cur = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function hardCut(token: string, max: number): string[] {
  const out: string[] = [];
  const chars = Array.from(token);
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(''));
  return out;
}

function splitLong(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const clauses = splitKeep(sentence, CLAUSE).flatMap((c) =>
    c.length <= max ? [c] : pack(c.split(/\s+/).flatMap((w) => (w.length <= max ? [w] : hardCut(w, max))), max),
  );
  return pack(clauses, max);
}

export function chunkText(text: string, max = MAX_CHUNK): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return splitKeep(clean, SENTENCE).flatMap((s) => splitLong(s, max));
}
