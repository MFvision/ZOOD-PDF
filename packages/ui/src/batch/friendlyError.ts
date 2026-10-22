import { uiLog } from '../core/host-tauri';
import type { TKey } from '../i18n/messages';

/** Where in a file's run something went wrong, for the fallback sentence. */
export type FailedPhase = 'read' | 'step' | 'write';

/**
 * The engine and the host fail with their own English words ("E_PARSE:
 * trailer not found"). People see a sentence of ours instead: the known codes
 * have one each, anything else a plain line for where it went wrong. The
 * engine's words go to the debug log (and a tooltip), never the main line.
 */
const BY_CODE: ReadonlyArray<[RegExp, TKey]> = [
  [/E_PASSWORD_EMPTY|E_PASSWORD_LONG/, 'batch.error.badPassword'],
  [/E_PASSWORD/, 'batch.error.needsPassword'],
  [/E_PARSE|E_INDEX/, 'batch.error.notPdf'],
  [/E_NOT_FOUND|E_MOVED|E_NO_FILE|E_MISSING/, 'batch.error.missing'],
  [/E_TOO_BIG|E_TOO_LONG/, 'batch.error.tooBig'],
  [/E_OWN_FONT|E_FONT/, 'batch.error.font'],
  [/E_PROTECT\b/, 'batch.error.notProtected'],
  [/E_STORAGE|E_IO|E_WRITE/, 'batch.error.write'],
  [/E_CANCELLED/, 'batch.error.stopped'],
];

const FALLBACK: Record<FailedPhase, TKey> = {
  read: 'batch.error.read',
  step: 'batch.error.generic',
  write: 'batch.error.write',
};

/** The engine's own words for an error, cut to a size a log line can carry. */
export function rawMessage(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 300);
}

/** The sentence to show for `error`; its own words are logged as `where`. */
export function friendlyError(error: unknown, phase: FailedPhase = 'step', where = 'quick'): TKey {
  const message = rawMessage(error);
  uiLog(`${where}: failed ${message}`);
  return BY_CODE.find(([pattern]) => pattern.test(message))?.[1] ?? FALLBACK[phase];
}
