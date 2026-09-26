import { describe, expect, it } from 'vitest';
import { candidateLangs, chooseVoice, fromWebVoice, groupVoices, isLocalWebVoice, primaryLang, qualityFromName, rankVoices } from './voices';
import type { SpeechVoice } from './types';

const web = (name: string, lang: string, localService: boolean, voiceURI = name) =>
  ({ name, lang, localService, voiceURI, default: false }) as SpeechSynthesisVoice;

describe('web voice filtering', () => {
  it('keeps only on-device voices and never network ones', () => {
    const all = [
      web('Maged', 'ar-SA', true),
      web('Samantha', 'en-US', true),
      web('Google العربية', 'ar-SA', false),
      web('Google US English', 'en-US', false),
      web('Microsoft Hoda Online (Natural) - Arabic (Egypt)', 'ar-EG', false),
      // A misreporting engine: name says it is a network voice, flag says local.
      web('Microsoft Aria Online (Natural) - English (United States)', 'en-US', true),
      web('Google Deutsch', 'de-DE', true),
      web('Ava (Premium)', 'en-US', true),
    ];
    expect(all.filter(isLocalWebVoice).map((v) => v.name)).toEqual(['Maged', 'Samantha', 'Ava (Premium)']);
  });

  it('reads quality from Apple voice names and normalises the tag', () => {
    expect(qualityFromName('Ava (Premium)')).toBe('premium');
    expect(qualityFromName('Majed (Enhanced)')).toBe('enhanced');
    expect(qualityFromName('Samantha')).toBe('default');
    expect(fromWebVoice(web('Zoe (Premium)', 'en_US', true, 'com.apple.voice.premium.en-US.Zoe'))).toEqual({
      id: 'com.apple.voice.premium.en-US.Zoe',
      name: 'Zoe (Premium)',
      lang: 'en-US',
      quality: 'premium',
    });
    expect(primaryLang('AR_sa')).toBe('ar');
  });
});

const v = (id: string, lang: string, quality: SpeechVoice['quality'] = 'default'): SpeechVoice => ({ id, name: id, lang, quality });

describe('ranking and choice', () => {
  const voices = [
    v('Tarik', 'ar-SA'),
    v('Laila', 'ar-EG', 'enhanced'),
    v('Daniel', 'en-GB'),
    v('Ava', 'en-US', 'premium'),
    v('Samantha', 'en-US', 'enhanced'),
    v('Hoda', 'ar-EG'),
    v('Milena', 'ru-RU'),
  ];

  it('prefers Premium, then Enhanced, then the preferred region', () => {
    expect(rankVoices(voices, 'en', 'US').map((x) => x.id)).toEqual(['Ava', 'Samantha', 'Daniel']);
    expect(rankVoices(voices, 'ar', 'SA').map((x) => x.id)).toEqual(['Laila', 'Tarik', 'Hoda']);
    expect(rankVoices([v('A', 'en-AU'), v('B', 'en-GB')], 'en', 'GB').map((x) => x.id)).toEqual(['B', 'A']);
  });

  it('uses the remembered choice per language when it is still installed', () => {
    expect(chooseVoice(voices, ['ar'], { ar: 'Hoda' })?.id).toBe('Hoda');
    expect(chooseVoice(voices, ['ar'], { ar: 'Uninstalled' })?.id).toBe('Laila');
    expect(chooseVoice(voices, ['en'], {})?.id).toBe('Ava');
    expect(chooseVoice(voices, ['he'], {})).toBeNull();
  });

  it('maps runs to candidate languages by script', () => {
    expect(candidateLangs({ lang: 'ar', script: 'Arab' })).toEqual(['ar']);
    expect(candidateLangs({ lang: 'en', script: 'Latn' })).toEqual(['en']);
    expect(candidateLangs({ lang: 'other', script: 'Cyrl' })[0]).toBe('ru');
    expect(candidateLangs({ lang: 'other', script: 'Zyyy' })).toEqual([]);
    expect(chooseVoice(voices, candidateLangs({ lang: 'other', script: 'Cyrl' }), {})?.id).toBe('Milena');
  });

  it('groups voices by language, best first', () => {
    const g = groupVoices(voices);
    expect([...g.keys()].sort()).toEqual(['ar', 'en', 'ru']);
    expect(g.get('en')?.[0]?.id).toBe('Ava');
  });
});
