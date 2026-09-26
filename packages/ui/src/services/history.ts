/**
 * Per-document undo/redo of engine edits (the Edit tool).
 *
 * Every engine edit is an incremental update: the new file is the previous file plus appended
 * bytes. So a whole chain of versions can share ONE buffer — version k is `tip.subarray(0, len_k)`
 * — and undo is a truncation back to the previous `%%EOF`. Memory stays about one copy of the
 * newest file however many steps there are. When an edit is not an extension of the current
 * version (e.g. a whole rewrite of a file over 150 MB) a new chain starts; older chains are kept
 * as separate buffers only while the total stays under `maxBytes`, oldest dropped first.
 * See docs/decisions/0014-edit-tool.md.
 */

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** Number of steps that can be undone. */
  depth: number;
}

/** Cheap prefix check: lengths, the first and last 4 KiB of `a` inside `b` (engine output is an append). */
export function extendsBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (b.length <= a.length) return false;
  const n = Math.min(4096, a.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  for (let i = a.length - n; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class EditHistory {
  private versions: Uint8Array[] = [];
  private pos = -1;
  constructor(private readonly maxBytes = 300 * 1024 * 1024) {}

  /** Starts (or restarts) the history at `bytes` when it is not the current version. */
  reset(bytes: Uint8Array): void {
    this.versions = [bytes];
    this.pos = 0;
  }

  current(): Uint8Array | undefined {
    return this.versions[this.pos];
  }

  /** Records a new version after the current one (drops the redo branch). */
  push(bytes: Uint8Array): void {
    const cur = this.current();
    this.versions = this.versions.slice(0, this.pos + 1);
    if (cur && extendsBytes(cur, bytes)) {
      // Re-point every version of this chain into the new buffer: older buffers can be freed.
      const chainBuffer = cur.buffer;
      this.versions = this.versions.map((v) => (v.buffer === chainBuffer ? bytes.subarray(0, v.length) : v));
    }
    this.versions.push(bytes);
    this.pos = this.versions.length - 1;
    this.trim();
  }

  undo(): Uint8Array | undefined {
    if (this.pos <= 0) return undefined;
    this.pos -= 1;
    return this.versions[this.pos];
  }

  redo(): Uint8Array | undefined {
    if (this.pos >= this.versions.length - 1) return undefined;
    this.pos += 1;
    return this.versions[this.pos];
  }

  state(): HistoryState {
    return { canUndo: this.pos > 0, canRedo: this.pos >= 0 && this.pos < this.versions.length - 1, depth: Math.max(0, this.pos) };
  }

  /** Bytes held: distinct buffers counted once. */
  heldBytes(): number {
    const seen = new Set<ArrayBufferLike>();
    let total = 0;
    for (const v of this.versions) {
      if (seen.has(v.buffer)) continue;
      seen.add(v.buffer);
      total += v.buffer.byteLength;
    }
    return total;
  }

  private trim() {
    while (this.heldBytes() > this.maxBytes && this.pos > 0) {
      const oldest = this.versions[0]!.buffer;
      const drop = this.versions.findIndex((v) => v.buffer !== oldest);
      const n = drop < 0 || drop > this.pos ? 1 : drop;
      this.versions.splice(0, n);
      this.pos -= n;
    }
  }
}

const histories = new Map<string, EditHistory>();

/** The history of a document (created on first use). */
export function historyFor(docId: string): EditHistory {
  let h = histories.get(docId);
  if (!h) {
    h = new EditHistory();
    histories.set(docId, h);
  }
  return h;
}

export function forgetHistory(docId: string): void {
  histories.delete(docId);
}
