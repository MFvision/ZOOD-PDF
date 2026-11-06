/**
 * The Android app's host (apps/android): the same web build, served from inside
 * the app, with a small bridge (`window.ZoodAndroid`, and `assets/zood/shim.js`
 * which turns downloads, sharing and printing into Android's own). The shim
 * marks the page with `__ZOOD_ANDROID__` before any of the app's scripts run.
 * A browser, the desktop app and the phone remote's page never see either.
 */

interface AndroidMark {
  version: string;
  editor: boolean;
}

interface AndroidWindow {
  __ZOOD_ANDROID__?: AndroidMark;
  __zoodOpenFiles?: (files: File[]) => void;
  ZoodAndroid?: { openRemote?: () => void };
}

const androidWindow = (): AndroidWindow | null =>
  typeof window === 'undefined' ? null : (window as unknown as AndroidWindow);

/** True in the Android app's editor, false everywhere else. */
export function isAndroidHost(): boolean {
  const mark = androidWindow()?.__ZOOD_ANDROID__;
  return !!mark && mark.editor === true;
}

/** The Android app's version ("0.1.0"), or null outside it. */
export function androidVersion(): string | null {
  return isAndroidHost() ? (androidWindow()?.__ZOOD_ANDROID__?.version ?? null) : null;
}

/**
 * Files opened with or shared to ZOOD PDF from another app (Files, Gmail,
 * WhatsApp…), as they arrive, including the one the app was started with.
 * A no-op outside the Android app.
 */
export function onAndroidFiles(handle: (files: File[]) => void): () => void {
  const target = androidWindow();
  if (!target || !isAndroidHost()) return () => undefined;
  target.__zoodOpenFiles = handle;
  // The shim waits for this before reading what came in.
  window.dispatchEvent(new Event('zood:ready'));
  return () => {
    if (target.__zoodOpenFiles === handle) delete target.__zoodOpenFiles;
  };
}

/** Opens the phone remote: the computer last used, or the code scanner. */
export function openPhoneRemote(): void {
  androidWindow()?.ZoodAndroid?.openRemote?.();
}
