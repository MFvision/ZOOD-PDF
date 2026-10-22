import { LIMITS } from './limits';

/**
 * The app's own recent history, for a problem report: the errors the page
 * met and the notes the app writes for its debug log, newest last. It lives
 * in memory only, is never sent by itself, and the person sees every line
 * (and can leave it out) before a report goes.
 */

export interface LogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

const lines: LogLine[] = [];
let installed = false;

/** Long lines are cut, and the oldest go first once the list is full. */
export function note(level: LogLine['level'], text: string, at: number = Date.now()): void {
  lines.push({ at, level, text: text.length > 600 ? `${text.slice(0, 600)}…` : text });
  if (lines.length > LIMITS.logLines) lines.splice(0, lines.length - LIMITS.logLines);
}

export function recentLog(): readonly LogLine[] {
  return lines;
}

export function clearLog(): void {
  lines.length = 0;
}

/** The log as text, one line each, within the size a report may carry. */
export function logText(from: readonly LogLine[] = lines): string {
  const out: string[] = [];
  let size = 0;
  for (let index = from.length - 1; index >= 0; index -= 1) {
    const line = from[index]!;
    const text = `${new Date(line.at).toISOString()} ${line.level} ${line.text}`;
    if (size + text.length + 1 > LIMITS.logChars) break;
    out.unshift(text);
    size += text.length + 1;
  }
  return out.join('\n');
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack.split('\n').slice(1, 4).join('\n')}` : ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Starts listening: uncaught errors, rejected promises, and what the app
 * writes as warnings and errors. Once per page; the console still prints.
 */
export function startLog(target: typeof globalThis = globalThis): void {
  if (installed) return;
  installed = true;
  target.addEventListener?.('error', (event: Event) => {
    const error = event as ErrorEvent;
    note('error', describe(error.error ?? error.message));
  });
  target.addEventListener?.('unhandledrejection', (event: Event) => {
    note('error', `unhandled: ${describe((event as PromiseRejectionEvent).reason)}`);
  });
  const console = target.console;
  if (!console) return;
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      note(level, args.map(describe).join(' '));
      original(...args);
    };
  }
}
