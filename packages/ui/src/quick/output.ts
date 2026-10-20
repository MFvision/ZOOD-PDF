import { cleanSuffix, stemOf } from '../batch/names';
import type { AppSettings } from '../state/settings';

/**
 * Where a quick tool's results go and what they are called (Settings › Quick
 * tools › Results): beside the original, in one folder, or a folder asked for
 * each time; named by a pattern of the original's name and the tool's.
 * Never over a file: the host makes a taken name "name (2)".
 */

export type OutputTarget = { beside: string } | { dir: string };

export interface Output {
  /** Where the result of the file at `path` goes. */
  target(path: string): OutputTarget;
  /** A result's name; `part` numbers the files a split makes. */
  name(original: string, suffix: string, extension: string, part?: number): string;
}

/** The tool's word, from its suffix: "compressed" of "-compressed". */
export function toolWord(suffix: string): string {
  return suffix.replace(/^[\s\-_–—]+/, '').trim();
}

export function patternName(pattern: string, original: string, suffix: string, extension: string, part?: number): string {
  const stem = stemOf(original);
  const tool = toolWord(suffix);
  let made = pattern.includes('{name}') ? pattern : `{name} ${pattern}`;
  // No tool word (a conversion keeps the name): the tool and what wraps it go.
  made = tool ? made.replaceAll('{tool}', tool) : made.replace(/\s*[([{-]?\s*\{tool\}\s*[)\]}]?/g, '');
  // What the person typed is made safe; the original's own name stays whole.
  made = made
    .split('{name}')
    .map((typed) => cleanSuffix(typed.replaceAll('{', '').replaceAll('}', '')))
    .join(stem)
    .trim() || stem;
  return `${made}${part === undefined ? '' : ` ${part}`}.${extension}`;
}

/**
 * The output for one run. With "Ask each time", `ask` is called once for the
 * run; null (the person closed the panel) means do not run.
 */
export async function outputFor(settings: AppSettings, ask: () => Promise<string | null>): Promise<Output | null> {
  let dir: string | null = null;
  if (settings.output === 'folder' && settings.outputFolder) dir = settings.outputFolder;
  if (settings.output === 'ask') {
    dir = await ask();
    if (dir === null) return null;
  }
  const pattern = settings.outputPattern.trim() || '{name} ({tool})';
  return {
    target: (path) => (dir ? { dir } : { beside: path }),
    name: (original, suffix, extension, part) => patternName(pattern, original, suffix, extension, part),
  };
}
