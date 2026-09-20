import { folderOfKey, kindOfName } from './kinds';
import type { Ingest, IngestSource } from './ingest';
import type { LibraryOps } from './ops';
import type { FileRecord } from './store';

/**
 * Reading a list of files into the index, one at a time.
 *
 * Every file is hostile input, so nothing here throws: a file that cannot be
 * read is recorded with its reason and the run carries on to the next. A file
 * already in the index whose size and date have not changed is not read
 * again, which is what makes adding the same folder twice cheap. Stop takes
 * effect after the file being read, and what was read stays in the index —
 * the run resumes where it left off.
 */

export type FileState =
  | { state: 'waiting' }
  | { state: 'working' }
  | { state: 'added'; pages: number }
  | { state: 'unchanged' }
  /** The file was not read; `reason` is a key of the panel's dictionary, or free text from the core. */
  | { state: 'skipped'; reason: string; detail?: string }
  | { state: 'failed'; detail: string }
  | { state: 'cancelled' };

export interface RunSummary {
  added: number;
  unchanged: number;
  skipped: number;
  failed: number;
  cancelled: number;
  /** One record per file now in the index, to be kept by the store. */
  records: FileRecord[];
  /** Keys the run put into the index, for the tag rules to look at afterwards. */
  addedKeys: string[];
}

export interface RunOptions {
  ops: LibraryOps;
  handle: number;
  ingest: Ingest;
  sources: readonly IngestSource[];
  /** What the index already holds, by key. */
  known: Readonly<Record<string, FileRecord>>;
  password?: string;
  signal?: AbortSignal;
  onState: (key: string, state: FileState) => void;
  /** Called after each file, so the panel can show how far the run has come. */
  onProgress?: (done: number, total: number, name: string) => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Nothing changed about the file, so its text in the index is still right. */
export function unchanged(source: IngestSource, known: FileRecord | undefined): boolean {
  if (!known) return false;
  if (source.size !== undefined && known.size !== undefined && source.size !== known.size) return false;
  if (source.modified > 0 && known.modified > 0 && source.modified !== known.modified) return false;
  return true;
}

export async function indexFiles(options: RunOptions): Promise<RunSummary> {
  const { ops, handle, ingest, sources, known, signal, onState, onProgress } = options;
  const summary: RunSummary = { added: 0, unchanged: 0, skipped: 0, failed: 0, cancelled: 0, records: [], addedKeys: [] };
  let done = 0;
  for (const source of sources) {
    if (signal?.aborted) {
      onState(source.key, { state: 'cancelled' });
      summary.cancelled += 1;
      continue;
    }
    const before = known[source.key];
    if (unchanged(source, before)) {
      onState(source.key, { state: 'unchanged' });
      summary.unchanged += 1;
      summary.records.push(before!);
      done += 1;
      onProgress?.(done, sources.length, source.name);
      continue;
    }
    onState(source.key, { state: 'working' });
    try {
      const read = await ingest({ ...source, password: options.password }, { signal });
      if (read.read === 'skipped') {
        onState(source.key, { state: 'skipped', reason: read.reason });
        summary.skipped += 1;
      } else {
        const answer = await ops.add(
          handle,
          {
            key: source.key,
            name: source.name,
            kind: read.kind,
            modified: source.modified,
            pages: read.read === 'text' ? read.pages : undefined,
            password: options.password,
            text: read.read === 'text' ? read.text : undefined,
          },
          read.read === 'bytes' ? read.bytes : undefined,
        );
        if (answer.added) {
          onState(source.key, { state: 'added', pages: answer.pages });
          summary.added += 1;
          summary.addedKeys.push(source.key);
          summary.records.push({
            key: source.key,
            name: source.name,
            folder: folderOfKey(source.key),
            kind: answer.guessedKind ?? kindOfName(source.name) ?? 'pdf',
            size: source.size,
            modified: source.modified,
            indexed: Date.now(),
          });
        } else {
          onState(source.key, { state: 'skipped', reason: 'core', detail: answer.skipped });
          summary.skipped += 1;
        }
      }
    } catch (error) {
      onState(source.key, { state: 'failed', detail: message(error) });
      summary.failed += 1;
    }
    done += 1;
    onProgress?.(done, sources.length, source.name);
  }
  return summary;
}
