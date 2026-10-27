import type { HostMessage, PcMessage } from '../protocol';
import { MAX_STREAM_BYTES, fromBase64 } from '../protocol';
import { RemoteLink, takeCodeFromAddress } from './link';
import type { LinkState } from './link';
import { Download, Upload, transferId } from './streams';
import type { Progress, SendResult } from './streams';

type StateMessage = Extract<PcMessage, { t: 'state' }>;
type FileMessage = Extract<PcMessage, { t: 'file' }>;
type DoneMessage = Extract<PcMessage, { t: 'done' }>;
type LandedMessage = Extract<HostMessage, { t: 'landed' }>;

/** What the PC last copied: text, or a picture's address. */
export type PcClip = { text: string } | { picture: string };

/** A file the PC sent to this phone. */
export interface Received {
  id: number;
  name: string;
  mime: string;
  url: string;
  size: number;
}

/** The most files from the PC kept on the page at once; older ones go. */
const KEEP_RECEIVED = 12;

export interface PhoneSnapshot {
  link: LinkState;
  pcName: string;
  pcControl: boolean;
  state: StateMessage | null;
  /** Pictures of pages that came, by `page:width`. */
  pictures: ReadonlyMap<string, string>;
  /** What the PC copied last, while the clipboard is shared. */
  clip: PcClip | null;
  /** Files the PC sent, newest first. */
  received: readonly Received[];
  /** Files from the PC just come, shown full screen until put away: the newest, and how many came with it. */
  catching: { file: Received; count: number } | null;
  /** A file on its way from the PC: its name and how much has come (0–1). */
  coming: { name: string; done: number } | null;
}

/**
 * The phone remote's session, outside React: the link, what the PC last
 * said, the page pictures that came, and who listens for a file or an answer.
 * The page reads it with `useSyncExternalStore`.
 */
export class PhoneSession {
  private snapshot: PhoneSnapshot = { link: 'connecting', pcName: '', pcControl: false, state: null, pictures: new Map(), clip: null, received: [], catching: null, coming: null };
  private landedHandler: ((message: LandedMessage) => void) | null = null;
  private nextReceived = 1;
  private readonly listeners = new Set<() => void>();
  private readonly asked = new Set<string>();
  private docKey = '';
  private fileHandler: ((message: FileMessage) => void) | null = null;
  private doneHandler: ((message: DoneMessage) => void) | null = null;
  private readonly uploads = new Map<string, Upload>();
  private readonly downloads = new Map<string, Download>();
  readonly link: RemoteLink;

  constructor() {
    this.link = new RemoteLink(
      takeCodeFromAddress(),
      (link) => this.update({ link }),
      (message) => {
        switch (message.t) {
          case 'ready':
            this.asked.clear();
            this.update({ pcName: message.pc, pcControl: message.pcControl });
            return;
          case 'pcControl':
            this.update({ pcControl: message.on });
            return;
          case 'state': {
            const key = message.doc ? `${message.doc.name}:${message.doc.pages}` : '';
            if (key !== this.docKey) {
              // Another document, or the same one changed: its old pictures go.
              this.docKey = key;
              this.asked.clear();
              this.update({ state: message, pictures: new Map() });
            } else this.update({ state: message });
            return;
          }
          case 'picture':
            this.update({ pictures: new Map(this.snapshot.pictures).set(`${message.page}:${message.width}`, message.url) });
            return;
          case 'file':
            this.fileHandler?.(message);
            return;
          case 'done':
            this.doneHandler?.(message);
            return;
          case 'clip':
            this.takeClip(message);
            return;
          case 'give': {
            const bytes = fromBase64(message.data);
            if (bytes) this.keepFile(message.name, message.mime, new Blob([bytes], { type: message.mime || 'application/octet-stream' }));
            return;
          }
          case 'giveStart':
          case 'givePart':
          case 'giveEnd':
          case 'giveStop':
            this.takePart(message);
            return;
          case 'putOk':
          case 'putNo':
          case 'putGot':
            this.uploads.get(message.id)?.hear(message);
            return;
          case 'landed':
            if (message.id && this.uploads.has(message.id)) {
              this.uploads.get(message.id)?.hear(message);
              return;
            }
            this.landedHandler?.(message);
            return;
          default:
            return;
        }
      },
    );
  }

  private update(change: Partial<PhoneSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly read = (): PhoneSnapshot => this.snapshot;

  readonly onFile = (handle: ((message: FileMessage) => void) | null): void => {
    this.fileHandler = handle;
  };

  readonly onLanded = (handle: ((message: LandedMessage) => void) | null): void => {
    this.landedHandler = handle;
  };

  private takeClip(message: Extract<HostMessage, { t: 'clip' }>): void {
    const old = this.snapshot.clip;
    if (old && 'picture' in old) URL.revokeObjectURL(old.picture);
    if (typeof message.text === 'string') this.update({ clip: { text: message.text } });
    else if (typeof message.png === 'string') {
      const bytes = fromBase64(message.png);
      this.update({ clip: bytes ? { picture: URL.createObjectURL(new Blob([bytes], { type: 'image/png' })) } : null });
    }
  }

  /** A file from the PC, part by part; each part answered so the PC sends the next. */
  private takePart(message: Extract<HostMessage, { t: 'giveStart' | 'givePart' | 'giveEnd' | 'giveStop' }>): void {
    switch (message.t) {
      case 'giveStart':
        if (this.downloads.size >= 4 || message.size > MAX_STREAM_BYTES) return;
        this.downloads.set(message.id, new Download(message.id, message.name, message.mime || 'application/octet-stream', message.size));
        this.update({ coming: { name: message.name, done: 0 } });
        return;
      case 'givePart': {
        const download = this.downloads.get(message.id);
        if (!download) return;
        if (!download.take(message.n, message.data)) {
          this.downloads.delete(message.id);
          this.update({ coming: null });
          return;
        }
        this.link.send({ t: 'giveGot', id: message.id, n: message.n });
        this.update({ coming: { name: download.name, done: download.done } });
        return;
      }
      case 'giveEnd': {
        const download = this.downloads.get(message.id);
        this.downloads.delete(message.id);
        const blob = download?.finish();
        this.update({ coming: null });
        if (download && blob) this.keepFile(download.name, download.mime, blob);
        return;
      }
      case 'giveStop':
        this.downloads.delete(message.id);
        this.update({ coming: null });
        return;
    }
  }

  private keepFile(name: string, mime: string, blob: Blob): void {
    const file: Received = {
      id: this.nextReceived++,
      name,
      mime: mime || 'application/octet-stream',
      url: URL.createObjectURL(blob),
      size: blob.size,
    };
    const kept = [file, ...this.snapshot.received];
    for (const old of kept.slice(KEEP_RECEIVED)) URL.revokeObjectURL(old.url);
    const count = Math.min(KEEP_RECEIVED, (this.snapshot.catching?.count ?? 0) + 1);
    this.update({ received: kept.slice(0, KEEP_RECEIVED), catching: { file, count } });
  }

  /** Sends a file of any size to the PC's Desktop, in parts, telling how far it got. */
  readonly sendFile = async (file: File, onProgress: (progress: Progress) => void): Promise<SendResult> => {
    const upload = new Upload(transferId(), file, (message) => this.link.send(message), onProgress);
    this.uploads.set(upload.id, upload);
    try {
      return await upload.run();
    } finally {
      this.uploads.delete(upload.id);
    }
  };

  /** The full-screen catch is put away; the files stay under "From the computer". */
  readonly putAway = (): void => {
    this.update({ catching: null });
  };

  readonly onDone = (handle: ((message: DoneMessage) => void) | null): void => {
    this.doneHandler = handle;
  };

  readonly send: RemoteLink['send'] = (message) => this.link.send(message);

  /** A page's picture if it came; asked for once if not. */
  readonly picture = (page: number, width: number): string | undefined => {
    const key = `${page}:${width}`;
    const have = this.snapshot.pictures.get(key);
    if (!have && !this.asked.has(key) && this.link.state === 'open') {
      this.asked.add(key);
      // After this render: asking is a side effect.
      queueMicrotask(() => this.link.send({ t: 'picture', page, width }));
    }
    return have;
  };
}
