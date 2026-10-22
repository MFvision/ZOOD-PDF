import { readJson, writeJson } from '../state/preferences';

/**
 * How the person writes, for the replies Ask ZOOD drafts: a few lines about
 * them (name, job, company, how they sign) and a few messages they wrote
 * themselves, pasted in Settings › AI › Ask ZOOD. Kept on this computer,
 * shown to the on-device model only, never collected by the app: what is
 * here is exactly what the person put here, and they can change it.
 */
export interface WritingStyle {
  /** Who the person is and how they like to sound. */
  about: string;
  /** Messages they wrote, separated by a line of `---`. */
  examples: string;
}

const KEY = 'warraq.ask.style';
export const MAX_ABOUT = 800;
export const MAX_EXAMPLES = 4000;

export const NO_STYLE: WritingStyle = { about: '', examples: '' };

export function readStyle(): WritingStyle {
  const raw = readJson<Partial<WritingStyle>>(KEY, {});
  return {
    about: typeof raw.about === 'string' ? raw.about.slice(0, MAX_ABOUT) : '',
    examples: typeof raw.examples === 'string' ? raw.examples.slice(0, MAX_EXAMPLES) : '',
  };
}

export function writeStyle(style: WritingStyle): void {
  writeJson(KEY, {
    about: style.about.slice(0, MAX_ABOUT),
    examples: style.examples.slice(0, MAX_EXAMPLES),
  });
}

/**
 * The examples as the model is shown them: whole messages (separated by a
 * line of `---`), the last pasted first, until `budget` characters are used
 * — a message cut short would teach the model to stop mid-sentence. Only
 * when even the first one is too long is it cut, at a line's end.
 */
export function examplesFor(style: WritingStyle, budget: number): string[] {
  const messages = style.examples
    .split(/^\s*-{3,}\s*$/m)
    .map((message) => message.trim())
    .filter((message) => message.length > 0)
    .reverse();
  const chosen: string[] = [];
  let used = 0;
  for (const message of messages) {
    if (used + message.length <= budget) {
      chosen.push(message);
      used += message.length;
    } else if (chosen.length === 0) {
      const cut = message.slice(0, budget);
      const end = Math.max(
        cut.lastIndexOf('\n'),
        cut.lastIndexOf('. '),
        cut.lastIndexOf('؟ '),
        cut.lastIndexOf('! '),
      );
      chosen.push((end > budget / 3 ? cut.slice(0, end + 1) : cut).trim());
      used = budget;
    }
  }
  return chosen;
}
