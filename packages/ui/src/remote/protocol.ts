/**
 * The phone remote's messages, between the phone (`phone/`) and the PC's
 * interface (`RemoteLayer.tsx`). The desktop host only carries them, sealed
 * (`apps/desktop/src-tauri/src/remote/`); it reads the `pc` ones itself and
 * the hello, and hands the rest on.
 *
 * Positions on a page are fractions of the page as shown, 0–1 from its
 * top-left corner, so the phone's small picture and the PC's full-screen one
 * agree whatever their sizes.
 */

/** A point on the page, 0–1 from its top-left corner. */
export type PagePoint = [x: number, y: number];

export type InkTool = 'pen' | 'marker';

/** From the phone. */
export type PhoneMessage =
  /** Present mode on or off on the PC. */
  | { t: 'present'; on: boolean }
  | { t: 'next' }
  | { t: 'prev' }
  /** 1-based. */
  | { t: 'go'; page: number }
  /** The laser's spot, or `null` when the finger lifts. */
  | { t: 'laser'; at: PagePoint | null }
  /** A stroke being drawn: the whole of it so far, under one id. */
  | { t: 'ink'; id: string; tool: InkTool; points: PagePoint[] }
  | { t: 'inkClear' }
  /** Ink drawn on this page goes into the file (Keep), not away with the page. */
  | { t: 'inkKeep' }
  | { t: 'black'; on: boolean }
  /** Zoom on the PC: 1 is the whole page; `at` is the spot kept in place. */
  | { t: 'zoom'; scale: number; at: PagePoint }
  /** A picture of a page, `width` pixels wide. */
  | { t: 'picture'; page: number; width: number }
  /** The open PDF itself, to keep on the phone. */
  | { t: 'wantFile' }
  /** A file for the PC: a PDF to open, or a photographed page to make one of. */
  | { t: 'file'; name: string; mime: string; data: string }
  /** A signature drawn on a page: a PNG with a clear background, and where it goes. */
  | { t: 'sign'; page: number; at: PagePoint; size: [width: number, height: number]; png: string };

export interface RemoteDocumentState {
  name: string;
  pages: number;
  /** Each page's width over its height, so the phone can lay pictures out before they come. */
  shapes: number[];
}

/** From the PC's interface. */
export type PcMessage =
  | {
      t: 'state';
      doc: RemoteDocumentState | null;
      /** 1-based. */
      page: number;
      presenting: boolean;
      black: boolean;
      /** The comments of the current page. */
      notes: { text: string; author: string | null }[];
      /** Arabic documents turn the other way: the phone's "next" points left. */
      rtl: boolean;
    }
  | { t: 'picture'; page: number; width: number; url: string }
  | { t: 'file'; name: string; data: string }
  /** Something the phone asked for happened, or could not. */
  | { t: 'done'; what: 'sign' | 'file' | 'scan'; ok: boolean };

/** What only the host sends: the hello's answer, PC control switched on or off. */
export type HostMessage =
  | { t: 'welcome'; device: string; key: string }
  | { t: 'ready'; pc: string; pcControl: boolean }
  | { t: 'pcControl'; on: boolean }
  /** Copied on the PC (`remote/clip.rs`): text, or a picture as PNG base64. */
  | { t: 'clip'; text?: string; png?: string }
  /** A flicked file was saved on the PC's Desktop under `name`, or not. */
  | { t: 'landed'; id: string | null; name: string; ok: boolean }
  /** A file the person sent from the PC to the phone (`remote_give`). */
  | { t: 'give'; name: string; mime: string; data: string };

/**
 * What the host itself handles from the phone (`remote/server.rs`): a file
 * flicked onto the PC's Desktop, and the phone's clipboard for the PC's.
 */
export type PhoneToHost =
  | { t: 'drop'; id: string; name: string; mime: string; data: string }
  | { t: 'clip'; text: string }
  | { t: 'clip'; png: string };

/** PC control: carried out by the host itself (`remote/input.rs`). */
export type PcControl =
  | { t: 'pc'; k: 'move'; dx: number; dy: number }
  | { t: 'pc'; k: 'click'; b?: 'left' | 'right' | 'middle' }
  | { t: 'pc'; k: 'press' }
  | { t: 'pc'; k: 'release' }
  | { t: 'pc'; k: 'scroll'; dx?: number; dy?: number }
  | { t: 'pc'; k: 'text'; s: string }
  | {
      t: 'pc';
      k: 'key';
      key:
        | 'enter'
        | 'backspace'
        | 'tab'
        | 'escape'
        | 'space'
        | 'delete'
        | 'left'
        | 'right'
        | 'up'
        | 'down'
        | 'home'
        | 'end'
        | 'pageup'
        | 'pagedown'
        | 'volup'
        | 'voldown'
        | 'mute'
        | 'play'
        | 'next'
        | 'prev';
    };

/** The largest file either side sends, before base64. */
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

const clamp01 = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);

function point(value: unknown): PagePoint | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const x = clamp01(value[0]);
  const y = clamp01(value[1]);
  return x === null || y === null ? null : [x, y];
}

const MAX_POINTS = 4000;

/**
 * A phone's message as the interface may act on it, or `null`. The host has
 * already checked it came from a paired phone; this checks it is one of
 * these, with sane values.
 */
export function readPhoneMessage(raw: unknown): PhoneMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'present':
    case 'black':
      return typeof m.on === 'boolean' ? { t: m.t, on: m.on } : null;
    case 'next':
    case 'prev':
    case 'inkClear':
    case 'inkKeep':
    case 'wantFile':
      return { t: m.t };
    case 'go':
      return Number.isInteger(m.page) ? { t: 'go', page: m.page as number } : null;
    case 'laser':
      if (m.at === null) return { t: 'laser', at: null };
      return point(m.at) ? { t: 'laser', at: point(m.at) } : null;
    case 'ink': {
      if (typeof m.id !== 'string' || m.id.length > 40 || !Array.isArray(m.points)) return null;
      const tool: InkTool = m.tool === 'marker' ? 'marker' : 'pen';
      const points = m.points.slice(0, MAX_POINTS).map(point);
      if (points.some((p) => p === null)) return null;
      return { t: 'ink', id: m.id, tool, points: points as PagePoint[] };
    }
    case 'zoom': {
      const at = point(m.at);
      const scale = typeof m.scale === 'number' && Number.isFinite(m.scale) ? Math.min(6, Math.max(1, m.scale)) : null;
      return at && scale !== null ? { t: 'zoom', scale, at } : null;
    }
    case 'picture':
      return Number.isInteger(m.page) && typeof m.width === 'number'
        ? { t: 'picture', page: m.page as number, width: Math.min(1600, Math.max(64, Math.round(m.width))) }
        : null;
    case 'file':
      return typeof m.name === 'string' && typeof m.mime === 'string' && typeof m.data === 'string' && m.data.length <= (MAX_FILE_BYTES * 4) / 3 + 8
        ? { t: 'file', name: m.name.slice(0, 200), mime: m.mime.slice(0, 100), data: m.data }
        : null;
    case 'sign': {
      const at = point(m.at);
      const size = point(m.size);
      if (!at || !size || !Number.isInteger(m.page) || typeof m.png !== 'string' || m.png.length > 8_000_000) return null;
      if (size[0] <= 0.01 || size[1] <= 0.005) return null;
      return { t: 'sign', page: m.page as number, at, size, png: m.png };
    }
    default:
      return null;
  }
}

/** Base64 of `bytes`, in pieces so a large file does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
