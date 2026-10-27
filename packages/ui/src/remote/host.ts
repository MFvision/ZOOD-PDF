import { invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';
import type { PcMessage } from './protocol';

/**
 * The desktop host's side of the phone remote
 * (`apps/desktop/src-tauri/src/remote/mod.rs`). Only the desktop has it: a
 * browser cannot listen for a phone.
 */

export interface RemoteStatus {
  running: boolean;
  /** The QR code's address, its key included, while a code pairs. */
  url: string | null;
  qr: string | null;
  codeUntil: number | null;
  address: string | null;
  phones: { peer: number; device: string; name: string }[];
  remembered: { id: string; name: string }[];
  pcControl: boolean;
  pcControlAvailable: boolean;
  /** The clipboard is shared with the phones (`remote/clip.rs`). */
  clipboard: boolean;
  clipboardAvailable: boolean;
  /** The remote comes on by itself at launch for phones paired before. */
  keepReady: boolean;
  /** Files let go on "To phone" with no phone there, waiting for one to join. */
  waiting: number;
}

export const STATUS_EVENT = 'warraq://remote-status';
export const MESSAGE_EVENT = 'warraq://remote-message';

export function remoteAvailable(): boolean {
  return isTauriHost();
}

export const startRemote = () => invokeHost('remote_start') as Promise<RemoteStatus>;
export const stopRemote = () => invokeHost('remote_stop') as Promise<RemoteStatus>;
export const remoteStatus = () => invokeHost('remote_status') as Promise<RemoteStatus>;
export const setPcControl = (on: boolean) => invokeHost('remote_pc_control', { on }) as Promise<RemoteStatus>;
export const setClipboardSharing = (on: boolean) => invokeHost('remote_clipboard', { on }) as Promise<RemoteStatus>;
export const setKeepReady = (on: boolean) => invokeHost('remote_keep_ready', { on }) as Promise<RemoteStatus>;
/** A file for every connected phone: it shows under "From the computer". */
export const giveToPhone = (name: string, mime: string, data: string) => invokeHost('remote_give', { name, mime, data }) as Promise<boolean>;
export const forgetPhone = (device: string) => invokeHost('remote_forget', { device }) as Promise<RemoteStatus>;
/** The window full screen, for Present mode: the desktop's own window, or a browser's page. */
export function setFullscreen(on: boolean): Promise<unknown> {
  if (isTauriHost()) return invokeHost('remote_fullscreen', { on }).catch(() => false);
  if (typeof document === 'undefined') return Promise.resolve(false);
  if (on && !document.fullscreenElement) return document.documentElement.requestFullscreen?.().catch(() => false) ?? Promise.resolve(false);
  if (!on && document.fullscreenElement) return document.exitFullscreen().catch(() => false);
  return Promise.resolve(true);
}

/** Sends to one phone, or every connected one. Quietly nothing when none is. */
export function sendToPhone(message: PcMessage, peer?: number): void {
  if (!isTauriHost()) return;
  invokeHost('remote_send', { message, peer: peer ?? null }).catch(() => undefined);
}

export function onRemoteStatus(handle: (status: RemoteStatus) => void): () => void {
  return onHostEvent<RemoteStatus>(STATUS_EVENT, handle);
}

export function onPhoneMessage(handle: (peer: number, message: unknown) => void): () => void {
  return onHostEvent<{ peer: number; message: unknown }>(MESSAGE_EVENT, (payload) => handle(payload.peer, payload.message));
}

export const PAIR_ASK_EVENT = 'warraq://remote-pair-ask';
export const PAIR_DONE_EVENT = 'warraq://remote-pair-done';

/** A phone that scanned the code, waiting for the person to allow it. */
export interface PairAsk {
  id: string;
  name: string;
}

export function onPairAsk(handle: (ask: PairAsk) => void): () => void {
  if (!isTauriHost()) return () => {};
  return onHostEvent<PairAsk>(PAIR_ASK_EVENT, (ask) => {
    if (ask && typeof ask.id === 'string') handle({ id: ask.id, name: typeof ask.name === 'string' ? ask.name : '' });
  });
}

export function onPairDone(handle: (id: string) => void): () => void {
  if (!isTauriHost()) return () => {};
  return onHostEvent<{ id: string }>(PAIR_DONE_EVENT, (done) => {
    if (done && typeof done.id === 'string') handle(done.id);
  });
}

export function answerPairing(id: string, allow: boolean): Promise<unknown> {
  return invokeHost('remote_pair_answer', { id, allow }).catch(() => false);
}

