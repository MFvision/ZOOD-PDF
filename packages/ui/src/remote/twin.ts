import { invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';
import type { TKey } from '../i18n/messages';

/**
 * One mouse and keyboard for two computers
 * (`apps/desktop/src-tauri/src/remote/twin.rs`): the desktop only.
 */

export type TwinSide = 'auto' | 'left' | 'right' | 'top' | 'bottom';

export type TwinState = 'off' | 'looking' | 'ready' | 'away' | 'refused' | 'permission';

export interface TwinStatus {
  /** This system can lend its mouse and keyboard at all (Windows, Mac). */
  available: boolean;
  on: boolean;
  side: TwinSide;
  /** The paired computer's name. */
  helper: string | null;
  state: TwinState;
  /** While pairing: the six digits the other screen shows too. */
  digits: string | null;
}

export interface FoundPc {
  pc: string;
  addr: string;
}

export const TWIN_EVENT = 'warraq://twin';

export const twinStatus = () => invokeHost('twin_status') as Promise<TwinStatus>;
export const findComputers = () => invokeHost('twin_find') as Promise<FoundPc[]>;
export const pairComputer = (found: FoundPc) =>
  invokeHost('twin_pair', { addr: found.addr, pc: found.pc }) as Promise<TwinStatus>;
export const setTwin = (change: { on?: boolean; side?: TwinSide }) =>
  invokeHost('twin_set', {
    on: change.on ?? null,
    side: change.side ?? null,
  }) as Promise<TwinStatus>;
export const forgetComputer = () => invokeHost('twin_forget') as Promise<TwinStatus>;
/** This computer, ready for another to pair with it for three minutes. */
export const offerComputer = () => invokeHost('twin_offer');

export function onTwinStatus(handle: (status: TwinStatus) => void): () => void {
  if (!isTauriHost()) return () => {};
  return onHostEvent<TwinStatus>(TWIN_EVENT, handle);
}

/** The side as it works: Auto puts the other screen on the right. */
export function realSide(side: TwinSide): Exclude<TwinSide, 'auto'> {
  return side === 'auto' ? 'right' : side;
}

/** The side a spot on the board is nearest to, from the middle of the board (x and y from -1 to 1). */
export function nearestSide(x: number, y: number): Exclude<TwinSide, 'auto'> {
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? 'left' : 'right';
  return y < 0 ? 'top' : 'bottom';
}

/** The side an arrow key moves the other screen to; `null` for other keys. */
export function sideForKey(key: string): Exclude<TwinSide, 'auto'> | null {
  switch (key) {
    case 'ArrowUp':
      return 'top';
    case 'ArrowDown':
      return 'bottom';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

/** A message for an error the host gave (`E_TWIN_…`). */
export function twinError(error: unknown): TKey {
  const text = String(error);
  if (text.includes('E_TWIN_DENIED')) return 'twin.error.denied';
  if (text.includes('E_TWIN_NOT_OPEN')) return 'twin.error.not_open';
  if (text.includes('E_TWIN_TIMEOUT')) return 'twin.error.timeout';
  if (text.includes('E_TWIN_UNREACHABLE')) return 'twin.error.unreachable';
  return 'twin.error.other';
}
