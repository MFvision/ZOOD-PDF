import type { HostMessage, PcControl, PcMessage, PhoneMessage, PhoneToHost } from '../protocol';
import { bytesToBase64, keyFromText, open, seal, sessionKey } from './seal';

/**
 * The phone's connection to the PC: the WebSocket on the same address the
 * page came from, the hello, and every message sealed and numbered.
 *
 * The first time, the key comes from the QR code (after the `#`, which the
 * browser never sends); the PC answers with a key of this phone's own, kept
 * in this page's storage, so the next visit needs no code. The page's
 * address belongs to that PC alone, so its storage is that PC's.
 */

export type LinkState = 'connecting' | 'waiting' | 'open' | 'refused' | 'denied' | 'closed' | 'unpaired';

const STORE = 'zood.remote.pairing';

interface Pairing {
  device: string;
  key: string;
}

function readPairing(): Pairing | null {
  try {
    const raw = localStorage.getItem(STORE);
    const parsed = raw ? (JSON.parse(raw) as Partial<Pairing>) : null;
    return parsed && typeof parsed.device === 'string' && typeof parsed.key === 'string' ? (parsed as Pairing) : null;
  } catch {
    return null;
  }
}

function writePairing(pairing: Pairing | null): void {
  try {
    if (pairing) localStorage.setItem(STORE, JSON.stringify(pairing));
    else localStorage.removeItem(STORE);
  } catch {
    // A private window keeps nothing: the next visit scans the code again.
  }
}

/** The QR code's key from the address, taken off it so it is not kept in history or shared. */
export function takeCodeFromAddress(): Uint8Array | null {
  const match = /(?:^#|&)k=([A-Za-z0-9_-]{43})/.exec(location.hash);
  if (!match?.[1]) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return keyFromText(match[1]);
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const android = /Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(ua);
  if (android?.[1]) return android[1].trim();
  if (/Android/.test(ua)) return 'Android';
  return 'Phone';
}

type Incoming = PcMessage | HostMessage;

export class RemoteLink {
  private socket: WebSocket | null = null;
  private session: Uint8Array | null = null;
  private outSeq = 0;
  private inSeq = 0;
  private retry = 0;
  private timer: number | undefined;
  private stopped = false;
  state: LinkState = 'connecting';

  constructor(
    private code: Uint8Array | null,
    private readonly onState: (state: LinkState) => void,
    private readonly onMessage: (message: Incoming) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.socket?.close();
  }

  private set(state: LinkState): void {
    this.state = state;
    this.onState(state);
  }

  private connect(): void {
    const pairing = readPairing();
    if (!this.code && !pairing) {
      this.set('unpaired');
      return;
    }
    this.set('connecting');
    const socket = new WebSocket(`ws://${location.host}/`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.session = null;
    this.outSeq = 0;
    this.inSeq = 0;

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data) as { t?: string; c?: string; why?: string };
        if (message.t === 'challenge' && typeof message.c === 'string') this.hello(message.c);
        // A new phone: the person has to allow it on the computer first.
        else if (message.t === 'waiting') this.set('waiting');
        else if (message.t === 'refused') {
          // A remembered key the PC forgot, a code already used, or the
          // person said no on the computer: start again from a new code.
          if (!this.code) writePairing(null);
          this.code = null;
          this.set(message.why === 'denied' ? 'denied' : 'refused');
          this.stopped = true;
        }
        return;
      }
      if (!this.session) return;
      const plain = open(this.session, new Uint8Array(event.data as ArrayBuffer));
      if (!plain) return;
      const message = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
      const seq = message.s;
      if (typeof seq !== 'number' || seq <= this.inSeq || message.d !== 'c') return;
      this.inSeq = seq;
      delete message.s;
      delete message.d;
      if (message.t === 'welcome' && typeof message.device === 'string' && typeof message.key === 'string') {
        writePairing({ device: message.device, key: message.key });
        // Paired: the code is spent, the phone's own key is used from now on.
        this.code = null;
      }
      if (message.t === 'ready') {
        this.retry = 0;
        this.set('open');
      }
      this.onMessage(message as unknown as Incoming);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.session = null;
      if (this.stopped) {
        if (this.state !== 'refused' && this.state !== 'denied') this.set('closed');
        return;
      }
      this.set('connecting');
      // Back again soon after a phone wakes or the Wi-Fi returns; slower the longer it fails.
      this.retry = Math.min(this.retry + 1, 6);
      this.timer = window.setTimeout(() => this.connect(), 400 * 2 ** this.retry);
    };
  }

  private hello(challenge: string): void {
    const pairing = readPairing();
    const key = this.code ?? (pairing ? keyFromText(pairing.key) : null);
    if (!key || !this.socket) {
      this.set('unpaired');
      return;
    }
    const inside = new TextEncoder().encode(JSON.stringify({ c: challenge, name: deviceName() }));
    const hello = { t: 'hello', device: this.code ? null : pairing?.device, box: bytesToBase64(seal(key, inside)) };
    this.session = sessionKey(key, challenge);
    this.socket.send(JSON.stringify(hello));
  }

  /** Sends one message; quietly nothing while not connected. */
  send(message: PhoneMessage | PcControl | PhoneToHost): boolean {
    if (!this.socket || !this.session || this.socket.readyState !== WebSocket.OPEN) return false;
    this.outSeq += 1;
    const plain = new TextEncoder().encode(JSON.stringify({ ...message, s: this.outSeq, d: 'p' }));
    this.socket.send(seal(this.session, plain));
    return true;
  }

  /** Forgets this PC: the next visit needs a new code. */
  forget(): void {
    writePairing(null);
    this.stop();
    this.set('unpaired');
  }
}
