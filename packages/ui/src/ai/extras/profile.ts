/**
 * The details smart fill starts from — name, ID, address — as the person
 * typed or pasted them. Like the API key (`store.ts`), they stay in memory
 * for the session; only when "Remember on this device" is ticked are they
 * written to this browser's storage, and Forget takes them out again. They
 * are personal data: never logged, never sent anywhere but in the one
 * request the person reviews and sends.
 */
const KEY = 'warraq.ai.profile';
let session = '';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** The details to start with, and whether they are the ones remembered on this device. */
export function loadProfile(): { text: string; remembered: boolean } {
  let stored: string | null;
  try {
    stored = storage()?.getItem(KEY) ?? null;
  } catch {
    stored = null;
  }
  return { text: session || stored || '', remembered: stored !== null };
}

/** Keeps `text` for the session and, if `remember`, on this device; otherwise removes any copy there. */
export function keepProfile(text: string, remember: boolean): void {
  session = text;
  try {
    if (remember && text.trim()) storage()?.setItem(KEY, text);
    else storage()?.removeItem(KEY);
  } catch {
    /* storage unavailable: kept for the session only */
  }
}

export function forgetProfile(): void {
  session = '';
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* nothing was stored */
  }
}
