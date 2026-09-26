/**
 * Read aloud: picks the speech backend for this host. Desktop (macOS/Windows) uses the
 * operating system's engine through the host; everything else (web, extension, Linux
 * desktop) uses the webview's `speechSynthesis`, local voices only. When no on-device voice
 * exists the feature is unavailable and its control is not shown.
 */
import type { HostBridge } from '../host';
import { nativeSpeechBackend } from './native';
import { webSpeechBackend } from './web';
import type { SpeechBackend, SpeechVoice } from './types';

export interface SpeechSetup {
  backend: SpeechBackend;
  voices: SpeechVoice[];
}

export async function resolveSpeech(
  host: Pick<HostBridge, 'speech'>,
  web: () => SpeechBackend | null = () => webSpeechBackend(),
): Promise<SpeechSetup | null> {
  if (host.speech) {
    try {
      const backend = nativeSpeechBackend(host.speech);
      const voices = await backend.listVoices();
      if (voices.length) return { backend, voices };
    } catch {
      /* fall back to the webview's local voices */
    }
  }
  const backend = web();
  if (!backend) return null;
  const voices = await backend.listVoices();
  return voices.length ? { backend, voices } : null;
}
