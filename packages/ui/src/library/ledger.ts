import { readJson, writeJson } from '../state/preferences';

/**
 * What the Library has already read, so it does not read it twice.
 *
 * For each file: how large it was, when it was last changed, and a hash of
 * its content. A file whose three still agree is read from the disk and no
 * further — not opened, not recognized, not indexed again — which is also
 * how a run resumes after Stop, since only a file that finished is written
 * down here.
 *
 * It holds no text and no names a person did not already have: a key, three
 * numbers and sixteen hex digits. It lives beside the other things
 * remembered on this device, and "Delete the index" empties it.
 */

export interface FileMark {
  /** Bytes. */
  size: number;
  /** Milliseconds since the epoch, as the file system gives it. */
  modified: number;
  /** The first 64 bits of the content's SHA-256, hex; empty where the platform has no digest. */
  hash: string;
  /** When it was read, so the oldest go first when the ledger is full. */
  indexed: number;
}

export interface Ledger {
  mark(key: string): FileMark | undefined;
  remember(key: string, mark: FileMark): void;
  forget(keys: readonly string[]): void;
  clear(): void;
  /** Everything written down, for a host that keeps it somewhere of its own. */
  all(): Record<string, FileMark>;
}

/** Files remembered at most; the oldest are dropped, and those files are simply read again. */
export const LEDGER_LIMIT = 10_000;

/** Sixteen hex digits is plenty beside a size and a date, and keeps the ledger small. */
export const shortHash = (hash: string): string => hash.slice(0, 16);

/** Whether a file needs reading again: size, date and content all as they were. */
export function unchanged(mark: FileMark | undefined, file: { size: number; modified: number }, hash: string): boolean {
  if (!mark || mark.hash.length === 0 || hash.length === 0) return false;
  return mark.size === file.size && mark.modified === file.modified && mark.hash === shortHash(hash);
}

function sanitize(raw: unknown): Record<string, FileMark> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, FileMark> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const mark = value as Record<string, unknown>;
    const numbers = ['size', 'modified', 'indexed'].map((name) => mark[name]);
    if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    if (typeof mark.hash !== 'string' || mark.hash.length > 64) continue;
    out[key] = { size: mark.size as number, modified: mark.modified as number, hash: mark.hash, indexed: mark.indexed as number };
    if (Object.keys(out).length >= LEDGER_LIMIT) break;
  }
  return out;
}

/** Drops the least recently read until the ledger fits. */
function trim(marks: Record<string, FileMark>): void {
  const keys = Object.keys(marks);
  if (keys.length <= LEDGER_LIMIT) return;
  keys.sort((a, b) => marks[a]!.indexed - marks[b]!.indexed);
  for (const key of keys.slice(0, keys.length - LEDGER_LIMIT)) delete marks[key];
}

/**
 * `changed` is told whether what happened can wait: a file just read can —
 * the worst a lost write costs is that file read again — while forgetting
 * and clearing are answers to something a person asked for, and are written
 * at once. Counting the files as they come, rather than asking how many
 * there are after each one, is what keeps a folder of ten thousand from
 * costing the square of that.
 */
function ledgerOver(marks: Record<string, FileMark>, changed: (soon: boolean) => void): Ledger {
  let held = Object.keys(marks).length;
  return {
    mark: (key) => marks[key],
    remember(key, mark) {
      if (!(key in marks)) held += 1;
      marks[key] = { ...mark, hash: shortHash(mark.hash) };
      if (held > LEDGER_LIMIT) {
        trim(marks);
        held = Object.keys(marks).length;
      }
      changed(true);
    },
    forget(keys) {
      for (const key of keys) {
        if (key in marks) held -= 1;
        delete marks[key];
      }
      changed(false);
    },
    clear() {
      for (const key of Object.keys(marks)) delete marks[key];
      held = 0;
      changed(false);
    },
    all: () => ({ ...marks }),
  };
}

/** A ledger that lives only as long as the run (the tests, and a host with no storage). */
export function memoryLedger(from: Record<string, FileMark> = {}): Ledger {
  return ledgerOver({ ...from }, () => undefined);
}

export const LEDGER_KEY = 'warraq.library.read';

/** At most one write to this device a second while a run is under way. */
export const LEDGER_WRITE_MS = 1000;

/**
 * The ledger as the app keeps it. Writing it costs as much as the whole
 * ledger, so a run of a thousand files does not write it a thousand times:
 * a file read schedules a write within a second, and what a person asked for
 * is written at once.
 */
export function storedLedger(key: string = LEDGER_KEY): Ledger {
  const marks = sanitize(readJson<unknown>(key, {}));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    writeJson(key, marks);
  };
  return ledgerOver(marks, (soon) => {
    if (!soon) return save();
    timer ??= setTimeout(save, LEDGER_WRITE_MS);
  });
}
