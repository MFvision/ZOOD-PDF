/**
 * Web Speech backend (web app, extension, and the Linux desktop webview): `speechSynthesis`
 * restricted to on-device voices. An utterance is only spoken with an explicitly chosen
 * local voice — never with the engine's default, which may be a network voice.
 */
import { fromWebVoice, isLocalWebVoice } from './voices';
import type { SpeakHandlers, SpeakRequest, SpeechBackend, SpeechVoice } from './types';

/** How long to wait for Chrome's asynchronous voice list (`voiceschanged`). */
export const VOICE_WAIT_MS = 1500;

type SynthLike = Pick<SpeechSynthesis, 'getVoices' | 'speak' | 'cancel' | 'addEventListener' | 'removeEventListener'>;
type UtteranceCtor = new (text: string) => SpeechSynthesisUtterance;

export function webSpeechBackend(
  synth: SynthLike | undefined = typeof window !== 'undefined' ? window.speechSynthesis : undefined,
  Utterance: UtteranceCtor | undefined = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : undefined,
): SpeechBackend | null {
  if (!synth || !Utterance) return null;
  // Utterances are kept referenced until they finish (Chrome drops events of collected ones).
  const alive = new Set<SpeechSynthesisUtterance>();
  let live: SpeechSynthesisUtterance | null = null;

  const localVoices = () => {
    try {
      return synth.getVoices().filter(isLocalWebVoice);
    } catch {
      return [];
    }
  };

  return {
    kind: 'web',
    async listVoices(): Promise<SpeechVoice[]> {
      let voices = localVoices();
      if (voices.length === 0) {
        // Chrome fills the list asynchronously on first use; an empty list may just be "not yet".
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            synth.removeEventListener('voiceschanged', done);
            resolve();
          };
          const timer = setTimeout(done, VOICE_WAIT_MS);
          synth.addEventListener('voiceschanged', done);
        });
        voices = localVoices();
      }
      return voices.map(fromWebVoice);
    },
    onVoicesChanged(cb) {
      synth.addEventListener('voiceschanged', cb);
      return () => synth.removeEventListener('voiceschanged', cb);
    },
    speak(req: SpeakRequest, on: SpeakHandlers) {
      const voice = localVoices().find((v) => (v.voiceURI || v.name) === req.voice.id);
      if (!voice) {
        // Never fall back to the default voice: it may send the text to a server.
        setTimeout(() => on.error('voice-unavailable'), 0);
        return;
      }
      const u = new Utterance(req.text);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = Math.min(2, Math.max(0.5, req.rate));
      u.pitch = Math.min(2, Math.max(0.5, req.pitch));
      const finish = (fn: () => void) => {
        alive.delete(u);
        if (live !== u) return;
        live = null;
        fn();
      };
      u.onstart = () => live === u && on.start();
      u.onend = () => finish(() => on.end());
      u.onerror = (e: SpeechSynthesisErrorEvent) => finish(() => on.error(e.error || 'error'));
      alive.add(u);
      live = u;
      synth.speak(u);
    },
    cancel() {
      live = null;
      synth.cancel();
    },
  };
}
