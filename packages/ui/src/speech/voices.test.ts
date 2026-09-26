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
  it('lists only the system’s local voices, with their quality', () => {
    expect(installed.map((v) => v.name)).not.toContain('Google US English');
    expect(installed.find((v) => v.name.startsWith('Ava'))?.quality).toBe('premium');
    expect(installed.find((v) => v.name.startsWith('Tarik'))?.quality).toBe('enhanced');
    expect(installed.find((v) => v.name === 'Maged')?.quality).toBe('standard');
  });

  it('prefers premium, then enhanced, for each language', () => {
    expect(voicesFor(installed, 'ar').map((v) => v.name)).toEqual(['Tarik (Enhanced)', 'Maged']);
    expect(voicesFor(installed, 'en').map((v) => v.name)).toEqual(['Ava (Premium)', 'Daniel', 'Samantha']);
  });

  it('keeps the chosen voice while it is installed, else takes the best', () => {
    expect(pickVoice(installed, 'en', 'uri:Samantha')?.name).toBe('Samantha');
    expect(pickVoice(installed, 'en', 'uri:Gone')?.name).toBe('Ava (Premium)');
    expect(pickVoice(installed, 'ar', null)?.name).toBe('Tarik (Enhanced)');
    expect(pickVoice([], 'ar', null)).toBeNull();
  });
});
