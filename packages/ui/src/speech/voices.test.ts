import { describe, expect, it } from 'vitest';
import { describeVoices, pickVoice, voicesFor } from './voices';

const voice = (name: string, lang: string, localService = true) =>
  ({ voiceURI: `uri:${name}`, name, lang, localService, default: false }) as SpeechSynthesisVoice;

const installed = describeVoices([
  voice('Maged', 'ar-SA'),
  voice('Tarik (Enhanced)', 'ar-SA'),
  voice('Samantha', 'en-US'),
  voice('Ava (Premium)', 'en-US'),
  voice('Daniel', 'en-GB'),
  voice('Google US English', 'en-US', false),
]);

describe('voices', () => {
  it('keeps the robotic voices last and the home regions first', () => {
    const mac = [
      { id: 'e', name: 'Eddy (English (US))', lang: 'en-US', quality: 'standard' as const },
      { id: 'f', name: 'Fred', lang: 'en-US', quality: 'standard' as const },
      { id: 'k', name: 'Karen', lang: 'en-AU', quality: 'standard' as const },
      { id: 's', name: 'Samantha', lang: 'en-US', quality: 'standard' as const },
      { id: 'm', name: 'Majed', lang: 'ar-001', quality: 'standard' as const },
      { id: 'l', name: 'Laila', lang: 'ar-EG', quality: 'standard' as const },
    ];
    expect(voicesFor(mac, 'en').map((v) => v.name)).toEqual(['Samantha', 'Karen', 'Eddy (English (US))', 'Fred']);
    expect(pickVoice(mac, 'ar', null)?.name).toBe('Majed');
  });

  it('lists only the system’s local voices, with their quality', () => {
    expect(installed.map((v) => v.name)).not.toContain('Google US English');
    expect(installed.find((v) => v.name.startsWith('Ava'))?.quality).toBe('premium');
    expect(installed.find((v) => v.name.startsWith('Tarik'))?.quality).toBe('enhanced');
    expect(installed.find((v) => v.name === 'Maged')?.quality).toBe('standard');
  });

  it('prefers premium, then enhanced, for each language', () => {
    expect(voicesFor(installed, 'ar').map((v) => v.name)).toEqual(['Tarik (Enhanced)', 'Maged']);
    expect(voicesFor(installed, 'en').map((v) => v.name)).toEqual(['Ava (Premium)', 'Samantha', 'Daniel']);
  });

  it('keeps the chosen voice while it is installed, else takes the best', () => {
    expect(pickVoice(installed, 'en', 'uri:Samantha')?.name).toBe('Samantha');
    expect(pickVoice(installed, 'en', 'uri:Gone')?.name).toBe('Ava (Premium)');
    expect(pickVoice(installed, 'ar', null)?.name).toBe('Tarik (Enhanced)');
    expect(pickVoice([], 'ar', null)).toBeNull();
  });
});
