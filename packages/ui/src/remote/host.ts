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
