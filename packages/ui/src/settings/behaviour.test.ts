import { describe, expect, it } from 'vitest';
import { chosenChips } from '../ai/chat/chips';
import { answerIn } from '../ai/chat/prompts';
import { LAYOUT_COMMANDS, declaresRightToLeft, rememberZoom, rememberedZoom } from '../embed/embedSettings';
import { partOfDay } from '../home/Greeting';
import { patternName } from '../quick/output';
import { ringToolsFor } from '../quick/plan';

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

describe('settings that change what the app does', () => {
  it('lays pages out with EmbedPDF’s own commands', () => {
    expect(LAYOUT_COMMANDS.two).toContain('spread:odd');
    expect(LAYOUT_COMMANDS.book).toContain('spread:even');
    expect(LAYOUT_COMMANDS.single).toContain('scroll:horizontal');
    expect(LAYOUT_COMMANDS.continuous).toEqual(['scroll:vertical', 'spread:none']);
  });

  it('reads a book’s right-to-left order from the file', () => {
    expect(declaresRightToLeft(bytes('<< /ViewerPreferences << /Direction /R2L >> >>'))).toBe(true);
    expect(declaresRightToLeft(bytes('<< /Direction/R2L >>'))).toBe(true);
    expect(declaresRightToLeft(bytes('<< /Direction /L2R >>'))).toBe(false);
  });

  it('remembers the zoom each file was read at', () => {
    const items = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => items.set(k, v), removeItem: (k: string) => items.delete(k) },
    });
    rememberZoom('a.pdf', { scale: 1.456, mode: 'custom' });
    rememberZoom('b.pdf', { scale: 1, mode: 'fit-page' });
    expect(rememberedZoom('a.pdf')).toBe(1.46);
    expect(rememberedZoom('b.pdf')).toBe('fit-page');
    expect(rememberedZoom('c.pdf')).toBeNull();
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('greets by the time of day', () => {
    expect(partOfDay(7)).toBe('morning');
    expect(partOfDay(13)).toBe('afternoon');
    expect(partOfDay(21)).toBe('evening');
    expect(partOfDay(2)).toBe('evening');
  });

  it('shows the chosen prompts in the chosen order', () => {
    expect(chosenChips(['quiz', 'summarize', 'email'], ['email']).map((chip) => chip.id)).toEqual(['quiz', 'summarize']);
  });

  it('answers in the chosen language', () => {
    expect(answerIn('What is this?', 'question')).toBe('Write in English.');
    expect(answerIn('ما هذا؟', 'question')).toContain('Arabic');
    expect(answerIn('What is this?', 'ar')).toContain('Arabic');
    expect(answerIn('ما هذا؟', 'en')).toBe('Write in English.');
  });

  it('puts the chosen tools on the ring, in order, of those that fit', () => {
    expect(ringToolsFor(['a.pdf'], ['rotate', 'compress']).map((tool) => tool.id)).toEqual(['rotate', 'compress']);
    expect(ringToolsFor(['a.jpg'], ['rotate', 'topdf']).map((tool) => tool.id)).toEqual(['topdf']);
    expect(ringToolsFor(['a.pdf'], []).length).toBeGreaterThan(0);
    expect(patternName('{name} ({tool})', 'a.pdf', '-x', 'pdf')).toBe('a (x).pdf');
  });
});
