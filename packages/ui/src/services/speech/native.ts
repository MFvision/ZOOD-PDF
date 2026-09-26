/**
 * Desktop backend: the operating system's own speech engine through the host (Tauri commands
 * `speech_*`): AVSpeechSynthesizer on macOS (Premium/Enhanced voices such as Ava), the
 * Windows.Media.SpeechSynthesis voices on Windows. Text never leaves the machine.
 */
import type { SpeakHandlers, SpeakRequest, SpeechBackend, SpeechVoice } from './types';

export interface NativeSpeechEvent {
  id: number;
  kind: 'start' | 'end' | 'error';
  message?: string;
}

/** What a native host provides (`HostBridge.speech`). */
export interface NativeSpeech {
  voices(): Promise<SpeechVoice[]>;
  speak(id: number, req: { text: string; voice: string; rate: number; pitch: number }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  onEvent(cb: (e: NativeSpeechEvent) => void): () => void;
}

export function nativeSpeechBackend(native: NativeSpeech): SpeechBackend {
  let seq = 0;
  let live: { id: number; on: SpeakHandlers } | null = null;
  native.onEvent((e) => {
    if (!live || e.id !== live.id) return;
    const { on } = live;
    if (e.kind === 'start') on.start();
    else {
      live = null;
      if (e.kind === 'end') on.end();
      else on.error(e.message || 'error');
    }
  });
  const fail = (id: number, err: unknown) => {
    if (live?.id !== id) return;
    const { on } = live;
    live = null;
    on.error(err instanceof Error ? err.message : String(err));
  };
  return {
    kind: 'native',
    listVoices: () => native.voices(),
    onVoicesChanged: () => () => {},
    speak(req: SpeakRequest, on: SpeakHandlers) {
      const id = ++seq;
      live = { id, on };
      native.speak(id, { text: req.text, voice: req.voice.id, rate: req.rate, pitch: req.pitch }).catch((e: unknown) => fail(id, e));
    },
    cancel() {
      live = null;
      void native.stop().catch(() => undefined);
    },
    pause() {
      void native.pause().catch(() => undefined);
    },
    resume() {
      void native.resume().catch(() => undefined);
    },
  };
}
