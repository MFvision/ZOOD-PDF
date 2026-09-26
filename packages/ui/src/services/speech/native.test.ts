import { describe, expect, it, vi } from 'vitest';
import { nativeSpeechBackend, type NativeSpeech, type NativeSpeechEvent } from './native';

function fakeNative() {
  let emit: (e: NativeSpeechEvent) => void = () => {};
  const native: NativeSpeech & { spoken: { id: number; voice: string }[] } = {
    spoken: [],
    voices: async () => [{ id: 'com.apple.voice.premium.en-US.Ava', name: 'Ava', lang: 'en-US', quality: 'premium' }],
    speak: vi.fn(async (id: number, req: { voice: string }) => void native.spoken.push({ id, voice: req.voice })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onEvent: (cb) => {
      emit = cb;
      return () => {};
    },
  };
  return { native, emit: (e: NativeSpeechEvent) => emit(e) };
}

const AVA = { id: 'com.apple.voice.premium.en-US.Ava', name: 'Ava', lang: 'en-US', quality: 'premium' as const };

describe('native speech backend', () => {
  it('routes host events to the utterance that is speaking', async () => {
    const { native, emit } = fakeNative();
    const b = nativeSpeechBackend(native);
    expect(b.pause).toBeTypeOf('function');
    const on = { start: vi.fn(), end: vi.fn(), error: vi.fn() };
    b.speak({ text: 'Hello.', voice: AVA, rate: 1, pitch: 1 }, on);
    await Promise.resolve();
    const id = native.spoken[0]!.id;
    expect(native.spoken[0]!.voice).toBe(AVA.id);
    emit({ id: id + 99, kind: 'end' });
    expect(on.end).not.toHaveBeenCalled();
    emit({ id, kind: 'start' });
    emit({ id, kind: 'end' });
    emit({ id, kind: 'end' });
    expect(on.start).toHaveBeenCalledOnce();
    expect(on.end).toHaveBeenCalledOnce();
  });

  it('cancel stops the engine and silences the old utterance', () => {
    const { native, emit } = fakeNative();
    const b = nativeSpeechBackend(native);
    const on = { start: vi.fn(), end: vi.fn(), error: vi.fn() };
    b.speak({ text: 'Hello.', voice: AVA, rate: 1, pitch: 1 }, on);
    b.cancel();
    emit({ id: 1, kind: 'end' });
    expect(native.stop).toHaveBeenCalled();
    expect(on.end).not.toHaveBeenCalled();
  });

  it('a rejected speak command becomes an utterance error', async () => {
    const { native } = fakeNative();
    native.speak = vi.fn(async () => {
      throw new Error('voice not installed');
    });
    const b = nativeSpeechBackend(native);
    const on = { start: vi.fn(), end: vi.fn(), error: vi.fn() };
    b.speak({ text: 'x', voice: AVA, rate: 1, pitch: 1 }, on);
    await new Promise((r) => setTimeout(r, 0));
    expect(on.error).toHaveBeenCalledWith('voice not installed');
  });
});
