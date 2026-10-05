/**
 * What this host can do to find a paragraph's font beyond the faces the app
 * carries (`fontMatch.ts`, steps B and C).
 *
 * B — fonts installed on the device — exists only in the desktop app: its
 * host reads the system's font folders (`apps/desktop/src-tauri/src/fonts.rs`)
 * and hands back one face, already checked for its licence's embedding bits
 * and for the glyphs the text needs. A browser has no such thing to ask
 * (the Local Font Access API is deliberately not used: it prompts, exists
 * in one engine only and would tell a page what the person has installed).
 */
import type { CoreClient } from '../core/client';
import { invokeHost, isTauriHost } from '../core/host-tauri';
import { canUseLibrary, fromLibrary } from './fontLibrary';
import type { FontProviders, FoundFont, OriginalFace } from './fontMatch';

async function installed(face: OriginalFace, text: string): Promise<FoundFont | null> {
  const body = (await invokeHost('font_installed', {
    family: face.family,
    weight: face.weight,
    italic: face.italic,
    text,
  })) as ArrayBuffer;
  // An empty answer: no installed face of that family can be used.
  if (!(body instanceof ArrayBuffer) || body.byteLength === 0) return null;
  const bytes = new Uint8Array(new ArrayBuffer(body.byteLength));
  bytes.set(new Uint8Array(body));
  return { name: face.family, bytes };
}

/**
 * The providers of the host the app is running in. C — the open library
 * (`fontLibrary.ts`) — is the same code in the browser and in the desktop
 * app's webview; it asks the person before its first request.
 */
export function hostFontProviders(client: CoreClient): FontProviders {
  return {
    ...(isTauriHost() ? { installed } : {}),
    ...(canUseLibrary() ? { library: (face: OriginalFace, text: string) => fromLibrary(client, face, text) } : {}),
  };
}

/** Whether Automatic can look among installed fonts here. */
export function canUseInstalledFonts(): boolean {
  return isTauriHost();
}
