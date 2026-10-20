import type { PcMessage } from '../protocol';
import { RemoteLink, takeCodeFromAddress } from './link';
import type { LinkState } from './link';

type StateMessage = Extract<PcMessage, { t: 'state' }>;
type FileMessage = Extract<PcMessage, { t: 'file' }>;
type DoneMessage = Extract<PcMessage, { t: 'done' }>;

export interface PhoneSnapshot {
  link: LinkState;
  pcName: string;
  pcControl: boolean;
  state: StateMessage | null;
  /** Pictures of pages that came, by `page:width`. */
  pictures: ReadonlyMap<string, string>;
}

/**
 * The phone remote's session, outside React: the link, what the PC last
 * said, the page pictures that came, and who listens for a file or an answer.
 * The page reads it with `useSyncExternalStore`.
 */
export class PhoneSession {
  private snapshot: PhoneSnapshot = { link: 'connecting', pcName: '', pcControl: false, state: null, pictures: new Map() };
  private readonly listeners = new Set<() => void>();
  private readonly asked = new Set<string>();
  private docKey = '';
  private fileHandler: ((message: FileMessage) => void) | null = null;
  private doneHandler: ((message: DoneMessage) => void) | null = null;
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
